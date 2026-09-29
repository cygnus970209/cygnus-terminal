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
  it("OS denial does not retry the original operation or persist first consent", async () => {
    native
      .mockRejectedValueOnce("KEYCHAIN_CONSENT_REQUIRED")
      .mockRejectedValueOnce("Keychain access denied");
    const { invoke, keychainNotice } = await import("./secureInvoke");
    const result = invoke("vault_create");
    const rejected = expect(result).rejects.toBe("Keychain access denied");
    await vi.waitFor(() => expect(keychainNotice.getSnapshot()).toBe(true));
    keychainNotice.respond(true);
    await rejected;
    expect(native).toHaveBeenCalledTimes(2);
    expect(storage.size).toBe(0);
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
});
