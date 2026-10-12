import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { buildMcpClientSetup } from "./mcpClientSetup";

const endpoint = "http://127.0.0.1:43127/mcp";

describe("MCP registration shell parsing", () => {
  test.skipIf(process.platform === "win32").each(["codex", "claude"])("%s POSIX commands pass exact arguments without shell expansion", (client) => {
    const token = "synthetic'$(printf INJECTED)`printf INJECTED`\nend";
    const commands = buildMcpClientSetup(client, "macos", endpoint, token);
    // Stub both CLIs: exercise shell parsing without changing any real client config.
    const stub = `${client}() { printf '%s\\0' "$CYGNUS_MCP_TOKEN" "$@"; }\n`;
    const output = execFileSync("/bin/sh", ["-c", stub + commands], { encoding: "utf8" }).split("\0");
    expect(output.shift()).toBe(token);
    expect(output).toContain(endpoint);
    expect(output).toContain("cygnus");
    if (client === "codex") {
      expect(output).toContain("--bearer-token-env-var");
      expect(output).toContain("CYGNUS_MCP_TOKEN");
    } else {
      expect(output).toContain("Authorization: Bearer ${CYGNUS_MCP_TOKEN}");
      expect(output).toContain("user");
    }
  });
});
