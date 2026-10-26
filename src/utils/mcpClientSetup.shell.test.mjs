import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { buildMcpClientSetup } from "./mcpClientSetup";

const endpoint = "http://127.0.0.1:43127/mcp";

describe("MCP registration shell parsing", () => {
  test.skipIf(process.platform === "win32")("Claude POSIX command passes the actual token without shell expansion", () => {
    const token = "synthetic'$(printf INJECTED)`printf INJECTED`\nend";
    const commands = buildMcpClientSetup("claude", "macos", endpoint, token);
    // Exercise shell parsing without changing any real client config.
    const stub = `claude() { printf '%s\\0' "$@"; }\n`;
    const output = execFileSync("/bin/sh", ["-c", stub + commands], { encoding: "utf8" }).split("\0");
    expect(output).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "cygnus", endpoint, "--header", `Authorization: Bearer ${token}`, ""]);
  });
});
