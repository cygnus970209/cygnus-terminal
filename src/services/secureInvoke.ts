import { invoke as nativeInvoke, type InvokeArgs } from "@tauri-apps/api/core";

const EXPLAINED_KEY = "cygnus.keychain-explained.v1";
type KeychainSource = "cygnus" | "termius";
type Notice = { source: KeychainSource; denied: boolean };
let notice: Notice | null = null;
const listeners = new Set<() => void>();
let resolveChoice: ((accepted: boolean) => void) | null = null;
let pending: Promise<void> | null = null;
let accessQueue: Promise<void> = Promise.resolve();
const deniedSources = new Set<KeychainSource>();

export const keychainNotice = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => notice !== null,
  getDetailsSnapshot: () => notice,
  respond(accepted: boolean) {
    const resolve = resolveChoice;
    resolveChoice = null;
    notice = null;
    listeners.forEach((listener) => listener());
    resolve?.(accepted);
  },
};

function explanationKey(source: KeychainSource) {
  return source === "cygnus"
    ? EXPLAINED_KEY
    : "cygnus.termius-keychain-explained.v1";
}

function accessFailed(error: unknown) {
  // Match the backend's credential-store errors, not wrong SSH passwords,
  // missing keys, invalid ciphertext, database failures or file permissions.
  return (
    /^(?:Error: )?(?:Termius )?Keychain access (?:failed|denied|was denied)/i.test(String(error)) ||
    /^(?:Error: )?Failed to store master key in keychain:/i.test(String(error))
  );
}

function withKeychainAccess<T>(
  source: KeychainSource,
  operation: () => Promise<T>,
) {
  // Serialize prompts from different sources so one dialog cannot overwrite
  // another's resolver. Cygnus unlocks additionally share `pending` below.
  const result = accessQueue.then(async () => {
    const key = explanationKey(source);
    let explained = false;
    let denied = deniedSources.has(source);
    let lastError: unknown;
    try {
      explained = localStorage.getItem(key) === "true";
    } catch {
      /* Explain again when storage is unavailable. */
    }
    while (true) {
      if (!explained || denied) {
        const accepted = await new Promise<boolean>((resolve) => {
          resolveChoice = resolve;
          notice = { source, denied };
          listeners.forEach((listener) => listener());
        });
        if (!accepted) {
          if (lastError !== undefined) throw lastError;
          throw new Error(
            "Credential access cancelled. Your saved data is unchanged.",
          );
        }
      }
      try {
        const value = await operation();
        deniedSources.delete(source);
        try {
          localStorage.setItem(key, "true");
        } catch {
          /* Successful access does not depend on browser storage. */
        }
        return value;
      } catch (error) {
        if (!accessFailed(error)) throw error;
        denied = true;
        deniedSources.add(source);
        lastError = error;
        try {
          localStorage.removeItem(key);
        } catch {
          /* The in-memory denial still forces the next explanation. */
        }
        // Reopen the app's explanation. Only another explicit Continue may
        // issue a new OS request; denial never automatically retries a write.
      }
    }
  });
  accessQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function authorize() {
  if (!pending) {
    pending = withKeychainAccess("cygnus", () =>
      nativeInvoke<void>("authorize_keychain_access"),
    ).finally(() => {
      pending = null;
    });
  }
  return pending;
}

/** The backend signals before touching the keychain or mutating secret data.
 * Retry once after consent; concurrent requests share one explanation and unlock.
 */
export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
): Promise<T> {
  if (args && (
    (command === "preview_migration" && "kind" in args && args.kind === "termius") ||
    (command === "import_migration" && "selection" in args &&
      typeof args.selection === "object" && args.selection !== null &&
      "kind" in args.selection && args.selection.kind === "termius")
  )) {
    return withKeychainAccess("termius", () => nativeInvoke<T>(command, args));
  }
  try {
    return await nativeInvoke<T>(command, args);
  } catch (error) {
    if (error !== "KEYCHAIN_CONSENT_REQUIRED") throw error;
    await authorize();
    return nativeInvoke<T>(command, args);
  }
}
