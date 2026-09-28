import { afterEach, describe, expect, test, vi } from "vitest";
import { createTerminalLayoutScheduler } from "./terminalLayout";

afterEach(() => vi.useRealTimers());

describe("terminal layout lifecycle", () => {
  test("keeps the server grid while hidden, including a pending visible resize", () => {
    vi.useFakeTimers();
    let visible = true;
    const resize = vi.fn();
    const layout = createTerminalLayoutScheduler(() => visible, resize);
    layout.schedule();
    visible = false;
    vi.advanceTimersByTime(200);
    expect(resize).not.toHaveBeenCalled();
    layout.schedule();
    vi.advanceTimersByTime(200);
    expect(resize).not.toHaveBeenCalled();
    visible = true;
    layout.schedule();
    vi.advanceTimersByTime(100);
    expect(resize).toHaveBeenCalledTimes(1);
    layout.dispose();
  });

  test("applies the settled width, not a transient narrow restore frame", () => {
    vi.useFakeTimers();
    let cols = 10;
    const resize = vi.fn();
    const layout = createTerminalLayoutScheduler(() => true, () => resize(cols));
    layout.schedule();
    vi.advanceTimersByTime(50);
    cols = 120;
    layout.schedule();
    vi.advanceTimersByTime(100);
    expect(resize.mock.calls).toEqual([[120]]);
    layout.dispose();
  });

  test("does not touch a disposed terminal even after another restore event", () => {
    vi.useFakeTimers();
    const resize = vi.fn();
    const layout = createTerminalLayoutScheduler(() => true, resize);
    layout.schedule();
    layout.dispose();
    layout.schedule();
    vi.runAllTimers();
    expect(resize).not.toHaveBeenCalled();
  });
});
