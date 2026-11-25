import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskDir, type Repo } from "./paths.ts";

export const REPORT_TYPES = ["done", "blocked", "needs-decision", "rebased"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export type EventType = ReportType | "exited" | "reviewed";
export type TaskEvent = { at: string; type: EventType; note?: string; test?: string[]; assumptions?: string[] };

const eventsPath = (repo: Repo, id: string) => join(taskDir(repo, id), "events.jsonl");

export type Handover = { test?: string[]; assumptions?: string[] };

export function appendEvent(repo: Repo, id: string, type: EventType, note?: string, handover: Handover = {}): void {
  mkdirSync(taskDir(repo, id), { recursive: true });
  const event: TaskEvent = {
    at: new Date().toISOString(), type, ...(note ? { note } : {}),
    ...(handover.test?.length ? { test: handover.test } : {}),
    ...(handover.assumptions?.length ? { assumptions: handover.assumptions } : {}),
  };
  appendFileSync(eventsPath(repo, id), JSON.stringify(event) + "\n");
}

export const lastDone = (repo: Repo, id: string) => readEvents(repo, id).filter((e) => e.type === "done").at(-1);

export const readEvents = (repo: Repo, id: string) => readJsonl<TaskEvent>(eventsPath(repo, id));

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

// The watcher wakes the orchestrator for every new line in a task's events.jsonl, so what Foreman does to a task goes in this log instead.
export type RunWhat = "started" | "nudged" | "restarted" | "stopped" | "paused" | "resumed" | "pr-opened" | "pr-updated" | "merged" | "torn-down";
export type RunEntry = { at: string; task: string; what: RunWhat; note?: string };

const runLogPath = (repo: Repo) => join(repo.foreman, "log.jsonl");

export function logRun(repo: Repo, task: string, what: RunWhat, note?: string): void {
  mkdirSync(repo.foreman, { recursive: true });
  const entry: RunEntry = { at: new Date().toISOString(), task, what, ...(note ? { note } : {}) };
  appendFileSync(runLogPath(repo), JSON.stringify(entry) + "\n");
}

export const readRunLog = (repo: Repo) => readJsonl<RunEntry>(runLogPath(repo));
