/**
 * Serializes best-effort directory writes in mutation order.
 *
 * A stalled D1 call must not permanently hold this lane (the retry helper
 * bounds each attempt). While a write is active, repeated updates for the
 * same session coalesce into one pending slot. This keeps `waitUntil` work
 * bounded during an event burst without hiding capacity failures.
 */
export class DirectoryUpdateQueue {
  private readonly maxPending: number;
  private readonly pending: QueueEntry[] = [];
  private readonly pendingByKey = new Map<string, QueueEntry>();
  private running = false;

  constructor({ maxPending = 32 }: { maxPending?: number } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new Error("DirectoryUpdateQueue maxPending must be a positive integer");
    }
    this.maxPending = maxPending;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  enqueue(work: () => Promise<void>, { key }: { key?: string } = {}): Promise<void> {
    if (key) {
      const existing = this.pendingByKey.get(key);
      if (existing) {
        existing.work = work;
        return existing.promise;
      }
    }

    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new Error("Directory update queue capacity exhausted"));
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const entry: QueueEntry = { work, key, promise, resolve, reject };
    this.pending.push(entry);
    if (key) this.pendingByKey.set(key, entry);
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;
        if (entry.key) this.pendingByKey.delete(entry.key);
        try {
          await entry.work();
          entry.resolve();
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.running = false;
      // An enqueue can happen after the loop observes an empty queue but
      // before `running` is reset.
      if (this.pending.length > 0) void this.drain();
    }
  }
}

type QueueEntry = {
  work: () => Promise<void>;
  key?: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
