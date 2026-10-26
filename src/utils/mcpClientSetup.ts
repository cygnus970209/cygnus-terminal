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

export function mcpClientConfigPath(client: Exclude<McpClient, "claude">, platform: McpPlatform): string {
  const parts = client === "codex" ? [".codex", "config.toml"]
    : client === "cursor" ? [".cursor", "mcp.json"] : [".kiro", "settings", "mcp.json"];
  return platform === "windows" ? `%USERPROFILE%\\${parts.join("\\")}` : `~/${parts.join("/")}`;
}

function quoteToml(value: string): string {
  // JSON string escapes also work in TOML basic strings; DEL must be escaped too.
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

/** OAuth client configuration contains no credential. The app approves each connection. */
export function buildMcpOAuthSetup(client: McpClient, platform: McpPlatform, endpoint: string): string {
  if (client === "codex") return `codex mcp add cygnus --url ${quoteShell(endpoint, platform)}`;
  if (client === "claude") return `claude mcp add --transport http --scope user cygnus ${quoteShell(endpoint, platform)}`;
  return JSON.stringify({ mcpServers: { cygnus: { url: endpoint,
    ...(client === "cursor" ? { auth: { CLIENT_ID: "cygnus-cursor-desktop" } } : {}),
    ...(client === "kiro" ? { autoApprove: [], oauthScopes: ["cygnus"] } : {}),
  } } }, null, 2);
}

/** Pure formatting only: never executes a CLI or writes another client's config. */
export function buildMcpClientSetup(client: McpClient, platform: McpPlatform, endpoint: string, token: string): string {
  if (client === "codex") {
    // The CLI's add command only supports env-based bearer tokens. Static headers
    // belong in config.toml so the client also works outside the registering shell.
    return `[mcp_servers.cygnus]\nurl = ${quoteToml(endpoint)}\nhttp_headers = { Authorization = ${quoteToml(`Bearer ${token}`)} }`;
  }

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

  const url = quoteShell(endpoint, platform);
  const header = quoteShell(`Authorization: Bearer ${token}`, platform);
  return `claude mcp add --transport http --scope user cygnus ${url} --header ${header}`;
}
