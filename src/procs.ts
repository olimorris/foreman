import { basename } from "node:path";
import { run } from "./exec.ts";
import type { Task } from "./state.ts";

export type Proc = { pid: number; ppid: number; cpuMs: number; ageMs: number; command: string };
export type CpuSample = { at: number; cpu: Record<string, number> };

// One lsof and one ps cover every worktree, since the watcher looks at all of them on each pass.
export function processesIn(dirs: string[]): Proc[][] {
  if (!dirs.length) return [];
  const owner = new Map<number, number>();
  let pid = 0;
  for (const line of run(["lsof", "-d", "cwd", "-F", "pn"]).stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== process.pid) {
      const cwd = line.slice(1);
      const i = dirs.findIndex((d) => cwd === d || cwd.startsWith(d + "/"));
      if (i >= 0) owner.set(pid, i);
    }
  }
  const lists = dirs.map((): Proc[] => []);
  if (!owner.size) return lists;
  const ps = run(["ps", "-ww", "-o", "pid=,ppid=,time=,etime=,command=", "-p", [...owner.keys()].join(",")]).stdout;
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) lists[owner.get(Number(m[1]))!]!.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: cpuTime(m[3]!), ageMs: cpuTime(m[4]!), command: m[5]! });
  }
  return lists;
}

// macOS ps prints CPU time as minutes:seconds, with the minutes running past 60, and elapsed time adds hours and days.
export function cpuTime(text: string): number {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const seconds = clock!.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  return Math.round((Number(days) * 86_400 + seconds) * 1000) || 0;
}

export const isWorker = (p: Proc, task: Pick<Task, "socket">) => !!task.socket && p.command.includes(task.socket);

const used = (before: CpuSample, procs: Proc[]) => procs.reduce((sum, p) => sum + Math.max(0, p.cpuMs - (before.cpu[p.pid] ?? 0)), 0);

export const cpuShare = (before: CpuSample, procs: Proc[], now: number) => used(before, procs) / Math.max(1, now - before.at);

// A few percent of one core is enough to tell a running build from a test run stuck on a deadlock, which sits at zero.
export const BUSY_SHARE = 0.05;

// ps counts no CPU time for exited children, so a serial make's short compiler runs only show up as new processes.
export function busy(before: CpuSample, procs: Proc[], now: number, task: Pick<Task, "socket">): boolean {
  const worker = procs.find((p) => isWorker(p, task));
  const others = procs.filter((p) => p !== worker);
  // The worker restarts caffeinate every few minutes, and that says nothing about its commands.
  return cpuShare(before, others, now) > BUSY_SHARE || others.some((p) => !(p.pid in before.cpu) && p.ppid !== worker?.pid);
}

export const sample = (procs: Proc[], now: number): CpuSample => ({ at: now, cpu: Object.fromEntries(procs.map((p) => [p.pid, p.cpuMs])) });

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash"]);

// Claude Code runs each command in a shell of its own, so the command the worker typed is that shell's child.
export function commandName(procs: Proc[], task: Pick<Task, "socket">, before: CpuSample, busy: boolean): string | undefined {
  const worker = procs.find((p) => isWorker(p, task));
  const shells = new Set(procs.filter((p) => p.ppid === worker?.pid && SHELLS.has(program(p))).map((p) => p.pid));
  const commands = procs.filter((p) => shells.has(p.ppid)).map((p) => ({ p, used: used(before, tree(procs, p)) }));
  // A worker can have a dev server running beside the hung test, and naming the wrong one gets the wrong process killed.
  const quiet = commands.filter((c) => c.used === 0);
  const pick = busy || !quiet.length ? commands.sort((a, b) => b.used - a.used)[0] : quiet.sort((a, b) => a.p.ageMs - b.p.ageMs)[0];
  if (!pick) return undefined;
  const text = [program(pick.p), ...pick.p.command.split(" ").slice(1)].join(" ");
  return text.length > 60 ? text.slice(0, 57) + "..." : text;
}

function tree(procs: Proc[], root: Proc): Proc[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...procs.filter((p) => p.ppid === out[i]!.pid));
  return out;
}

const program = (p: Proc) => basename(p.command.split(" ")[0]!).replace(/^-/, "");

// A process whose parent has gone was left behind by a run that timed out or was killed, and nothing will ever wait on it.
export function leftovers(procs: Proc[], task: Pick<Task, "socket">): Proc[] {
  const out = procs.filter((p) => p.ppid === 1 && !isWorker(p, task));
  for (let i = 0; i < out.length; i++) out.push(...procs.filter((p) => p.ppid === out[i]!.pid && !out.includes(p) && !isWorker(p, task)));
  return out;
}

// The tab's processes are found before it closes, since afterwards they can't be told apart from the user's own shell or a review running in the same worktree.
export function workerTree(task: Pick<Task, "socket">): number[] {
  const all = run(["ps", "-ax", "-ww", "-o", "pid=,ppid=,command="]).stdout.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: 0, ageMs: 0, command: m[3]! }] : [];
  });
  return all.filter((p) => isWorker(p, task)).flatMap((w) => tree(all, w).map((p) => p.pid));
}

export function stopWorkerProcesses(task: Pick<Task, "socket" | "worktree">, tree: number[]): number[] {
  const left = leftovers(processesIn([task.worktree])[0]!, task).map((p) => p.pid);
  return stopProcesses([...new Set([...tree, ...left])].filter((p) => p !== process.pid && p !== process.ppid));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A test runner can ignore SIGTERM while it waits on a deadlock, so whatever outlives the grace period gets SIGKILL.
export function stopProcesses(pids: number[], graceMs = 3000, killMs = 5000): number[] {
  const signal = (sig: NodeJS.Signals) => (p: number) => {
    try {
      process.kill(p, sig);
    } catch {}
  };
  const waitFor = (left: number[], ms: number) => {
    const deadline = Date.now() + ms;
    while ((left = left.filter(pidAlive)).length && Date.now() < deadline) Bun.sleepSync(100);
    return left;
  };
  pids.forEach(signal("SIGTERM"));
  const stubborn = waitFor(pids, graceMs);
  stubborn.forEach(signal("SIGKILL"));
  return waitFor(stubborn, killMs);
}

export type Tidy = { stopped: Proc[]; failed: Proc[] };

export function tidy(task: Pick<Task, "socket" | "worktree">, procs = processesIn([task.worktree])[0]!): Tidy {
  const left = leftovers(procs, task);
  const failed = new Set(stopProcesses(left.map((p) => p.pid)));
  return { stopped: left.filter((p) => !failed.has(p.pid)), failed: left.filter((p) => failed.has(p.pid)) };
}

// The worktree is about to be deleted, so nothing in it is worth keeping, and an orphaned dev server would keep its port.
export function stopProcessesIn(dir: string): number[] {
  const pids = processesIn([dir])[0]!.map((p) => p.pid).filter((p) => p !== process.ppid);
  stopProcesses(pids);
  return pids;
}

export const names = (procs: Proc[]) => [...new Set(procs.map(program))].join(", ");

// SIGKILL can't be caught, so a process that outlives it is stuck in the kernel, usually on a disk or a driver.
export const unstoppableLine = (procs: Proc[]) => `${names(procs)} (pid ${procs.map((p) => p.pid).join(", ")}) outlived SIGKILL, so it's stuck and usually only a restart of the Mac clears it`;
