/** Coalesce transient window sizes; recheck visibility when the timer actually runs. */
export function createTerminalLayoutScheduler(
  canLayout: () => boolean,
  layout: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const schedule = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = undefined;
    if (!canLayout()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && canLayout()) layout();
    }, 100);
  };
  return {
    schedule,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
