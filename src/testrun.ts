import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_MINUTES = 15;

export type TestRun = { code: number | null; signal?: string; timedOut: boolean; output: string };
export type TestRunOptions = { minutes: number; log?: string; signal?: AbortSignal; onStart?: (pid: number) => void };

// Runs in its own process group, so a hung run's builds, simulators and servers are killed with it, not just the shell that started them.
// The log is written as the run goes, so a caller can show its output before it finishes.
export async function runTests(command: string, cwd: string, { minutes, log, signal, onStart }: TestRunOptions): Promise<TestRun> {
  const scratch = log ? undefined : mkdtempSync(join(tmpdir(), "foreman-tests-"));
  const file = log ?? join(scratch!, "output.log");
  const fd = openSync(file, "w");
  const proc = Bun.spawn(["sh", "-c", command], { cwd, detached: true, stdin: "ignore", stdout: fd, stderr: fd });
  closeSync(fd);
  onStart?.(proc.pid);
  const stop = () => killGroup(proc.pid);
  signal?.addEventListener("abort", stop, { once: true });
  let timer: Timer | undefined;
  try {
    const timedOut = await Promise.race([proc.exited.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), minutes * 60_000)))]);
    clearTimeout(timer);
    stop();
    await proc.exited;
    const killedBy = timedOut || proc.signalCode == null ? undefined : String(proc.signalCode);
    return { code: timedOut ? null : proc.exitCode, ...(killedBy ? { signal: killedBy } : {}), timedOut, output: readFileSync(file, "utf8") };
  } finally {
    signal?.removeEventListener("abort", stop);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}
