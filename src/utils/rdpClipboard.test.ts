import { describe, expect, it } from "vitest";
import { validRdpClipboardText } from "./rdpClipboard";
describe("RDP clipboard text boundary", () => {
  it("allows bounded Unicode, line breaks and tabs", () => {
    for (const text of ["한글🙂\r\ntext\tvalue", "a".repeat(2048), "🙂".repeat(1024)]) expect(validRdpClipboardText(text)).toBe(true);
  });
  it("rejects controls, malformed UTF-16 and oversized content without truncation", () => {
    for (const text of ["", "a".repeat(2049), "🙂".repeat(1025), "a\0b", "\u001b[1m", "\u007f", "\u0085", "\ud800", "\udc00", "\ud800x"]) expect(validRdpClipboardText(text)).toBe(false);
  });
});
