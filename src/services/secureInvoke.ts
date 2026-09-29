import { invoke as nativeInvoke, type InvokeArgs } from "@tauri-apps/api/core";

const EXPLAINED_KEY = "cygnus.keychain-explained.v1";
let visible = false;
const listeners = new Set<() => void>();
let resolveChoice: ((accepted: boolean) => void) | null = null;
let pending: Promise<void> | null = null;

export const keychainNotice = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => visible,
  respond(accepted: boolean) {
    const resolve = resolveChoice;
    resolveChoice = null;
    visible = false;
    listeners.forEach((listener) => listener());
    resolve?.(accepted);
  },
};

async function authorize() {
  if (!pending) {
    pending = (async () => {
      let explained = false;
      try {
        explained = localStorage.getItem(EXPLAINED_KEY) === "true";
      } catch {
        /* Explain again when storage is unavailable. */
      }
      if (!explained) {
        const accepted = await new Promise<boolean>((resolve) => {
          resolveChoice = resolve;
          visible = true;
          listeners.forEach((listener) => listener());
        });
        if (!accepted)
          throw new Error(
            "Credential access cancelled. Your saved data is unchanged.",
          );
      }
      await nativeInvoke("authorize_keychain_access");
      try {
        localStorage.setItem(EXPLAINED_KEY, "true");
      } catch {
        /* Authorization still works this session. */
      }
    })().finally(() => {
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
  try {
    return await nativeInvoke<T>(command, args);
  } catch (error) {
    if (error !== "KEYCHAIN_CONSENT_REQUIRED") throw error;
    await authorize();
    return nativeInvoke<T>(command, args);
  }
}
