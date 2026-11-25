import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./paths.ts";
import { writeJson } from "./store.ts";

// The whole account shares one usage limit, so one wait covers every worker and reviewer.
export type UsageLimit = {
  since: number;
  resetsAt: number;
  // Claude Code's message had no reset time Foreman could read, so resetsAt is only when Foreman tries again.
  guessed?: boolean;
  by: string;
  announced?: boolean;
  paused: string[];
};

export type LimitHit = { at: number; resetsAt: number; guessed: boolean };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// A worker resumed too early hits the limit again at no cost and is paused with the new reset time.
export const RETRY_MS = 60 * MIN;
// Resuming on the reset minute can land a request a few seconds before the account's window opens.
const RESET_SLACK_MS = MIN;

const limitFile = (repo: Repo) => join(repo.foreman, "limit.json");

export function loadLimit(repo: Repo): UsageLimit | undefined {
  try {
    return JSON.parse(readFileSync(limitFile(repo), "utf8"));
  } catch {
    return undefined;
  }
}

// A wait whose reset has passed is over even when no watcher was running to clear it.
export function activeLimit(repo: Repo, now = Date.now()): UsageLimit | undefined {
  const limit = loadLimit(repo);
  return limit && !resumeDue(limit, now) ? limit : undefined;
}

export function saveLimit(repo: Repo, limit: UsageLimit | undefined): void {
  if (!limit) return rmSync(limitFile(repo), { force: true });
  mkdirSync(repo.foreman, { recursive: true });
  writeJson(limitFile(repo), limit);
}

// Claude Code says "You've hit your session limit · resets 3:45pm" or "· resets Mon 12:00am", and versions before 2.1 wrote "Claude AI usage limit reached|<epoch seconds>".
const LIMIT_TEXT = /hit your (?:\w+ )?limit|usage limit|limit reached/i;
const THROTTLED = /rate limit reached|too many requests|overloaded/i;

export function isLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text) && !(THROTTLED.test(text) && !/resets?|\|\d{9,}/i.test(text));
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// The time is the machine's local time, since Claude Code formats it where it runs, which is this machine.
export function resetTime(text: string, at: number): number | undefined {
  const epoch = text.match(/\|(\d{9,11})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = text.match(/resets?(?: at)?\s+((?:[a-z]{3,9}\s+\d{1,2},?\s+(?:at\s+)?|[a-z]{3,9},?\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?![\d,:])/i);
  const clock = m?.[1]!.toLowerCase().match(/^(.*?)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!clock) return undefined;
  const words = clock[1]!.replace(/,/g, " ").split(/\s+/).filter((w) => w && w !== "at");
  let hour = Number(clock[2]);
  const minute = Number(clock[3] ?? 0);
  if (clock[4] === "pm" && hour < 12) hour += 12;
  if (clock[4] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const day = new Date(at);
  day.setHours(hour, minute, 0, 0);
  const month = words.findIndex((w) => MONTHS.includes(w.slice(0, 3)) && !DAYS.includes(w.slice(0, 3)));
  const date = words.map(Number).find((n) => Number.isInteger(n) && n >= 1 && n <= 31);
  const weekday = words.map((w) => DAYS.indexOf(w.slice(0, 3))).find((d) => d >= 0);
  if (month >= 0 && date !== undefined) {
    day.setMonth(MONTHS.indexOf(words[month]!.slice(0, 3)), date);
    if (day.getTime() <= at - DAY) day.setFullYear(day.getFullYear() + 1);
    return day.getTime();
  }
  if (weekday !== undefined) {
    day.setDate(day.getDate() + ((weekday - day.getDay() + 7) % 7));
    if (day.getTime() <= at) day.setDate(day.getDate() + 7);
    return day.getTime();
  }
  if (day.getTime() <= at) day.setDate(day.getDate() + 1);
  return day.getTime();
}

export function limitHit(text: string, at: number): LimitHit | undefined {
  if (!isLimitText(text)) return undefined;
  const resetsAt = resetTime(text, at);
  return resetsAt !== undefined && resetsAt > at ? { at, resetsAt, guessed: false } : { at, resetsAt: at + RETRY_MS, guessed: true };
}

// claude -p doesn't wait for the reset: it exits with the limit message as its result.
export function reviewerLimit(stdout: string, stderr: string, at: number): LimitHit | undefined {
  let result = "";
  try {
    const out = JSON.parse(stdout);
    // A finished review can quote the words "usage limit" from the very diff it read.
    if (!out.is_error) return undefined;
    result = String(out.result ?? "");
  } catch {
    result = stdout;
  }
  return limitHit(`${result}\n${stderr}`, at);
}

export const resumeDue = (limit: UsageLimit, now: number) => now >= limit.resetsAt + (limit.guessed ? 0 : RESET_SLACK_MS);

const pad = (n: number) => String(n).padStart(2, "0");

export function clockAt(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
}

export function resetPhrase(limit: Pick<UsageLimit, "resetsAt" | "guessed">, now: number): string {
  const at = clockAt(limit.resetsAt, now);
  return limit.guessed ? `an unknown time, so Foreman tries again at ${at}` : at;
}

export function limitLine(limit: UsageLimit, now = Date.now()): string {
  return `the account is waiting for its usage limit to reset at ${resetPhrase(limit, now)}`;
}

export type Sleep = (ms: number) => Promise<unknown>;

const POLL_MS = 30_000;

// The watcher clears the wait once it resumes the workers, but a review shouldn't depend on the watcher running.
// until is a hit the caller saw itself, which it must wait out even if the saved wait has already ended.
export async function waitForReset(repo: Repo, opts: { until?: LimitHit; onWait?: (limit: UsageLimit) => void; sleep?: Sleep; now?: () => number } = {}): Promise<void> {
  const { sleep = Bun.sleep, now = () => Date.now() } = opts;
  const own: UsageLimit | undefined = opts.until && { since: opts.until.at, resetsAt: opts.until.resetsAt, guessed: opts.until.guessed, by: "", paused: [] };
  let told = false;
  for (;;) {
    const saved = loadLimit(repo);
    const limit = [saved, own].filter((l): l is UsageLimit => !!l && !resumeDue(l, now())).sort((a, b) => b.resetsAt - a.resetsAt)[0];
    if (!limit) return;
    if (!told) opts.onWait?.(limit), (told = true);
    await sleep(Math.min(POLL_MS, Math.max(1_000, limit.resetsAt + (limit.guessed ? 0 : RESET_SLACK_MS) - now())));
  }
}
