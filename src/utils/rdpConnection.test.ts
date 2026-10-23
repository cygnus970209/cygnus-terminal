import { describe, expect, it, vi } from "vitest";
import { RdpConnection } from "./rdpConnection";
import type { RdpConfig, RdpEvent } from "../types/rdp";

const config: RdpConfig = { host: "rdp.test", port: 3389, username: "user", domain: "", width: 1280, height: 720, desktop_scale_factor: 150 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("RDP connection ownership", () => {
  it("waits for old helper cleanup and ignores old events before opening a replacement", async () => {
    const closed = deferred<void>();
    const events: ((event: RdpEvent) => void)[] = [];
    const open = vi.fn(async (_config: RdpConfig, notify: (event: RdpEvent) => void) => { events.push(notify); return `session-${events.length}`; });
    const close = vi.fn(() => closed.promise);
    const connection = new RdpConnection({ open, close });
    const notify = vi.fn(), opening = vi.fn();
    expect(await connection.start(config, notify, opening)).toBe("session-1");
    const next = connection.start(config, notify, opening);
    await tick();
    events[0]({ type: "ended" });
    expect(notify).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith("session-1");
    expect(open).toHaveBeenCalledTimes(1);
    expect(await connection.start(config, notify, opening)).toBeNull();
    closed.resolve();
    expect(await next).toBe("session-2");
    events[1]({ type: "connected", width: 1280, height: 720 });
    expect(notify).toHaveBeenCalledOnce();
    expect(opening).toHaveBeenCalledTimes(2);
  });

  it("reaps a late open after cancellation before allowing another attempt", async () => {
    const late = deferred<string>(), closed = deferred<void>();
    const open = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue("new");
    const close = vi.fn(() => closed.promise);
    const connection = new RdpConnection({ open, close });
    const first = connection.start(config, vi.fn(), vi.fn());
    await tick();
    const stop = connection.stop();
    const next = connection.start(config, vi.fn(), vi.fn());
    late.resolve("old"); await tick();
    expect(close).toHaveBeenCalledWith("old");
    expect(open).toHaveBeenCalledTimes(1);
    closed.resolve();
    expect(await first).toBeNull(); await stop;
    expect(await next).toBe("new");
  });

  it("retains ownership after cleanup failure and retries it before any new connection", async () => {
    const open = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const close = vi.fn().mockRejectedValueOnce(Error("private error")).mockResolvedValue(undefined);
    const connection = new RdpConnection({ open, close });
    await connection.start(config, vi.fn(), vi.fn());
    await expect(connection.start(config, vi.fn(), vi.fn())).rejects.toMatchObject({ stage: "close" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(await connection.start(config, vi.fn(), vi.fn())).toBe("new");
    expect(close.mock.calls).toEqual([["old"], ["old"]]);
  });

  it("cancel while waiting for cleanup never opens the requested replacement", async () => {
    const closed = deferred<void>();
    const open = vi.fn().mockResolvedValue("old");
    const connection = new RdpConnection({ open, close: () => closed.promise });
    await connection.start(config, vi.fn(), vi.fn());
    const next = connection.start(config, vi.fn(), vi.fn());
    await tick(); const stop = connection.stop(); closed.resolve();
    expect(await next).toBeNull(); await stop;
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("disposing suppresses callbacks and closes late results without reopening", async () => {
    const late = deferred<string>();
    let event!: (event: RdpEvent) => void;
    const open = vi.fn((_config: RdpConfig, notify: (event: RdpEvent) => void) => { event = notify; return late.promise; });
    const close = vi.fn(async () => {}), notify = vi.fn();
    const connection = new RdpConnection({ open, close });
    const pending = connection.start(config, notify, vi.fn()); await tick();
    const disposed = connection.dispose();
    event({ type: "error", message: "old" }); late.resolve("old");
    expect(await pending).toBeNull(); await disposed;
    expect(notify).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledWith("old");
    expect(await connection.start(config, notify, vi.fn())).toBeNull();
  });

  it("captures settings without retaining future draft edits and permits retry after open failure", async () => {
    const open = vi.fn().mockRejectedValueOnce(Error("private error")).mockResolvedValueOnce("new");
    const connection = new RdpConnection({ open, close: vi.fn() });
    const draft = { ...config };
    const first = connection.start(draft, vi.fn(), vi.fn()); draft.host = "other.test";
    await expect(first).rejects.toMatchObject({ stage: "connect" });
    expect(open.mock.calls[0][0].host).toBe("rdp.test");
    expect(await connection.start(config, vi.fn(), vi.fn())).toBe("new");
  });
});
