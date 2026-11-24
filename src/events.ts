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

export function readEvents(repo: Repo, id: string): TaskEvent[] {
  const path = eventsPath(repo, id);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TaskEvent];
      } catch {
        return [];
      }
    });
}
