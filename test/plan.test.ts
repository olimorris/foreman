import { describe, expect, test } from "bun:test";
import { parsePlan, readyTasks, sharedPaths, validatePlan, waves, type Plan } from "../src/plan.ts";
import type { Task } from "../src/state.ts";

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

test("task titles must be conventional commits, because they become PR titles", () => {
  const p = parsePlan("# P\n\n## A: Add tags\n- Owns: x\n\n### Intent\ni\n\n### Spec\ns\n");
  expect(validatePlan(p)).toEqual(['A\'s title becomes its PR title, so it must be a conventional commit, like "feat: add tags to notes"']);
});
