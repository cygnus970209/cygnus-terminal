import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(nativeInvoke);
let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  native.mockReset();
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("credential access explanation", () => {
  it("does not touch the keychain before Continue and retries only after unlock", async () => {
    native
      .mockRejectedValueOnce("KEYCHAIN_CONSENT_REQUIRED")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("result");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("get_profile", { id: 1 });
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    expect(native).toHaveBeenCalledTimes(1);
    keychainNotice.respond(true);
    await expect(result).resolves.toBe("result");
    expect(native.mock.calls.map((c) => c[0])).toEqual([
      "get_profile",
      "authorize_keychain_access",
      "get_profile",
    ]);
    expect(storage.get("cygnus.keychain-explained.v1")).toBe("true");
  });
  it("cancel never unlocks or retries the pending operation", async () => {
    native.mockRejectedValue("KEYCHAIN_CONSENT_REQUIRED");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("vault_create");
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    keychainNotice.respond(false);
    await rejected;
    expect(native).toHaveBeenCalledTimes(1);
    expect(storage.size).toBe(0);
  });
  it("concurrent requests share one notice and one unlock", async () => {
    let unlocked = false;
    native.mockImplementation(async (command) => {
      if (command === "authorize_keychain_access") {
        unlocked = true;
        return;
      }
      if (!unlocked) throw "KEYCHAIN_CONSENT_REQUIRED";
      return "ok";
    });
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const results = Promise.all([
      invoke("get_profile"),
      invoke("vault_inject"),
    ]);
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    keychainNotice.respond(true);
    expect(await results).toEqual(["ok", "ok"]);
    expect(
      native.mock.calls.filter((c) => c[0] === "authorize_keychain_access"),
    ).toHaveLength(1);
  });
  it("remembered explanation skips the notice, not OS authorization", async () => {
    storage.set("cygnus.keychain-explained.v1", "true");
    native
      .mockRejectedValueOnce("KEYCHAIN_CONSENT_REQUIRED")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("ok");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    expect(await invoke("get_profile")).toBe("ok");
    expect(keychainNotice.getSnapshot()).toBe(false);
    expect(native).toHaveBeenCalledWith("authorize_keychain_access");
  });
  it("OS denial shows the notice again without automatically retrying access", async () => {
    native
      .mockRejectedValueOnce("KEYCHAIN_CONSENT_REQUIRED")
      .mockRejectedValueOnce("Keychain access denied");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("vault_create");
    const rejected = expect(result).rejects.toBe("Keychain access denied");
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    keychainNotice.respond(true);
    await vi.waitFor(() => {
      expect(native).toHaveBeenCalledTimes(2);
      expect(keychainNotice.getSnapshot()).toBe(true);
    });
    keychainNotice.respond(false);
    await rejected;
    expect(native).toHaveBeenCalledTimes(2);
    expect(storage.size).toBe(0);
  });
  it("denial invalidates a remembered explanation and Continue retries access", async () => {
    storage.set("cygnus.keychain-explained.v1", "true");
    native
      .mockRejectedValueOnce("KEYCHAIN_CONSENT_REQUIRED")
      .mockRejectedValueOnce("Keychain access failed: access denied")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("ok");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("get_profile");
    // Observe rejection on the old implementation while checking recovery UI.
    void result.catch(() => {});
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    expect(storage.has("cygnus.keychain-explained.v1")).toBe(false);
    expect(native).toHaveBeenCalledTimes(2);
    keychainNotice.respond(true);
    await expect(result).resolves.toBe("ok");
    expect(native.mock.calls.map((c) => c[0])).toEqual([
      "get_profile", "authorize_keychain_access", "authorize_keychain_access", "get_profile",
    ]);
  });
  it("ordinary operations and unrelated errors never request credential access", async () => {
    native
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce("Database unavailable");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    await expect(invoke("list_profiles")).resolves.toEqual([]);
    await expect(invoke("list_profiles")).rejects.toBe("Database unavailable");
    expect(keychainNotice.getSnapshot()).toBe(false);
    expect(native).toHaveBeenCalledTimes(2);
  });
  it("each repeated OS denial reopens recovery and cancellation leaves the next attempt explained", async () => {
    storage.set("cygnus.keychain-explained.v1", "true");
    native.mockImplementation(async (command) => {
      if (command === "authorize_keychain_access") throw "Keychain access failed: denied";
      throw "KEYCHAIN_CONSENT_REQUIRED";
    });
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("get_profile");
    const rejected = expect(result).rejects.toBe("Keychain access failed: denied");
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()?.denied).toBe(true));
    const firstNotice = keychainNotice.getDetailsSnapshot();
    keychainNotice.respond(true);
    await vi.waitFor(() => {
      expect(native).toHaveBeenCalledTimes(3);
      expect(keychainNotice.getDetailsSnapshot()?.denied).toBe(true);
    });
    expect(keychainNotice.getDetailsSnapshot()).not.toBe(firstNotice);
    keychainNotice.respond(false);
    await rejected;
    const next = invoke("get_profile");
    const cancelled = expect(next).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    expect(native).toHaveBeenCalledTimes(4); // no second OS request yet
    keychainNotice.respond(false);
    await cancelled;
  });
  it("Termius uses its own explanation and retries the same preview only after confirmation", async () => {
    storage.set("cygnus.keychain-explained.v1", "true");
    native
      .mockRejectedValueOnce("Termius Keychain access was denied or is unavailable. Allow access and preview again.")
      .mockResolvedValueOnce({ candidates: [] });
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const args = { kind: "termius", path: "/synthetic/Termius" };
    const result = invoke("preview_migration", args);
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()).toEqual({ source: "termius", denied: false }));
    expect(native).not.toHaveBeenCalled();
    keychainNotice.respond(true);
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()).toEqual({ source: "termius", denied: true }));
    expect(native).toHaveBeenCalledTimes(1);
    keychainNotice.respond(true);
    await expect(result).resolves.toEqual({ candidates: [] });
    expect(native.mock.calls).toEqual([["preview_migration", args], ["preview_migration", args]]);
    expect(storage.get("cygnus.termius-keychain-explained.v1")).toBe("true");
    expect(storage.get("cygnus.keychain-explained.v1")).toBe("true");
  });
  it("Termius import denial resets its remembered notice and never retries the write on Cancel", async () => {
    storage.set("cygnus.termius-keychain-explained.v1", "true");
    const denial = "Termius Keychain access was denied or is unavailable.";
    native.mockRejectedValue(denial);
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("import_migration", { selection: { kind: "termius", indices: [0] } });
    const rejected = expect(result).rejects.toBe(denial);
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()).toEqual({ source: "termius", denied: true }));
    expect(storage.has("cygnus.termius-keychain-explained.v1")).toBe(false);
    keychainNotice.respond(false);
    await rejected;
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("concurrent Cygnus and Termius requests cannot replace each other's dialog", async () => {
    let unlocked = false;
    native.mockImplementation(async (command) => {
      if (command === "preview_migration") return "preview";
      if (command === "authorize_keychain_access") { unlocked = true; return; }
      if (!unlocked) throw "KEYCHAIN_CONSENT_REQUIRED";
      return "profile";
    });
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const profile = invoke("get_profile");
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()?.source).toBe("cygnus"));
    const termius = invoke("preview_migration", { kind: "termius" });
    await Promise.resolve();
    expect(keychainNotice.getDetailsSnapshot()?.source).toBe("cygnus");
    keychainNotice.respond(true);
    await expect(profile).resolves.toBe("profile");
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()?.source).toBe("termius"));
    keychainNotice.respond(true);
    await expect(termius).resolves.toBe("preview");
  });
  it("storage failure cannot suppress a denial notice and unrelated Termius errors do not retry", async () => {
    storage.set("cygnus.keychain-explained.v1", "true");
    vi.stubGlobal("localStorage", {
      getItem: () => "true",
      removeItem: () => { throw new Error("Storage unavailable"); },
    });
    native.mockRejectedValueOnce("KEYCHAIN_CONSENT_REQUIRED")
      .mockRejectedValueOnce("Keychain access failed: denied")
      .mockRejectedValueOnce("Cannot decrypt Termius data with this Mac's local key");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("get_profile");
    const rejected = expect(result).rejects.toBe("Keychain access failed: denied");
    await vi.waitFor(() => expect(keychainNotice.getDetailsSnapshot()?.denied).toBe(true));
    keychainNotice.respond(false);
    await rejected;
    await expect(invoke("preview_migration", { kind: "termius" })).rejects.toContain("Cannot decrypt");
    expect(keychainNotice.getSnapshot()).toBe(false);
    expect(native).toHaveBeenCalledTimes(3);
  });
});
