import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, reject } from "../src/decisions.ts";
import { findDecision, propose } from "../src/ledger.ts";
import { answer, ask, loadQuestions, openQuestions, waitingLines, type Question } from "../src/questions.ts";
import { withTasks, type Task } from "../src/state.ts";
import { gather } from "../src/summary.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

const hourAgo = () => new Date(Date.now() - 60 * 60_000);

const task = (id: string, owns: string[]): Task => ({
  id, status: "running", owns, branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, socket: "/nonexistent.sock",
  tab: { session: "s", window: `w-${id}`, pane: `b-${id}` }, createdAt: "",
});

test("ids count up, and an answer replaces the open question", () => {
  const repo = tempRepo();
  expect(ask(repo, { question: "Should tags be case sensitive?", call: "lowercase them" }).id).toBe("Q-1");
  expect(ask(repo, { question: "Where does the export button go?", call: "the toolbar", task: "T2" }).id).toBe("Q-2");
  answer(repo, "Q-1", { answer: "keep the case they typed" });
  expect(loadQuestions(repo)).toHaveLength(2);
  expect(openQuestions(repo).map((q) => q.id)).toEqual(["Q-2"]);
  expect(loadQuestions(repo)[0]).toMatchObject({ answer: "keep the case they typed", by: "user" });
});

test("a question needs a call, and Foreman never answers over the user", () => {
  const repo = tempRepo();
  expect(() => ask(repo, { question: "Raise T3's limit?", call: " " })).toThrow("--call");
  ask(repo, { question: "Tabs or spaces?", call: "spaces" });
  answer(repo, "Q-1", { byForeman: true });
  expect(() => answer(repo, "Q-1", { byForeman: true })).toThrow("already answered");
  ask(repo, { question: "Dark mode?", call: "yes" });
  answer(repo, "Q-2", { answer: "no" });
  expect(() => answer(repo, "Q-2", { byForeman: true })).toThrow("already answered");
  expect(() => answer(repo, "Q-9", { answer: "x" })).toThrow("no question Q-9");
});

test("Foreman going ahead with a decision marks it, and the user can overrule it", () => {
  const repo = tempRepo();
  withTasks(repo, (ts) => ts.push(task("T1", ["src/export/"]), task("T2", ["src/export/Codec.swift"]), task("T3", ["src/ui/"])));
  propose(repo, { title: "Exports are H.264", body: "Why.", paths: ["src/export/**"], supersedes: [], by: "T1" });
  ask(repo, { question: "Should exports be H.264?", call: "accept D-1", task: "T1", decision: "D-1" }, hourAgo());
  expect(() => answer(repo, "Q-1", { byForeman: true })).toThrow("Accept or reject it first");

  const term = fakeTerminal();
  accept(repo, "D-1", {}, term);
  answer(repo, "Q-1", { byForeman: true });
  expect(findDecision(repo, "D-1").decidedBy).toBe("foreman");
  expect(gather(repo, undefined).away.map((a) => a.question.id)).toEqual(["Q-1"]);

  const r = reject(repo, "D-1", "the user wants HEVC", term);
  expect(r.sent).toEqual(["T1", "T2"]);
  expect(findDecision(repo, "D-1").status).toBe("rejected");
  expect(gather(repo, undefined).away).toEqual([]);
});

test("Foreman can close a question by rejecting the decision, without marking it as its own", () => {
  const repo = tempRepo();
  propose(repo, { title: "Use tabs", body: "Why.", paths: [], supersedes: [], by: "T1" });
  ask(repo, { question: "Tabs?", call: "reject D-1", decision: "D-1" }, hourAgo());
  reject(repo, "D-1", "the repo uses spaces", fakeTerminal());
  expect(answer(repo, "Q-1", { byForeman: true })).toMatchObject({ by: "foreman" });
  expect(findDecision(repo, "D-1").decidedBy).toBeUndefined();
  expect(gather(repo, undefined).away.map((a) => a.question.id)).toEqual(["Q-1"]);
});

test("settling a decision in time records it as the user's answer, so Foreman can't claim it", () => {
  const repo = tempRepo();
  propose(repo, { title: "Use tabs", body: "Why.", paths: [], supersedes: [], by: "T1" });
  ask(repo, { question: "Tabs?", call: "accept D-1", decision: "D-1" });
  accept(repo, "D-1", {}, fakeTerminal());
  expect(openQuestions(repo)).toEqual([]);
  expect(loadQuestions(repo)[0]).toMatchObject({ by: "user", answer: "accepted D-1" });
  expect(() => answer(repo, "Q-1", { byForeman: true })).toThrow("already answered");
  expect(findDecision(repo, "D-1").decidedBy).toBeUndefined();
});

test("Foreman refuses to claim a decision settled before the question ran out of time", () => {
  const repo = tempRepo();
  propose(repo, { title: "Use tabs", body: "Why.", paths: [], supersedes: [], by: "T1" });
  accept(repo, "D-1", {}, fakeTerminal());
  writeFileSync(join(repo.foreman, "questions.jsonl"), JSON.stringify({ id: "Q-1", question: "Tabs?", call: "accept D-1", decision: "D-1", askedAt: new Date().toISOString() }) + "\n");
  expect(() => answer(repo, "Q-1", { byForeman: true })).toThrow("so it was the user's call");
  expect(findDecision(repo, "D-1").decidedBy).toBeUndefined();
});

test("a late answer from the user keeps Foreman's call in the summary while its decision stands", () => {
  const repo = tempRepo();
  propose(repo, { title: "Use tabs", body: "Why.", paths: [], supersedes: [], by: "T1" });
  ask(repo, { question: "Tabs?", call: "accept D-1", decision: "D-1" }, hourAgo());
  accept(repo, "D-1", {}, fakeTerminal());
  answer(repo, "Q-1", { byForeman: true });
  expect(answer(repo, "Q-1", { answer: "no, spaces" })).toMatchObject({ by: "foreman", userAnswer: "no, spaces" });
  expect(() => answer(repo, "Q-1", { answer: "really, spaces" })).toThrow("already answered");
  expect(gather(repo, undefined).away).toMatchObject([{ question: { id: "Q-1", userAnswer: "no, spaces" }, decision: { id: "D-1", status: "accepted" } }]);
});

test("a decision the user accepted can't be rejected afterwards", () => {
  const repo = tempRepo();
  propose(repo, { title: "Use tabs", body: "Why.", paths: [], supersedes: [], by: "orchestrator" });
  accept(repo, "D-1", {}, fakeTerminal());
  expect(() => reject(repo, "D-1", "changed my mind", fakeTerminal())).toThrow("already accepted");
  expect(() => ask(repo, { question: "Tabs?", call: "accept D-1", decision: "D-1" })).toThrow("isn't waiting for a decision");
});

test("status says when Foreman goes ahead with each open question", () => {
  const q = (id: string, askedAt: string, extra: Partial<Question> = {}): Question => ({ id, question: "Tabs or spaces?", call: "spaces.", askedAt, ...extra });
  const now = Date.parse("2026-01-01T02:00:00Z");
  const questions = [q("Q-1", "2026-01-01T01:48:00Z", { task: "T1", decision: "D-4" }), q("Q-2", "2026-01-01T01:00:00Z"), q("Q-3", "2026-01-01T01:00:00Z", { answeredAt: "x" })];
  expect(waitingLines(questions, now, 30 * 60_000)).toEqual([
    "Q-1 (T1, D-4): Tabs or spaces? Foreman's call: spaces. Foreman goes ahead in 18 min.",
    "Q-2: Tabs or spaces? Foreman's call: spaces. Foreman is going ahead with it.",
  ]);
  expect(waitingLines(questions, now, 0)[0]).toEndWith("It waits for you.");
});

test("only the orchestrator records questions, and ask prints the id", () => {
  const repo = tempRepo();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(["bun", cli, ...args], { cwd: repo.root, env: { ...process.env, FOREMAN_TASK: "", ...env } });
  expect(run(["ask", "Tabs?", "--call", "spaces"], { FOREMAN_TASK: "T1" }).stderr.toString()).toContain("only the orchestrator");
  expect(run(["ask", "Tabs?", "--call", "spaces"]).stdout.toString()).toStartWith("recorded Q-1. Ask the user in your own words. If they don't answer within 30 min");
  expect(run(["status"]).stdout.toString()).toContain("Questions waiting on you\n  Q-1: Tabs? Foreman's call: spaces.");
  expect(run(["answer", "Q-1", "--by-foreman"]).stdout.toString()).toContain("recorded that Foreman went ahead with Q-1");
});
