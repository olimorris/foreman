import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_REVISIONS, parseVerdict, renderFeedback, reviewerCommand, roundDir, runReview, sendFeedback, startReview, VERDICT_SCHEMA, verdictLine, type Verdict } from "../src/review.ts";
import { skillsDir } from "../src/skills.ts";
import { saveConfig } from "../src/config.ts";
import { saveLimit } from "../src/limits.ts";
import { readEvents } from "../src/events.ts";
import { fill, parseScreens, splitArgs } from "../src/shots.ts";
import { findTask, withTasks, type Task } from "../src/state.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

const changes: Verdict = {
  verdict: "changes",
  summary: "The export button is missing.",
  issues: [{ where: "Settings > Export", screenshot: "/shots/after/settings.png", intent: "\"an Export button in Settings\"", problem: "No button.", expected: "A button labelled Export." }],
  risk: "low",
  risk_note: "UI only.",
  decisions_touched: [],
};

test("parseScreens reads name and target lines from the Screens section only", () => {
  const brief = "## Intent\n\n- not: a screen\n\n## Screens\n\n- home: /\n- settings: `/settings?tab=export`\n- editor:\n\n## Done when\n\n- x: y\n";
  expect(parseScreens(brief)).toEqual([
    { name: "home", target: "/" },
    { name: "settings", target: "/settings?tab=export" },
    { name: "editor", target: "" },
  ]);
  expect(parseScreens("## Intent\n")).toEqual([]);
});

test("fill and splitArgs", () => {
  expect(fill("npm run dev -- --port {port} {other}", { port: 4123 })).toBe("npm run dev -- --port 4123 {other}");
  expect(splitArgs(`-Open "Sample One" -Flag YES '-x y'`)).toEqual(["-Open", "Sample One", "-Flag", "YES", "-x y"]);
});

test("parseVerdict prefers structured output and falls back to the reply's last JSON block", () => {
  expect(parseVerdict(JSON.stringify({ structured_output: changes }))).toEqual(changes);
  const reply = "Verdict below.\n\n```json\n" + JSON.stringify({ verdict: "approve", summary: "Fine.", issues: [], risk: "low" }) + "\n```";
  expect(parseVerdict(JSON.stringify({ result: reply }))).toMatchObject({ verdict: "approve", risk: "low", decisions_touched: [] });
  expect(parseVerdict(JSON.stringify({ result: "no json here" }))).toBeUndefined();
  expect(parseVerdict("not json")).toBeUndefined();
});

test("the reviewer runs on reviewerModel when it's set, and Claude Code's default otherwise", () => {
  const repo = tempRepo();
  const cmd = reviewerCommand(repo, "T1", 2, "sonnet");
  expect(cmd.slice(cmd.indexOf("--model"), cmd.indexOf("--model") + 2)).toEqual(["--model", "sonnet"]);
  expect(cmd).toContain("2.00");
  expect(reviewerCommand(repo, "T1")).not.toContain("--model");
});

test("a bad reviewerModel fails before the review opens or a round is counted", async () => {
  const repo = tempRepo();
  withTasks(repo, (ts) => ts.push({ id: "T1", status: "done", branch: "foreman/T1", base: "main", worktree: repo.root, owns: ["src/"], socket: "/nonexistent.sock", createdAt: "" }));
  saveConfig(repo, { reviewerModel: "sonet" });
  const term = fakeTerminal();
  expect(() => startReview(repo, "T1", term)).toThrow('reviewerModel in .foreman/config.json: "sonet" isn\'t a model name');
  expect(term.labels).toEqual([]);
  expect(await runReview(repo, "T1")).toStartWith("failed before round 1: reviewerModel");
  expect(findTask(repo, "T1").reviews).toBeUndefined();
  expect(readEvents(repo, "T1").at(-1)).toMatchObject({ type: "reviewed" });
});

test("verdict lines say when to escalate", () => {
  expect(verdictLine({ ...changes, verdict: "approve", issues: [] }, 1, 0)).toBe("approve, round 1, risk low: The export button is missing.");
  expect(verdictLine(changes, 1, 0)).toBe("changes, round 1, 1 issue(s): The export button is missing.");
  expect(verdictLine(changes, 3, MAX_REVISIONS)).toContain("revision limit reached, escalate to the user");
});

test("feedback anchors each issue to its screen, screenshot and intent", () => {
  const text = renderFeedback(changes, 2);
  expect(text).toContain("Review round 2 found 1 thing(s)");
  expect(text).toContain("1. Settings > Export (screenshot: /shots/after/settings.png)");
  expect(text).toContain('Intent: "an Export button in Settings"');
  expect(text).toContain("Expected: A button labelled Export.");
});

describe("sendFeedback", () => {
  function reviewed(verdict: Verdict, extra: Partial<Task> = {}) {
    const repo = tempRepo();
    withTasks(repo, (ts) => ts.push({
      id: "T1", status: "done", branch: "foreman/T1", base: "main", worktree: "/w/T1", owns: ["src/"], socket: "/nonexistent.sock",
      tab: { session: "s", window: "w", pane: "b" }, createdAt: "", reviews: 1, ...extra,
    }));
    const dir = roundDir(repo, "T1", extra.reviews ?? 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict));
    return repo;
  }

  test("sends to the same worker and counts the revision", () => {
    const repo = reviewed(changes);
    const term = fakeTerminal();
    expect(sendFeedback(repo, "T1", term)).toContain("revision 1 of 2");
    const inbox = term.sent[0]!.match(/read (\S+) and act/)![1]!;
    expect(readFileSync(inbox, "utf8")).toContain("Settings > Export");
    expect(findTask(repo, "T1")).toMatchObject({ revisions: 1, status: "running" });
  });

  test("refuses after the revision limit and on an approval", () => {
    expect(() => sendFeedback(reviewed(changes, { reviews: 3, revisions: MAX_REVISIONS }), "T1", fakeTerminal())).toThrow("Escalate to the user");
    expect(() => sendFeedback(reviewed({ ...changes, verdict: "approve" }), "T1", fakeTerminal())).toThrow("no feedback to send");
  });
});

describe("the never list", () => {
  const approve = JSON.stringify({ structured_output: { ...changes, verdict: "approve", issues: [] } });

  async function promptWith(never?: string[]) {
    const repo = tempRepo();
    withTasks(repo, (ts) => ts.push({ id: "T1", status: "done", branch: "main", base: "main", worktree: repo.root, owns: ["src/"], socket: "/nonexistent.sock", createdAt: "" }));
    mkdirSync(join(repo.foreman, "tasks", "T1"), { recursive: true });
    writeFileSync(join(repo.foreman, "tasks", "T1", "brief.md"), "## Intent\n\nx\n");
    saveConfig(repo, { budget: {}, ...(never ? { never } : {}) });
    expect(await runReview(repo, "T1", { reviewer: () => ({ code: 0, stdout: approve, stderr: "" }), say: () => {} })).toStartWith("approve");
    return readFileSync(join(roundDir(repo, "T1", 1), "prompt.md"), "utf8");
  }

  test("goes in the reviewer's prompt as things a change must not break", async () => {
    const prompt = await promptWith(["Merge a release PR. The user cuts every release."]);
    expect(prompt).toContain("- This repo's never list. A change that breaks one of these is an issue:\n  - Merge a release PR. The user cuts every release.\n");
  });

  test("adds nothing to the prompt when it's missing or empty", async () => {
    expect(await promptWith()).not.toContain("never list");
    expect(await promptWith([])).not.toContain("never list");
  });
});

describe("the usage limit", () => {
  const HIT = Date.parse("2026-11-25T14:00:00Z");
  const RESET = Date.parse("2026-11-25T15:45:00Z");
  const verdict = JSON.stringify({ structured_output: { ...changes, verdict: "approve", issues: [] } });
  const atLimit = JSON.stringify({ is_error: true, result: `Claude AI usage limit reached|${RESET / 1000}` });

  function reviewable() {
    const repo = tempRepo();
    withTasks(repo, (ts) => ts.push({ id: "T1", status: "done", branch: "main", base: "main", worktree: repo.root, owns: ["src/"], socket: "/nonexistent.sock", createdAt: "" }));
    mkdirSync(join(repo.foreman, "tasks", "T1"), { recursive: true });
    writeFileSync(join(repo.foreman, "tasks", "T1", "brief.md"), "## Intent\n\nx\n");
    saveConfig(repo, { budget: {} });
    let now = HIT;
    const calls: number[] = [];
    const said: string[] = [];
    const deps = (outputs: string[]) => ({
      reviewer: () => (calls.push(now), { code: 0, stdout: outputs.shift()!, stderr: "" }),
      sleep: async (ms: number) => void (now += ms),
      now: () => now,
      say: (l: string) => void said.push(l),
    });
    return { repo, calls, said, deps };
  }

  test("a review that hits the limit waits for the reset and runs the same round again", async () => {
    const { repo, calls, said, deps } = reviewable();
    const line = await runReview(repo, "T1", deps([atLimit, verdict]));
    expect(line).toStartWith("approve, round 1");
    expect(calls.length).toBe(2);
    expect(calls[1]).toBeGreaterThanOrEqual(RESET);
    expect(said[0]).toContain("so the review of T1 starts then");
    expect(findTask(repo, "T1").reviews).toBe(1);
    expect(readEvents(repo, "T1").map((e) => e.type)).toEqual(["reviewed"]);
  });

  test("a review started during the wait is held until the reset", async () => {
    const { repo, calls, deps } = reviewable();
    saveLimit(repo, { since: HIT, resetsAt: RESET, by: "T2", paused: ["T2"], announced: true });
    expect(await runReview(repo, "T1", deps([verdict]))).toStartWith("approve, round 1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(RESET);
  });
});

describe("the user's skills", () => {
  const approve = JSON.stringify({ structured_output: { ...changes, verdict: "approve", issues: [] } });
  const skill = (repo: ReturnType<typeof tempRepo>, name: string, description: string, body: string) => {
    mkdirSync(join(skillsDir(repo), name), { recursive: true });
    writeFileSync(join(skillsDir(repo), name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  };

  async function review(setup: (repo: ReturnType<typeof tempRepo>) => void = () => {}) {
    const repo = tempRepo();
    withTasks(repo, (ts) => ts.push({ id: "T1", status: "done", branch: "main", base: "main", worktree: repo.root, owns: ["src/"], socket: "/nonexistent.sock", createdAt: "" }));
    mkdirSync(join(repo.foreman, "tasks", "T1"), { recursive: true });
    writeFileSync(join(repo.foreman, "tasks", "T1", "brief.md"), "## Intent\n\nx\n");
    saveConfig(repo, { budget: {} });
    setup(repo);
    const commands: string[][] = [];
    const line = await runReview(repo, "T1", { reviewer: (cmd) => (commands.push(cmd), { code: 0, stdout: approve, stderr: "" }), say: () => {} });
    expect(line).toStartWith("approve");
    const schema = JSON.parse(commands[0]![commands[0]!.indexOf("--json-schema") + 1]!);
    return { repo, command: commands[0]!, schema, prompt: readFileSync(join(roundDir(repo, "T1", 1), "prompt.md"), "utf8") };
  }

  test("a code-review skill reaches the reviewer's prompt as rules to check", async () => {
    const { repo, prompt, command, schema } = await review((r) => skill(r, "code-review", "Review code in this repo. Use when reviewing a change.", "Every new function has a test."));
    expect(prompt).toContain("## The user's skills");
    expect(prompt).toContain("A change that breaks one is an issue, with the skill's name and the rule it breaks in `intent`.");
    expect(prompt).toContain(`### code-review\n\nReview code in this repo. Use when reviewing a change. From ${join(skillsDir(repo), "code-review", "SKILL.md")}.\n\nEvery new function has a test.`);
    expect(prompt).not.toContain("draft the PR");
    expect(command).toContain(skillsDir(repo));
    expect(schema.properties.pr).toBeUndefined();
    expect(prompt.trimEnd()).toEndWith("Return the verdict.");
  });

  test("a pull-request skill asks the reviewer for a PR draft", async () => {
    const { prompt, schema } = await review((r) => skill(r, "pull-request", "Write the PR.", "Sections: Summary, Why, How to test."));
    expect(prompt).toContain("When you approve, draft the PR's title and description in `pr`, following the pull-request skill.");
    expect(prompt).toContain("Sections: Summary, Why, How to test.");
    expect(schema.properties.pr.required).toEqual(["title", "description"]);
    expect(schema.required).not.toContain("pr");
  });

  test("nothing changes without a .foreman/skills folder", async () => {
    const { repo, prompt, command, schema } = await review();
    expect(prompt).not.toContain("skill");
    expect(command).not.toContain(skillsDir(repo));
    expect(schema).toEqual(VERDICT_SCHEMA);
  });
});
