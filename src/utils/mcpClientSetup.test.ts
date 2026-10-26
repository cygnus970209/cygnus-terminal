import { describe, expect, test } from "vitest";
import { buildMcpClientSetup, buildMcpOAuthSetup, detectMcpPlatform, mcpClientConfigPath } from "./mcpClientSetup";

const endpoint = "http://127.0.0.1:43127/mcp";

describe("MCP client registration", () => {
  test.each(["codex", "claude", "cursor", "kiro"] as const)("%s OAuth registration has no manual authentication header", (client) => {
    for (const platform of ["windows", "macos", "linux"] as const) {
      const setup = buildMcpOAuthSetup(client, platform, endpoint);
      expect(setup).toContain(endpoint);
      expect(setup).not.toMatch(/Authorization|Bearer|TOKEN|bearer.token|\$\{/);
      if (client === "cursor" || client === "kiro") {
        const config = JSON.parse(setup).mcpServers.cygnus;
        expect(config.headers).toBeUndefined();
        expect(config.autoApprove ?? []).toEqual([]);
      }
    }
  });
  test("detects native Windows and macOS and falls back to the user agent", () => {
    expect(detectMcpPlatform("Win32", "Macintosh")).toBe("windows");
    expect(detectMcpPlatform("MacIntel", "Windows NT")).toBe("macos");
    expect(detectMcpPlatform("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectMcpPlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("macos");
    expect(detectMcpPlatform("Linux x86_64", "")).toBe("linux");
  });

  test("uses each client's user-level config path on each OS", () => {
    expect(mcpClientConfigPath("codex", "windows")).toBe("%USERPROFILE%\\.codex\\config.toml");
    expect(mcpClientConfigPath("codex", "macos")).toBe("~/.codex/config.toml");
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

  test("Claude passes the actual token as a literal PowerShell argument", () => {
    const command = buildMcpClientSetup("claude", "windows", endpoint, "synthetic'$(not-executed)`token");
    expect(command).toBe(`claude mcp add --transport http --scope user cygnus '${endpoint}' --header 'Authorization: Bearer synthetic''$(not-executed)\`token'`);
    expect(command).not.toContain("export ");
    expect(command).not.toContain("$env:");
  });

  test.each(["windows", "macos", "linux"] as const)("Codex uses a static Authorization header in TOML on %s", (platform) => {
    expect(buildMcpClientSetup("codex", platform, endpoint, "synthetic-current-token")).toBe(
      `[mcp_servers.cygnus]\nurl = "${endpoint}"\nhttp_headers = { Authorization = "Bearer synthetic-current-token" }`,
    );
  });

  test("Codex escapes quotes, slashes, newlines and control characters within TOML strings", () => {
    const setup = buildMcpClientSetup("codex", "macos", `${endpoint}?q="quoted"`, 'synthetic"\\\n\t\u0000\u007f');
    expect(setup.split("\n")).toEqual([
      "[mcp_servers.cygnus]",
      `url = "${endpoint}?q=\\"quoted\\""`,
      'http_headers = { Authorization = "Bearer synthetic\\"\\\\\\n\\t\\u0000\\u007f" }',
    ]);
  });

  test.each(["codex", "claude", "cursor", "kiro"] as const)("%s copies updated credentials without environment references", (client) => {
    const first = buildMcpClientSetup(client, "macos", endpoint, "synthetic-first-token");
    const updated = buildMcpClientSetup(client, "macos", "http://127.0.0.1:43128/mcp", "synthetic-next-token");
    expect(first).toContain("synthetic-first-token");
    expect(updated).toContain("synthetic-next-token");
    expect(updated).toContain("http://127.0.0.1:43128/mcp");
    expect(updated).not.toContain("synthetic-first-token");
    expect(updated).not.toContain(endpoint);
    expect(updated).not.toMatch(/CYGNUS_MCP_TOKEN|bearer_token_env_var|bearer-token-env-var|\$\{/);
  });

});
