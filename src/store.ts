import { mkdirSync, rmSync, statSync } from "node:fs";

// A crashed holder never releases the lock, so one older than the longest write is treated as abandoned.
const STALE_LOCK_MS = 30_000;

export function withLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      Bun.sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
