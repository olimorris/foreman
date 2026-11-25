import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

// A reader never sees a half-written file, since the new one replaces the old in one rename.
export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

function writeText(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// tasks.json locks as tasks.lock beside it, which is the name every Foreman version has used.
export function locked<R>(path: string, fn: () => R): R {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path.replace(/\.[^./]+$/, "") + ".lock", fn);
}

export type Store<T> = {
  read(): T;
  // Reads, runs fn on the value, then writes it back, all under the file's lock, so two processes' changes never overwrite each other.
  update<R>(fn: (value: T) => R): R;
};

export type Format<T> = { parse(text: string): T; format(value: T): string; empty(): T; written?(value: T): void };

export function fileStore<T>(path: string, f: Format<T>): Store<T> {
  const read = () => (existsSync(path) ? f.parse(readFileSync(path, "utf8")) : f.empty());
  return {
    read,
    update: (fn) => locked(path, () => {
      const value = read();
      const result = fn(value);
      writeText(path, f.format(value));
      f.written?.(value);
      return result;
    }),
  };
}

export const jsonStore = <T>(path: string, empty: () => T, written?: (value: T) => void): Store<T> =>
  fileStore(path, { parse: (text) => JSON.parse(text), format: (v) => JSON.stringify(v, null, 2) + "\n", empty, written });
