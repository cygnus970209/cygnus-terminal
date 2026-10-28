import { describe, expect, it } from "vitest";
import { connectionEntries, readConnectionFavorites } from "./connection";
import type { Profile } from "./profile";
import { DEFAULT_RDP_CONFIG } from "./rdp";
import { DEFAULT_WINRM_CONFIG } from "./winrm";

const ssh = { id: 1, name: "SSH", host: "host.test", username: "ubuntu", port: 22, auth_type: "key", group_name: "Production" } as Profile;
describe("unified connection library", () => {
  it("keeps WinRM IDs, search, groups and favorites independent from SSH and RDP", () => {
    const entries = connectionEntries([ssh], [{ id: 1, name: "Desktop", config: DEFAULT_RDP_CONFIG }], [{
      id: 1, name: "Management", group_name: "Lab", has_password: true,
      config: { ...DEFAULT_WINRM_CONFIG, host: "::1", username: "admin", domain: "CORP", certificate_pin: "secret-pin" },
    }]);
    expect(entries.map(entry => entry.key)).toEqual([1, "rdp:1", "winrm:1"]);
    expect(entries[2].endpoint).toBe("CORP\\admin@[::1]:5986");
    expect(entries[2].group).toBe("Lab");
    expect(entries[2].search).toContain("winrm windows powershell");
    expect(entries[2].search).not.toContain("secret-pin");
    expect(readConnectionFavorites('[1,"rdp:1","winrm:1","winrm:0","winrm:x"]')).toEqual([1, "rdp:1", "winrm:1"]);
  });
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
