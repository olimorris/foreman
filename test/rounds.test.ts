import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { latest, roundDir, rounds, type Verdict } from "../src/rounds.ts";
import { tempRepo, writeRound } from "./helpers.ts";

const approve: Verdict = { verdict: "approve", summary: "Fine.", issues: [], risk: "low", risk_note: "", decisions_touched: [] };
const changes: Verdict = { ...approve, verdict: "changes", summary: "Not yet." };

test("a task with no reviews has no rounds and no latest round", () => {
  const repo = tempRepo();
  expect(rounds(repo, { id: "T1" })).toEqual([]);
  expect(latest(repo, { id: "T1", reviews: 0 })).toBeUndefined();
});

test("each round carries its verdict, spend, models, the reviewer's output and its screenshots", () => {
  const repo = tempRepo();
  const at = new Date("2026-11-20T11:30:00Z");
  writeRound(repo, "T1", 1, { verdict: changes, reviewer: { total_cost_usd: 0.25, modelUsage: { "claude-opus-5-5": {} } }, at });
  writeRound(repo, "T1", 2, { verdict: approve, reviewer: { total_cost_usd: 0.5, modelUsage: { "claude-sonnet-5-5": {} } }, shots: { before: ["home"], after: ["home", "settings"] } });
  const [one, two] = rounds(repo, { id: "T1", reviews: 2 });
  expect(one).toMatchObject({ n: 1, dir: roundDir(repo, "T1", 1), verdict: changes, costUsd: 0.25, finishedAt: at.getTime(), models: ["claude-opus-5-5"], shots: [] });
  expect(JSON.parse(one!.output!)).toEqual({ total_cost_usd: 0.25, modelUsage: { "claude-opus-5-5": {} } });
  expect(two!.shots.map((s) => [s.name, !!s.before, !!s.after])).toEqual([["home", true, true], ["settings", false, true]]);
  expect(latest(repo, { id: "T1", reviews: 2 })?.verdict).toEqual(approve);
});

test("the latest round is the one the task's count points at, even while it has no verdict", () => {
  const repo = tempRepo();
  writeRound(repo, "T1", 1, { verdict: approve });
  mkdirSync(roundDir(repo, "T1", 2), { recursive: true });
  const r = latest(repo, { id: "T1", reviews: 2 });
  expect(r?.n).toBe(2);
  expect(r?.verdict).toBeUndefined();
  expect(r?.costUsd).toBe(0);
  expect(r?.finishedAt).toBeUndefined();
});

test("a reviewer that left no JSON still counts as output, with no spend or models", () => {
  const repo = tempRepo();
  writeRound(repo, "T1", 1, { reviewer: "claude: usage limit reached", verdict: undefined });
  const [r] = rounds(repo, { id: "T1", reviews: 1 });
  expect(r).toMatchObject({ output: "claude: usage limit reached", costUsd: 0, models: [] });
});
