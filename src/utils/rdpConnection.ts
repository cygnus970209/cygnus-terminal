import type { RdpConfig, RdpEvent } from "../types/rdp";

interface Transport {
  open: (config: RdpConfig, onEvent: (event: RdpEvent) => void) => Promise<string>;
  /** Resolves only after the old helper has exited and its capacity slot is released. */
  close: (id: string) => Promise<void>;
}
export class RdpConnectionError extends Error {
  constructor(readonly stage: "close" | "connect") {
    super(stage === "close" ? "The previous RDP connection could not be closed. Try reconnecting again."
      : "Could not start RDP. Check the server address and the bundled RDP engine.");
  }
}

/** Owns one tab's connection, including a late open result after cancel/unmount. */
export class RdpConnection {
  private id: string | null = null;
  private version = 0;
  private starting = false;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private transport: Transport) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  private async retire() {
    if (!this.id) return;
    try { await this.transport.close(this.id); }
    catch { throw new RdpConnectionError("close"); }
    // Keep the ID on failure so another attempt must retry cleanup before opening.
    this.id = null;
  }
  start(config: RdpConfig, onEvent: (event: RdpEvent) => void, onOpening: () => void): Promise<string | null> {
    if (this.disposed || this.starting) return Promise.resolve(null);
    this.starting = true;
    const version = ++this.version;
    const settings = { ...config };
    const current = () => !this.disposed && version === this.version;
    return this.enqueue(async () => {
      try {
        await this.retire();
        if (!current()) return null;
        onOpening();
        try { this.id = await this.transport.open(settings, (event) => { if (current()) onEvent(event); }); }
        catch { throw new RdpConnectionError("connect"); }
        if (!current()) { await this.retire(); return null; }
        return this.id;
      } catch (error) {
        if (current()) { this.version++; this.starting = false; throw error; }
        return null;
      } finally { if (current()) this.starting = false; }
    });
  }
  stop(): Promise<void> {
    this.version++;
    this.starting = false;
    return this.enqueue(() => this.retire());
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }
}
