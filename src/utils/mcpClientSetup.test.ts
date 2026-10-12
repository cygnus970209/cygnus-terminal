import { describe, expect, test } from "vitest";
import { buildMcpClientSetup, detectMcpPlatform, mcpClientConfigPath } from "./mcpClientSetup";

const endpoint = "http://127.0.0.1:43127/mcp";

describe("MCP client registration", () => {
  test("detects native Windows and macOS and falls back to the user agent", () => {
    expect(detectMcpPlatform("Win32", "Macintosh")).toBe("windows");
    expect(detectMcpPlatform("MacIntel", "Windows NT")).toBe("macos");
    expect(detectMcpPlatform("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectMcpPlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("macos");
    expect(detectMcpPlatform("Linux x86_64", "")).toBe("linux");
  });

  test("uses each IDE's user-level config path on each OS", () => {
    expect(mcpClientConfigPath("cursor", "windows")).toBe("%USERPROFILE%\\.cursor\\mcp.json");
    expect(mcpClientConfigPath("kiro", "windows")).toBe("%USERPROFILE%\\.kiro\\settings\\mcp.json");
    expect(mcpClientConfigPath("cursor", "macos")).toBe("~/.cursor/mcp.json");
    expect(mcpClientConfigPath("kiro", "macos")).toBe("~/.kiro/settings/mcp.json");
  });

  test.each(["cursor", "kiro"] as const)("%s JSON preserves the current URL and token without auto-approving tools", (client) => {
    const token = 'synthetic-"token\\with\ncharacters';
    const config = JSON.parse(buildMcpClientSetup(client, "windows", endpoint, token));
    expect(Object.keys(config.mcpServers)).toEqual(["cygnus"]);
    expect(config.mcpServers.cygnus.url).toBe(endpoint);
    expect(config.mcpServers.cygnus.headers.Authorization).toBe(`Bearer ${token}`);
    expect(config.mcpServers.cygnus.autoApprove ?? []).toEqual([]);
    expect(config.mcpServers.cygnus.command).toBeUndefined();
  });

  test.each(["codex", "claude"] as const)("%s uses PowerShell assignment and literal header references on Windows", (client) => {
    const command = buildMcpClientSetup(client, "windows", endpoint, "synthetic'$(not-executed)`token");
    expect(command.split("\n")[0]).toBe("$env:CYGNUS_MCP_TOKEN = 'synthetic''$(not-executed)`token'");
    expect(command).not.toContain("export ");
    expect(command).toContain(`'${endpoint}'`);
    if (client === "codex") expect(command).toContain("--bearer-token-env-var CYGNUS_MCP_TOKEN");
    else expect(command).toContain("--header 'Authorization: Bearer ${CYGNUS_MCP_TOKEN}'");
  });

});
