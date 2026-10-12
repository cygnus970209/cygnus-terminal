export type McpClient = "codex" | "claude" | "cursor" | "kiro";
export type McpPlatform = "windows" | "macos" | "linux";

export const MCP_CLIENTS: { id: McpClient; label: string }[] = [
  { id: "codex", label: "Codex CLI" },
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "kiro", label: "Kiro IDE" },
];

export function detectMcpPlatform(platform: string, userAgent: string): McpPlatform {
  // Prefer the native platform; use the user agent only when it is unavailable.
  const value = platform || userAgent;
  if (/Win/i.test(value)) return "windows";
  if (/Mac/i.test(value)) return "macos";
  return "linux";
}

export function mcpPlatformLabel(platform: McpPlatform): string {
  if (platform === "windows") return "Windows · PowerShell";
  if (platform === "macos") return "macOS · zsh / bash";
  return "Linux · bash";
}

function quoteShell(value: string, platform: McpPlatform): string {
  return `'${value.replace(/'/g, platform === "windows" ? "''" : "'\"'\"'")}'`;
}

export function mcpClientConfigPath(client: "cursor" | "kiro", platform: McpPlatform): string {
  const parts = client === "cursor" ? [".cursor", "mcp.json"] : [".kiro", "settings", "mcp.json"];
  return platform === "windows" ? `%USERPROFILE%\\${parts.join("\\")}` : `~/${parts.join("/")}`;
}

/** Pure formatting only: never executes a CLI or writes another client's config. */
export function buildMcpClientSetup(client: McpClient, platform: McpPlatform, endpoint: string, token: string): string {
  if (client === "cursor" || client === "kiro") {
    return JSON.stringify({
      mcpServers: {
        cygnus: {
          url: endpoint,
          headers: { Authorization: `Bearer ${token}` },
          ...(client === "kiro" ? { autoApprove: [] } : {}),
        },
      },
    }, null, 2);
  }

  const environment = platform === "windows"
    ? `$env:CYGNUS_MCP_TOKEN = ${quoteShell(token, platform)}`
    : `export CYGNUS_MCP_TOKEN=${quoteShell(token, platform)}`;
  const url = quoteShell(endpoint, platform);
  const claudeHeader = quoteShell("Authorization: Bearer ${CYGNUS_MCP_TOKEN}", platform);
  const registration = client === "codex"
    ? `codex mcp add cygnus --url ${url} --bearer-token-env-var CYGNUS_MCP_TOKEN`
    // Keep the reference literal in the shell so Claude resolves it at startup.
    : `claude mcp add --transport http --scope user cygnus ${url} --header ${claudeHeader}`;
  return `${environment}\n${registration}`;
}
