import { describe, expect, it } from "vitest";
import { connectionEntries, readConnectionFavorites } from "./connection";
import type { Profile } from "./profile";
import { DEFAULT_RDP_CONFIG } from "./rdp";

const ssh = { id: 1, name: "SSH", host: "host.test", username: "ubuntu", port: 22, auth_type: "key", group_name: "Production" } as Profile;
describe("unified connection library", () => {
  it("keeps RDP and terminal profile IDs separate", () => {
    const entries = connectionEntries([ssh], [{ id: 1, name: "Desktop", config: { ...DEFAULT_RDP_CONFIG, host: "desktop.test", username: "admin" } }]);
    expect(entries.map((e) => e.key)).toEqual([1, "rdp:1"]);
    expect(entries.map((e) => e.kind)).toEqual(["terminal", "rdp"]);
    expect(entries[0].protocol).toBe("ssh");
    expect(entries[1].search).toContain("rdp windows");
  });
  it("preserves existing numeric favorites and validates new RDP keys", () => {
    expect(readConnectionFavorites('[1,2,"rdp:1","ssh:2",null,-1,{},"rdp:no"]')).toEqual([1, 2, "rdp:1"]);
    expect(readConnectionFavorites("broken")).toEqual([]);
    expect(readConnectionFavorites('{}')).toEqual([]);
  });
  it("keeps domain and IPv6 endpoints legible without copying credentials into searchable text", () => {
    const entries = connectionEntries([{ ...ssh, password: "SECRET", jump_host: "PRIVATE" }], [{ id: 2, name: "Desktop", config: { ...DEFAULT_RDP_CONFIG, host: "::1", username: "admin", domain: "CORP" } }]);
    expect(entries[1].endpoint).toBe("CORP\\admin@[::1]:3389");
    expect(entries[0].search).not.toMatch(/SECRET|PRIVATE/);
  });
});
