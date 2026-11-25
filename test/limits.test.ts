import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { limitHit, limitLine, loadLimit, RETRY_MS, reviewerLimit, saveLimit, transcriptLimit, waitForReset, type UsageLimit } from "../src/limits.ts";
import { respond, type Server } from "../src/mcp.ts";
import { resume } from "../src/stop.ts";
import { orchestratorTools } from "../src/tools/orchestrator.ts";
import { withTasks } from "../src/state.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.TZ = "UTC";

const at = (hhmm: string, day = 25) => Date.parse(`2026-11-${day}T${hhmm}:00Z`);
const HIT = at("14:00");

test("reads the reset time from each way Claude Code words the limit", () => {
  const reset = (text: string) => limitHit(text, HIT);
  expect(reset("You've hit your session limit · resets 3:45pm")).toEqual({ at: HIT, resetsAt: at("15:45"), guessed: false });
  expect(reset("You've hit your session limit · resets 9am")?.resetsAt).toBe(at("09:00", 26));
  expect(reset("You've hit your weekly limit · resets Mon 12:00am")?.resetsAt).toBe(at("00:00", 30));
  expect(reset("5-hour limit reached ∙ resets 3pm (Europe/London)")?.resetsAt).toBe(at("15:00"));
  expect(reset("Usage limit reached · limit resets Dec 1 at 5pm")?.resetsAt).toBe(Date.parse("2026-12-01T17:00:00Z"));
  expect(reset(`Claude AI usage limit reached|${at("18:00") / 1000}`)?.resetsAt).toBe(at("18:00"));
});

test("a limit message with no readable time tries again in an hour, and throttling isn't the usage limit", () => {
  expect(limitHit("You've hit your session limit", HIT)).toEqual({ at: HIT, resetsAt: HIT + RETRY_MS, guessed: true });
  expect(limitHit("API Error: Rate limit reached", HIT)).toBeUndefined();
  expect(limitHit("API Error: Can't reach the API server", HIT)).toBeUndefined();
});

const line = (o: object) => JSON.stringify(o);
const reply = (hhmm: string) => line({ type: "assistant", timestamp: new Date(at(hhmm)).toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } });
const limitError = (hhmm: string, text = "You've hit your session limit · resets 3:45pm", error = "rate_limit") =>
  line({ type: "assistant", timestamp: new Date(at(hhmm)).toISOString(), isApiErrorMessage: true, error, message: { model: "<synthetic>", content: [{ type: "text", text }] } });

test("a worker is at the limit only while Claude Code's limit error is its last reply", () => {
  const queued = line({ type: "user", timestamp: new Date(at("14:20")).toISOString(), message: { content: "[foreman] nudge" } });
  expect(transcriptLimit([reply("13:50"), limitError("14:00"), queued])).toEqual({ at: HIT, resetsAt: at("15:45"), guessed: false });
  expect(transcriptLimit([limitError("14:00"), reply("15:46")])).toBeUndefined();
  expect(transcriptLimit([reply("13:50"), limitError("14:00", "Login expired · Please run /login", "authentication_failed")])).toBeUndefined();
  expect(transcriptLimit(["{not json", reply("13:50")])).toBeUndefined();
});

test("a reviewer's -p run that stops at the limit is told apart from a review that quotes the words", () => {
  expect(reviewerLimit(JSON.stringify({ is_error: true, result: "You've hit your session limit · resets 3:45pm" }), "", HIT)?.resetsAt).toBe(at("15:45"));
  expect(reviewerLimit("", "You've hit your weekly limit · resets Mon 12:00am", HIT)?.resetsAt).toBe(at("00:00", 30));
  expect(reviewerLimit(JSON.stringify({ is_error: false, result: "Checks the usage limit resets 3pm wording." }), "", HIT)).toBeUndefined();
});

const wait = (extra: Partial<UsageLimit> = {}): UsageLimit => ({ since: HIT, resetsAt: at("15:45"), by: "T1", paused: ["T1"], announced: true, ...extra });

test("waitForReset holds until the reset, or until the watcher ends the wait", async () => {
  const repo = tempRepo();
  let now = HIT;
  const slept: number[] = [];
  const sleep = async (ms: number) => void (slept.push(ms), (now += ms));
  const told: string[] = [];
  saveLimit(repo, wait());
  await waitForReset(repo, { sleep, now: () => now, onWait: (l) => told.push(limitLine(l, now)) });
  expect(now).toBeGreaterThanOrEqual(at("15:46"));
  expect(told).toEqual(["the account is waiting for its usage limit to reset at 15:45"]);

  now = HIT;
  slept.length = 0;
  const ended = async (ms: number) => void ((now += ms), saveLimit(repo, undefined));
  await waitForReset(repo, { sleep: ended, now: () => now });
  expect(now).toBe(HIT + 30_000);
  expect(loadLimit(repo)).toBeUndefined();
});

test("a hit the caller saw itself is waited out even when no wait is saved", async () => {
  const repo = tempRepo();
  let now = HIT;
  await waitForReset(repo, { until: { at: HIT, resetsAt: at("14:30"), guessed: false }, sleep: async (ms) => void (now += ms), now: () => now });
  expect(now).toBeGreaterThanOrEqual(at("14:31"));
});

const waitingNow = () => wait({ since: Date.now(), resetsAt: Date.now() + 60 * 60_000 });

test("foreman resume refuses while the account waits, since the watcher resumes the task at the reset", () => {
  const repo = tempRepo();
  withTasks(repo, (ts) => ts.push({ id: "T1", status: "limited", branch: "foreman/T1", base: "main", worktree: repo.root, owns: [], socket: "", createdAt: "" }));
  saveLimit(repo, waitingNow());
  expect(() => resume(repo, "T1", fakeTerminal(false), "session:1")).toThrow(/waiting for its usage limit to reset at .*, and the watcher resumes T1 then/);
});

test("resume on a task whose worktree is gone points at the teardown tool, not a CLI command", () => {
  const repo = tempRepo();
  withTasks(repo, (ts) => ts.push({ id: "T1", status: "exited", branch: "foreman/T1", base: "main", worktree: join(repo.root, "gone"), owns: [], socket: "", createdAt: "" }));
  expect(() => resume(repo, "T1", fakeTerminal(false), "session:1")).toThrow("T1's worktree is gone, so it can't resume. The orchestrator can tear it down with the teardown tool");
});

test("spawn and next start nothing while the account waits", async () => {
  const repo = tempRepo();
  saveLimit(repo, waitingNow());
  writeFileSync(join(repo.foreman, "plan.json"), JSON.stringify({ title: "p", approvedAt: "2026-11-25T00:00:00Z", tasks: [] }));
  const server: Server = { name: "foreman", version: "0", tools: orchestratorTools(() => fakeTerminal()), session: { role: "orchestrator", repo } };
  for (const [name, args] of [["spawn", { task: "T9", title: "feat: x", brief: "## Intent\n\nx\n", owns: "src/" }], ["next", {}]] as const) {
    const r = (await respond({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, server)) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(r.result.content[0]!.text).toContain("no new tasks start: the account is waiting for its usage limit to reset at");
    expect(r.result.isError).toBe(true);
  }
});
