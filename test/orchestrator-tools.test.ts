import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDecision, propose } from "../src/ledger.ts";
import { respond, type Server } from "../src/mcp.ts";
import type { Repo } from "../src/paths.ts";
import { loadPlan, planPath } from "../src/plan.ts";
import { loadQuestions } from "../src/questions.ts";
import { ensureForeman } from "../src/paths.ts";
import { findTask } from "../src/state.ts";
import { ORCHESTRATOR_TOOLS } from "../src/tools/orchestrator.ts";
import type { Role } from "../src/tools/tool.ts";
import { orchestratorAllowedTools } from "../src/up.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

const task = (id: string, status: string) => ({ id, status, title: `feat: build ${id}`, worker: "W1", branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, owns: ["src/"], socket: "", createdAt: "", tab: { session: "session:1", window: `window:${id}`, pane: "block:1" } });

// spawn marks each new worktree trusted in Claude Code's config, which must not be the user's own.
let savedConfigDir: string | undefined;
beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

function crew(statuses: Record<string, string> = { T1: "running" }) {
  const repo = tempRepo();
  ensureForeman(repo);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: Object.entries(statuses).map(([id, s]) => task(id, s)) }));
  return repo;
}

function server(repo: Repo, role: Role = "orchestrator") {
  const term = fakeTerminal();
  const s: Server = { name: "foreman", version: "0", tools: ORCHESTRATOR_TOOLS, session: { role, repo, term: () => term } };
  const call = async (name: string, args: object = {}) => {
    const r = (await respond({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, s)) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (r.error) throw new Error(r.error.message);
    return { text: r.result!.content[0]!.text, isError: !!r.result!.isError };
  };
  const ok = async (name: string, args: object = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(r.text);
    return r.text;
  };
  // A worker without a socket gets each message as a file its tab is told to read.
  const received = () => term.sent.map((line) => readFileSync(line.match(/read (\S+) and act/)![1]!, "utf8"));
  const list = async () => ((await respond({ jsonrpc: "2.0", id: 1, method: "tools/list" }, s)) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  return { term, call, ok, list, received };
}

// Quotes, backticks, a dollar sign and blank lines are what broke --body on the shell.
const LONG = [
  "## Context",
  "",
  'The worker said "don\'t block the main thread", and `swift test -j 3` hangs on $CI.',
  "",
  ...Array.from({ length: 40 }, (_, i) => `- Point ${i + 1}: keep \`Store.save()\` off the main actor, since 'it' writes $HOME/.cache > 1MB.`),
].join("\n");

test("the orchestrator gets every command it runs as a tool, and a worker gets none of them", async () => {
  const repo = crew();
  expect(await server(repo).list()).toEqual([
    "plan", "next", "spawn", "send", "review", "feedback", "deliver", "sync", "teardown", "pause", "resume", "restart", "tidy", "unblock",
    "workers", "automerge", "set_budget", "decisions", "accept", "reject", "propose", "adr", "ask", "answer", "note", "notes", "shots",
  ]);
  expect(await server(repo, "worker").list()).toEqual([]);
});

test("a long body survives the trip through foreman mcp over stdio", async () => {
  const repo = crew();
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const env = { ...process.env, FOREMAN_ROLE: "orchestrator", FOREMAN_TASK: "" };
  const proc = Bun.spawn(["bun", cli, "mcp"], { cwd: repo.root, env, stdin: "pipe", stdout: "pipe" });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) + "\n");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "propose", arguments: { title: "Saves stay off the main thread", body: LONG } } }) + "\n");
  proc.stdin.end();
  const replies = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(replies.find((r) => r.id === 2).result.content[0].text).toBe("proposed D-1");
  expect(findDecision(repo, "D-1").body).toBe(LONG);
});

test("propose keeps a long body exactly as written", async () => {
  const repo = crew();
  const { ok } = server(repo);
  expect(await ok("propose", { title: "Saves stay off the main thread", body: LONG, paths: "src/store/** docs/store.md" })).toBe("proposed D-1");
  const d = findDecision(repo, "D-1");
  expect(d.body).toBe(LONG);
  expect(d.paths).toEqual(["src/store/**", "docs/store.md"]);
  expect(d.by).toBe("orchestrator");
});

test("accept takes the rewritten body as text and tells the proposer", async () => {
  const repo = crew();
  propose(repo, { title: "draft", body: "draft body", paths: ["src/"], supersedes: [], by: "T1" });
  const { ok, received } = server(repo);
  expect(await ok("accept", { decision: "D-1", title: "Saves stay off the main thread", body: LONG, supersedes: "3 7" })).toBe("accepted D-1. Told: T1");
  const d = findDecision(repo, "D-1");
  expect(d).toMatchObject({ status: "accepted", title: "Saves stay off the main thread", body: LONG, supersedes: [3, 7] });
  expect(received().join("\n")).toContain("D-1");
});

test("a bad argument comes back as the tool's error, not a crash", async () => {
  const repo = crew();
  const { call } = server(repo);
  expect(await call("accept", { decision: "D-1", supersedes: "ADR-3" })).toEqual({ text: 'supersedes takes ADR numbers, like "3 7", not "ADR-3"', isError: true });
  expect(await call("adr", { action: "rewrite" })).toEqual({ text: "action must be detect, init, write or index, not rewrite", isError: true });
  await expect(call("send", { task: "T1" })).rejects.toThrow("missing argument: message");
});

test("send reaches the worker and puts a blocked task back to running", async () => {
  const repo = crew({ T1: "blocked" });
  const { ok, received } = server(repo);
  expect(await ok("send", { task: "T1", message: LONG })).toBe("sent to T1 via typed");
  expect(received()).toEqual([`[foreman] ${LONG}\n`]);
  expect(findTask(repo, "T1").status).toBe("running");
});

test("ask and answer record the question and the user's answer", async () => {
  const repo = crew();
  const { ok, call } = server(repo);
  expect(await ok("ask", { question: "Tabs or spaces?", call: "spaces", task: "T1" })).toStartWith("recorded Q-1. Ask the user in your own words.");
  expect((await call("answer", { question: "Q-1" })).isError).toBe(true);
  expect(await ok("answer", { question: "Q-1", answer: "tabs" })).toBe("recorded the user's answer to Q-1");
  expect(loadQuestions(repo)[0]).toMatchObject({ id: "Q-1", task: "T1", answer: "tabs" });
});

test("note sends the fact to running workers, and notes lists it", async () => {
  const repo = crew({ T1: "running", T2: "done" });
  const { ok, received } = server(repo);
  expect(await ok("note", { text: "swift test -j 3 deadlocks on main, use -j 1" })).toBe("added note 1. Told: T1, T2");
  expect(received()[0]).toContain("swift test -j 3 deadlocks on main");
  expect(await ok("notes")).toContain("swift test -j 3 deadlocks on main, use -j 1");
  expect(await ok("note", { remove: 1 })).toStartWith("removed note 1:");
  expect(await ok("notes")).toBe("no notes yet. Add one with the note tool");
});

test("set_budget refuses a task that doesn't exist, or a task and the plan at once", async () => {
  const repo = crew();
  const { ok, call } = server(repo);
  expect(await ok("set_budget", { usd: 8, task: "T1" })).toBe("budget: $5.00 per task, $40.00 for the plan, T1 $8.00");
  expect((await call("set_budget", { usd: 8, task: "T9" })).isError).toBe(true);
  expect((await call("set_budget", { usd: 8, task: "T1", plan: true })).isError).toBe(true);
});

test("spawn takes the brief as text and starts the worker with it", async () => {
  const repo = crew({});
  const { ok, term } = server(repo);
  const brief = `## Intent\n"Add tags", the user said.\n\n## Spec\n${LONG}\n`;
  expect(await ok("spawn", { task: "T5", title: "feat: add tags", brief, owns: "src/tags/ docs/tags.md" })).toStartWith("spawned T5:");
  const t = findTask(repo, "T5");
  expect(t.owns).toEqual(["src/tags/", "docs/tags.md"]);
  expect(readFileSync(join(repo.foreman, "tasks", "T5", "brief.md"), "utf8")).toEndWith(brief);
  expect(term.labels).toEqual(["W1 · T5: add tags"]);
});

test("spawn refuses an id that would write outside the task folders", async () => {
  const repo = crew({});
  const { call } = server(repo);
  expect(await call("spawn", { task: "../x", title: "feat: x", brief: "## Intent\n\n## Spec\n", owns: "src/" })).toEqual({ text: "task id must be letters, digits and dashes: ../x", isError: true });
});

const planTask = (id: string, title: string, deps = "none") => `## ${id}: ${title}\n- Owns: src/${id}/\n- Depends on: ${deps}\n\n### Intent\n"${title}", the user said.\n\n### Spec\nBuild it.\n`;
const PLAN_TEXT = `# Plan: Tags\nDeadline: Friday\n\n${planTask("T1", "feat: add tags")}\n${planTask("T2", "feat: filter by tag", "T1")}`;

test("plan takes the whole plan as text, saves plan.md and stores it as a draft", async () => {
  const repo = crew({});
  const { ok } = server(repo);
  expect(await ok("plan", { text: PLAN_TEXT })).toContain("Saved as a draft in .foreman/plan.md");
  expect(readFileSync(join(repo.foreman, "plan.md"), "utf8")).toBe(PLAN_TEXT);
  expect(loadPlan(repo)!.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
  expect(await ok("plan", { approve: true })).toStartWith("approved: Tags.");
  expect(await ok("plan")).toContain("approved ");
});

test("plan with tasks replaces one task and adds another, keeping the rest of plan.md", async () => {
  const repo = crew({});
  const { ok, call } = server(repo);
  await ok("plan", { text: PLAN_TEXT });
  await ok("plan", { approve: true });
  const startedAt = loadPlan(repo)!.startedAt;
  expect(startedAt).toBe(loadPlan(repo)!.approvedAt);
  await ok("workers", { count: 2 });
  writeFileSync(planPath(repo), JSON.stringify({ ...loadPlan(repo), budgetResetAt: "2026-11-25T12:00:00.000Z" }));
  await ok("plan", { tasks: `${planTask("T2", "feat: filter notes by tag", "T1")}\n${planTask("T3", "docs: explain tags", "T1")}` });
  const md = readFileSync(join(repo.foreman, "plan.md"), "utf8");
  expect(md).toStartWith("# Plan: Tags\nDeadline: Friday\n\n## T1: feat: add tags");
  expect(md).not.toContain("## T2: feat: filter by tag\n");
  const p = loadPlan(repo)!;
  expect(p.tasks.map((t) => `${t.id}: ${t.title}`)).toEqual(["T1: feat: add tags", "T2: feat: filter notes by tag", "T3: docs: explain tags"]);
  expect(p.approvedAt).toBeUndefined();
  expect(p.maxWorkers).toBe(2);
  expect(p.startedAt).toBe(startedAt);
  expect(p.budgetResetAt).toBe("2026-11-25T12:00:00.000Z");
  await ok("plan", { approve: true });
  expect(loadPlan(repo)!.startedAt).toBe(startedAt);
  expect(readFileSync(join(repo.foreman, "plan", "T2.md"), "utf8")).toContain('"feat: filter notes by tag", the user said.');
  expect((await call("plan", { tasks: "Make T2 smaller" })).text).toStartWith("tasks takes only task sections");
  expect((await call("plan", { tasks: planTask("T4", "feat: x", "T9") })).text).toBe("problem: T4 depends on T9, which isn't in the plan");
});

test("plan with tasks needs a plan to change", async () => {
  const repo = crew({});
  expect((await server(repo).call("plan", { tasks: planTask("T1", "feat: add tags") })).text).toBe("no plan to change. Give the whole plan as text first");
});

test("workers and automerge need a plan to change, and say so", async () => {
  const repo = crew();
  const { ok, call } = server(repo);
  expect(await ok("automerge")).toStartWith("Automerge is off");
  expect((await call("automerge", { on: true })).text).toStartWith("no plan.");
  expect((await call("workers", { count: 0 })).text).toBe("count must be 1 or more");
});

test("the orchestrator is allowed its tools by name, and no foreman command", () => {
  const allowed = orchestratorAllowedTools();
  expect(allowed).toContain("mcp__foreman__accept");
  expect(allowed).toContain("mcp__foreman__spawn");
  expect(allowed).toContain("mcp__foreman__status");
  expect(allowed).not.toContain("mcp__foreman__report");
  expect(allowed).toContain("mcp__foreman__watch");
  expect(allowed.filter((a) => a.startsWith("Bash("))).toEqual([]);
});
