import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveConfig } from "../src/config.ts";
import { UsageError } from "../src/help.ts";
import { checkModel } from "../src/spawn.ts";
import { describePlan, loadPlan, maxWorkers, parsePlan, readyTasks, savePlan, sharedPaths, validatePlan, waves, workers, type Plan } from "../src/plan.ts";
import { withTasks, type Task } from "../src/state.ts";
import { tempRepo } from "./helpers.ts";

const PLAN = `# Plan: Notes, tags and polish
Deadline: Friday 28 November

## T1: feat: notes carry tags
- Owns: src/types.ts, src/data.ts
- Contract: yes

### Intent
Notes have tags.

### Spec
Add tags to Note.

## T2: feat: tag filter
- Owns: src/views/list.ts
- Depends on: T1

### Intent
Filter by tag.

### Spec
Read ?tag.

### Screens
- tagged: /?tag=work

## T3: feat: search box
- Owns: src/views/list.ts

### Intent
Search notes.

### Spec
Add a box.

## T4: feat(layout): footer count
- Owns: src/views/layout.ts
- Model: \`haiku\`

### Intent
Show the count.

### Spec
Footer.
`;

const task = (id: string, owns: string[], extra: Partial<Task> = {}): Task =>
  ({ id, status: "running", branch: `foreman/${id}`, base: "main", worktree: "/w", owns, socket: "/s", createdAt: "" , ...extra });

describe("parsePlan", () => {
  test("reads the title, deadline, fields and brief of each task", () => {
    const p = parsePlan(PLAN);
    expect(p.title).toBe("Notes, tags and polish");
    expect(p.deadline).toBe("Friday 28 November");
    expect(p.tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(p.tasks[0]).toMatchObject({ title: "feat: notes carry tags", owns: ["src/types.ts", "src/data.ts"], deps: [], contract: true });
    expect(p.tasks[1]!.deps).toEqual(["T1"]);
    expect(p.tasks[3]!.model).toBe("haiku");
    expect("model" in p.tasks[0]!).toBe(false);
    expect(p.tasks[1]!.brief).toContain("## Intent\nFilter by tag.");
    expect(p.tasks[1]!.brief).toContain("## Screens\n- tagged: /?tag=work");
    expect(validatePlan(p)).toEqual([]);
  });

  test("validation names unknown dependencies, cycles, missing paths and missing sections", () => {
    const bad = parsePlan("# P\n\n## A: fix: a\n- Owns: x\n- Depends on: B\n\n### Intent\ni\n\n### Spec\ns\n\n## B: fix: b\n- Owns: y\n- Depends on: A\n\n### Intent\ni\n\n### Spec\ns\n");
    expect(validatePlan(bad)).toEqual(["dependency cycle among A, B"]);
    const worse = parsePlan("# P\n\n## A: fix: a\n- Depends on: Z\n\n### Spec\ns\n");
    expect(validatePlan(worse)).toEqual(["A owns no paths", 'A: its brief is missing a "## Intent" section', "A depends on Z, which isn't in the plan"]);
  });

  test("waves put contracts first and note tasks that share paths", () => {
    const p = parsePlan(PLAN);
    expect(waves(p)).toEqual([["T1", "T3", "T4"], ["T2"]]);
    expect(sharedPaths(p)).toEqual(["T2 and T3 own overlapping paths, so they run one after the other"]);
  });
});

describe("readyTasks", () => {
  const p: Plan = parsePlan(PLAN);

  test("starts contracts first and holds dependents until their dependency merges", () => {
    const r = readyTasks(p, [], 2);
    expect(r.start.map((t) => t.id)).toEqual(["T1", "T3"]);
    expect(r.waiting).toEqual([
      { id: "T2", reason: "waits for T1 to merge" },
      { id: "T4", reason: "all 2 worker slots are busy" },
    ]);
  });

  test("a merged task frees its slot and unblocks dependents, but shared paths still wait", () => {
    const tasks = [task("T1", ["src/types.ts"], { status: "merged", mergedAt: "now" }), task("T3", ["src/views/list.ts"])];
    const r = readyTasks(p, tasks, 3);
    expect(r.start.map((t) => t.id)).toEqual(["T4"]);
    expect(r.waiting).toEqual([{ id: "T2", reason: "shares paths with T3" }]);
  });

  test("a torn-down task that never merged doesn't unblock its dependents", () => {
    const r = readyTasks(p, [task("T1", ["src/types.ts"], { status: "torn-down" })], 3);
    expect(r.waiting.find((w) => w.id === "T2")?.reason).toBe("waits for T1 to merge");
  });
});

test("a task's model shows in the plan, and a line that isn't a model name is refused", () => {
  expect(describePlan(parsePlan(PLAN))).toContain("wave 1: T1 (contract), T3, T4 (haiku)");
  expect(describePlan(parsePlan(PLAN))).toContain("tasks with no Model line run on Claude Code's default model");
  const withDefault = describePlan(parsePlan(PLAN), "sonnet");
  expect(withDefault).toContain("wave 1: T1 (contract, sonnet), T3 (sonnet), T4 (haiku)");
  expect(withDefault).toContain("tasks with no Model line run on sonnet, from workerModel in .foreman/config.json");
  const plan = (model: string) => validatePlan(parsePlan(`# P\n\n## A: fix: a\n- Owns: x\n- Model: ${model}\n\n### Intent\ni\n\n### Spec\ns\n`));
  expect(plan("sonnet, it's small")).toEqual([`A: "sonnet, it's small" isn't a model name. Use sonnet, opus, haiku, fable, opusplan or default, or a full id like claude-sonnet-5-5`]);
  expect(plan("sonet")).toHaveLength(1);
  expect(plan("us.anthropic.claude-sonnet-5-5-v1:0")).toEqual([]);
});

test("task titles must be conventional commits, because they become PR titles", () => {
  const p = parsePlan("# P\n\n## A: Add tags\n- Owns: x\n\n### Intent\ni\n\n### Spec\ns\n");
  expect(validatePlan(p)).toEqual(['A\'s title becomes its PR title, so it must be a conventional commit, like "feat: add tags to notes"']);
});

test("checkModel takes Claude Code's aliases and full ids, and nothing that looks like a typo", () => {
  for (const ok of ["sonnet", "opus", "haiku", "fable", "opusplan", "default", "sonnet[1m]", "claude-sonnet-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-sonnet-5-5-v1:0", "arn:aws:bedrock:us-east-1:123:inference-profile/x"]) {
    expect(() => checkModel(ok)).not.toThrow();
  }
  for (const bad of ["sonet", "Sonnet please", "gpt-5", "-x", "sonnet[2m]"]) expect(() => checkModel(bad)).toThrow("isn't a model name");
  expect(() => checkModel("")).toThrow("the model is empty");
});

describe("foreman workers", () => {
  const option = process.env.CLAUDE_PLUGIN_OPTION_MAXWORKERS;
  beforeEach(() => void delete process.env.CLAUDE_PLUGIN_OPTION_MAXWORKERS);
  afterEach(() => void (option === undefined ? delete process.env.CLAUDE_PLUGIN_OPTION_MAXWORKERS : (process.env.CLAUDE_PLUGIN_OPTION_MAXWORKERS = option)));

  test("the plan's limit wins over the config, and --max wins over the plan for one call", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    saveConfig(repo, { maxWorkers: 2 });
    expect(workers(repo, ["5"])).toEqual(["5 workers at once until this plan finishes"]);
    expect(maxWorkers(repo)).toBe(5);
    expect(maxWorkers(repo, "1")).toBe(1);
  });

  test("approving the plan keeps the limit, and a new plan drops it", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    workers(repo, ["6"]);
    savePlan(repo, { ...loadPlan(repo)!, approvedAt: "now" });
    expect(maxWorkers(repo)).toBe(6);
    savePlan(repo, parsePlan(PLAN));
    expect(maxWorkers(repo)).toBe(3);
  });

  test("with no number it names where the limit comes from", () => {
    const repo = tempRepo();
    expect(workers(repo, [])).toEqual(["3 workers at once, from Foreman's default"]);
    process.env.CLAUDE_PLUGIN_OPTION_MAXWORKERS = "4";
    expect(workers(repo, [])).toEqual(["4 workers at once, from the plugin's maxWorkers option"]);
    saveConfig(repo, { maxWorkers: 2 });
    expect(workers(repo, [])).toEqual(["2 workers at once, from maxWorkers in .foreman/config.json"]);
    savePlan(repo, parsePlan(PLAN));
    workers(repo, ["1"]);
    expect(workers(repo, [])).toEqual(["1 worker at once, from this plan, set with foreman workers"]);
  });

  test("raising the limit says how to start waiting tasks, and lowering it stops nothing", () => {
    const repo = tempRepo();
    savePlan(repo, { ...parsePlan(PLAN), approvedAt: "now" });
    withTasks(repo, (tasks) => void tasks.push(task("T1", ["src/types.ts"]), task("T3", ["src/views/list.ts"])));
    expect(workers(repo, ["2"])).toEqual(["2 workers at once until this plan finishes"]);
    expect(workers(repo, ["3"])).toEqual(["3 workers at once until this plan finishes", "waiting tasks start when the orchestrator next calls next"]);
    expect(workers(repo, ["1"])).toEqual(["1 worker at once until this plan finishes", "2 tasks already hold a slot. None of them stops, and new tasks wait until fewer than 1 do"]);
  });

  test("a non-number, zero or negative is a usage error", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    for (const bad of ["lots", "0", "-2", "1.5", ""]) expect(() => workers(repo, [bad])).toThrow(UsageError);
    expect(() => workers(repo, ["2", "3"])).toThrow(UsageError);
    expect(maxWorkers(repo)).toBe(3);
  });

  test("setting a limit with no plan stored says the orchestrator stores one, without naming a removed command", () => {
    expect(() => workers(tempRepo(), ["4"])).toThrow("no plan. This sets the limit for the current plan, and the orchestrator stores one with the plan tool");
  });
});
