import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRdpFrame, rdpScancode, RdpInputQueue, validRdpText, rdpDisplaySize, rdpPoint } from "./rdp";
import type { RdpInput } from "../types/rdp";

afterEach(() => vi.useRealTimers());

describe("RDP text and display scaling", () => {
  it("accepts composed Unicode and bounds complete UTF-16 characters without control keys", () => {
    for (const text of ["한글", "🙂".repeat(128), "e\u0301", "a".repeat(256)]) expect(validRdpText(text)).toBe(true);
    for (const text of ["", "🙂".repeat(129), "a".repeat(257), "\ud800", "\udfff", "\n", "\t", "\0", "\x7f", "\x85", "\u2028", "\u2029"]) expect(validRdpText(text)).toBe(false);
  });
  it("fits without distortion and maps pointer coordinates at different DPI and scroll offsets", () => {
    const fit = rdpDisplaySize(1920, 1080, 1000, 800, "fit", 2);
    expect(fit.width).toBeCloseTo(1000); expect(fit.height).toBeCloseTo(562.5);
    expect(rdpDisplaySize(1920, 1080, 1000, 400, "fit", 1).height).toBe(400);
    expect(rdpDisplaySize(1920, 1080, 600, 400, "pixels", 2)).toEqual({ width: 960, height: 540 });
    expect(rdpDisplaySize(1920, 1080, 600, 400, "pixels", 1.25)).toEqual({ width: 1536, height: 864 });
    expect(rdpPoint(400, 300, { left: -80, top: 30, width: 960, height: 540 }, 1920, 1080)).toEqual({ x: 960, y: 540 });
    expect(rdpPoint(9000, -50, { left: 0, top: 0, width: 960, height: 540 }, 1920, 1080)).toEqual({ x: 1919, y: 0 });
  });
});

describe("RDP binary display", () => {
  it("validates the complete frame before exposing pixels", () => {
    const buffer = new ArrayBuffer(24);
    const header = new DataView(buffer);
    [1, 2, 1, 42].forEach((value, index) => header.setUint32(index * 4, value, true));
    new Uint8Array(buffer, 16).set([255, 0, 0, 255, 0, 255, 0, 255]);
    const frame = decodeRdpFrame(buffer)!;
    expect([frame.width, frame.height, frame.sequence]).toEqual([2, 1, 42]);
    expect([...frame.pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(decodeRdpFrame(new ArrayBuffer(0))).toBeNull();
    expect(() => decodeRdpFrame(buffer.slice(0, 23))).toThrow();
    header.setUint32(4, 0xffffffff, true);
    expect(() => decodeRdpFrame(buffer)).toThrow();
    header.setUint32(4, 2, true);
    header.setUint32(0, 2, true);
    expect(() => decodeRdpFrame(buffer)).toThrow();
  });

  it("uses physical scancodes and distinguishes right modifiers and numpad", () => {
    expect(rdpScancode("KeyA")).toBe(0x1e);
    expect(rdpScancode("ControlLeft")).toBe(0x1d);
    expect(rdpScancode("ControlRight")).toBe(0x11d);
    expect(rdpScancode("NumpadEnter")).toBe(0x11c);
    expect(rdpScancode("Unidentified")).toBeUndefined();
    expect(rdpScancode("constructor")).toBeUndefined();
  });
});

describe("RDP input queue", () => {
  it("coalesces adjacent mouse moves while preserving key and button transitions", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_events: RdpInput[]) => {});
    const queue = new RdpInputQueue(send, vi.fn());
    const move = (x: number): RdpInput => ({ type: "pointer", x, y: 0, button: null, down: false });
    queue.push(move(1)); queue.push(move(2));
    queue.push({ type: "key", code: 0x1e, down: true });
    queue.push(move(3));
    queue.push({ type: "pointer", x: 3, y: 0, button: 0, down: true });
    queue.push(move(4));
    queue.push({ type: "key", code: 0x1e, down: false });
    await vi.advanceTimersByTimeAsync(16);
    expect(send.mock.calls[0][0]).toEqual([move(2), { type: "key", code: 0x1e, down: true }, move(3), { type: "pointer", x: 3, y: 0, button: 0, down: true }, move(4), { type: "key", code: 0x1e, down: false }]);
    queue.close();
  });

  it("sends release after the in-flight batch and drops unsent keys on blur", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const send = vi.fn((_events: RdpInput[]) => new Promise<void>((resolve) => { finish = resolve; }));
    const queue = new RdpInputQueue(send, vi.fn());
    queue.push({ type: "key", code: 0x1d, down: true });
    await vi.advanceTimersByTimeAsync(16);
    queue.push({ type: "key", code: 0x38, down: true });
    queue.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(16);
    expect(send.mock.calls[1][0]).toEqual([{ type: "release_all" }]);
    queue.close(); finish();
  });

  it("bounds batches and preserves event order across them", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_events: RdpInput[]) => {});
    const queue = new RdpInputQueue(send, vi.fn());
    for (let i = 0; i < 100; i++) queue.push({ type: "key", code: 0x1e, down: i % 2 === 0 });
    await vi.advanceTimersByTimeAsync(32);
    expect(send.mock.calls.map(([batch]) => batch.length)).toEqual([64, 36]);
    expect(send.mock.calls.flatMap(([batch]) => batch).every((event, i) => event.type === "key" && event.down === (i % 2 === 0))).toBe(true);
    queue.close();
  });

  it("fails closed on overflow or send failure", async () => {
    vi.useFakeTimers();
    const fail = vi.fn(); const send = vi.fn(async () => {});
    const queue = new RdpInputQueue(send, fail);
    for (let i = 0; i < 130; i++) queue.push({ type: "key", code: 0x1e, down: true });
    await vi.advanceTimersByTimeAsync(32);
    expect(fail).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    const broken = new RdpInputQueue(async () => { throw Error("pipe closed"); }, fail);
    broken.release(); await vi.advanceTimersByTimeAsync(32);
    expect(fail).toHaveBeenCalledTimes(2);
    broken.release(); await vi.advanceTimersByTimeAsync(32);
    expect(fail).toHaveBeenCalledTimes(2);
  });
});
