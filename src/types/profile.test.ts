import { describe, expect, it } from "vitest";
import { profileEnvironmentLabel } from "./profile";

describe("saved server environment", () => {
  it("does not label unspecified or legacy profiles as detected Linux servers", () => {
    expect(profileEnvironmentLabel({})).toBe("");
    expect(profileEnvironmentLabel({ target_os: "auto", remote_shell: "auto" })).toBe("");
  });

  it("shows independent OS and shell hints, including partial metadata", () => {
    expect(profileEnvironmentLabel({ target_os: "windows" })).toBe("Windows");
    expect(profileEnvironmentLabel({ remote_shell: "cmd" })).toBe("CMD");
    expect(profileEnvironmentLabel({ target_os: "linux", remote_shell: "pwsh" }))
      .toBe("Linux · PowerShell 7+");
    expect(profileEnvironmentLabel({ target_os: "windows", remote_shell: "powershell" }))
      .toBe("Windows · Windows PowerShell");
  });
});
