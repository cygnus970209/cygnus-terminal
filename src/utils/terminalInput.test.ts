import { describe, expect, test } from "vitest";
import { normalizeTerminalInput } from "./terminalInput";

describe("normalizeTerminalInput", () => {
  test("converts the NBSP from the reported failing command to ASCII space", () => {
    const input = new TextDecoder().decode(
      new Uint8Array([0x73, 0x75, 0x64, 0x6f, 0xc2, 0xa0, 0x73, 0x75]),
    );
    expect(normalizeTerminalInput(input)).toBe("sudo su");
    expect(normalizeTerminalInput("\u00a0")).toBe(" ");
  });

  test("converts every NBSP in multiline bracketed paste without changing delimiters", () => {
    expect(normalizeTerminalInput("\x1b[200~cd\u00a0/var\r\nls\u00a0-la\x1b[201~"))
      .toBe("\x1b[200~cd /var\r\nls -la\x1b[201~");
  });

  test("preserves other Unicode, whitespace, and terminal control sequences", () => {
    const input = "한글🙂 e\u0301\u202f\u3000\t \r\n\x03\x7f\x1b[A";
    expect(normalizeTerminalInput(input)).toBe(input);
    expect(normalizeTerminalInput("")).toBe("");
  });
});
