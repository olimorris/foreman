import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastReplyAt, overBudget, priceFor, transcriptSpend, usageCost } from "../src/cost.ts";

test("usageCost matches what Claude Code reported for a real review", () => {
  const usage = { input_tokens: 6, output_tokens: 1024, cache_read_input_tokens: 1387674, cache_creation_input_tokens: 23758, cache_creation: { ephemeral_1h_input_tokens: 23758, ephemeral_5m_input_tokens: 0 } };
  expect(usageCost(usage, priceFor("claude-opus-5-5")!)).toBeCloseTo(0.4881028, 6);
});

test("priceFor prefers the longest matching id and takes overrides", () => {
  expect(priceFor("claude-opus-5-5")!.input).toBe(4);
  expect(priceFor("claude-opus-4-8")).toBeUndefined();
  expect(priceFor("claude-opus-4-8", { "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 } })!.input).toBe(5);
});

test("transcriptSpend counts each reply once and only recorded sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-cost-"));
  const reply = (id: string, model = "claude-opus-5-5") => JSON.stringify({ message: { id, model, usage: { input_tokens: 1_000_000 } } });
  writeFileSync(join(dir, "worker-1.jsonl"), [reply("a"), reply("a"), reply("b"), reply("c", "claude-mystery-1")].join("\n"));
  writeFileSync(join(dir, "reviewer-9.jsonl"), reply("z"));
  mkdirSync(join(dir, "worker-1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "worker-1", "subagents", "agent.jsonl"), reply("s"));
  const spend = transcriptSpend(dir, ["worker-1"]);
  expect(spend.usd).toBeCloseTo(12, 6);
  expect(spend.unpriced).toEqual(["claude-mystery-1"]);
});

test("lastReplyAt skips messages queued into an idle session", () => {
  const file = join(mkdtempSync(join(tmpdir(), "foreman-idle-")), "s.jsonl");
  const line = (type: string, timestamp: string) => JSON.stringify({ type, timestamp });
  writeFileSync(file, [line("assistant", "2026-11-25T00:24:24Z"), line("system", "2026-11-25T01:19:26Z"), line("queue-operation", "2026-11-25T07:17:49Z")].join("\n") + "\n");
  expect(lastReplyAt(file)).toBe(Date.parse("2026-11-25T00:24:24Z"));
});

test("overBudget alerts once per limit, and again after the limit is raised", () => {
  const costs = [{ id: "T1", worker: 6, review: 0.5, total: 6.5, unpriced: [] }];
  const first = overBudget(costs, 6.5, { perTask: 5, plan: 6 }, {});
  expect(first.reasons).toEqual(["over-budget T1: $6.50 of $5.00", "over-budget plan: $6.50 of $6.00"]);
  expect(overBudget(costs, 6.5, { perTask: 5, plan: 6 }, first.alerted).reasons).toEqual([]);
  expect(overBudget(costs, 6.5, { perTask: 5, plan: 6, tasks: { T1: 6 } }, first.alerted).reasons).toEqual(["over-budget T1: $6.50 of $6.00"]);
});

test("overBudget names every task to stop on every pass, and every task once the plan is over", () => {
  const costs = [{ id: "T1", worker: 6, review: 0, total: 6, unpriced: [] }, { id: "T2", worker: 1, review: 0, total: 1, unpriced: [] }];
  const first = overBudget(costs, 7, { perTask: 5, plan: 40 }, {});
  expect(first.stop).toEqual(["T1"]);
  expect(overBudget(costs, 7, { perTask: 5, plan: 40 }, first.alerted).stop).toEqual(["T1"]);
  expect(overBudget(costs, 7, { perTask: 5, plan: 6 }, {}).stop).toEqual(["T1", "T2"]);
});
