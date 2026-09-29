import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVaultPromptRules } from "./useVaultPromptRules";

const legacy = { id: "seed-password", pattern: "[Pp]assword:\\s*$", label: "Password", enabled: true };
const gitPrompt = "Password for 'https://cygnus970209@github.com': ";

function load(raw: unknown = null) {
  vi.stubGlobal("localStorage", { getItem: () => raw === null ? null : JSON.stringify(raw) });
  return loadVaultPromptRules();
}
afterEach(() => vi.unstubAllGlobals());

describe("vault password prompts", () => {
  it("recognizes Git HTTPS prompts alongside sudo, SSH and plain passwords", () => {
    const rules = load().filter(r => r.enabled);
    for (const line of [gitPrompt, "[sudo] password for ubuntu: ", "Password:", "alice@host's password:"]) {
      expect(rules.some(r => new RegExp(r.pattern).test(line)), line).toBe(true);
    }
    for (const line of ["Username for 'https://github.com': ", "Password for 'https://github.com': failed", "fatal: Authentication failed", "Password policy:"]) {
      expect(rules.some(r => new RegExp(r.pattern).test(line)), line).toBe(false);
    }
  });
  it("upgrades the saved default rule for existing installs", () => {
    const [rule] = load([legacy]);
    expect(new RegExp(rule.pattern).test(gitPrompt)).toBe(true);
    expect(rule.label).toBe(legacy.label);
  });
  it("preserves disabled, deleted and customized rules", () => {
    expect(load([{ ...legacy, enabled: false }])[0].enabled).toBe(false);
    expect(load([])).toEqual([]);
    const custom = { ...legacy, pattern: "^Custom secret:$" };
    const user = { ...legacy, id: "user-rule" };
    expect(load([custom, user])).toEqual([custom, user]);
  });
});
