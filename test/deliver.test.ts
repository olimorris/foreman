import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deliver, modelName, renderPacket, section } from "../src/deliver.ts";
import { appendEvent, readEvents } from "../src/events.ts";
import { must } from "../src/exec.ts";
import { roundDir, type Verdict } from "../src/review.ts";
import { spawn } from "../src/spawn.ts";
import { findTask, updateTask } from "../src/state.ts";
import { sync } from "../src/sync.ts";
import { teardown } from "../src/teardown.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "{}");

const approve: Verdict = { verdict: "approve", summary: "Matches the intent.", issues: [], risk: "low", risk_note: "Copy change only.", decisions_touched: [] };
const noProbes = { fetch: () => {}, prState: () => undefined };

function setup(ids: string[]) {
  const repo = tempRepo();
  const term = fakeTerminal();
  for (const id of ids) {
    const brief = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
    writeFileSync(brief, `## Intent\n\nGreet in ${id}.\n\n## Spec\n\nWrite ${id}.txt.\n`);
    spawn(repo, { id, brief, owns: [`${id}.txt`], base: "main", session: "s" }, term);
  }
  const commit = (id: string) => {
    const wt = findTask(repo, id).worktree;
    writeFileSync(join(wt, `${id}.txt`), "hi\n");
    must(["git", "-C", wt, "add", "."]);
    must(["git", "-C", wt, "commit", "-qm", `add ${id}`]);
  };
  return { repo, term, commit };
}

test("section reads one Markdown section", () => {
  expect(section("# T\n\n## Intent\n\nDo it.\n\n## Spec\n\nHow.\n", "Intent")).toBe("Do it.");
  expect(section("## Spec\nx\n", "Intent")).toBe("");
});

test("the packet carries intent, change, screenshots, verdict and risk", () => {
  const { repo } = setup(["T1"]);
  const md = renderPacket({
    task: findTask(repo, "T1"), intent: "Greet.", doneNote: "Added a greeting", test: ["Open the app. It says hi."], assumptions: ["Hi, not hello."], stat: "1 file changed", verdict: approve, round: 2,
    decisions: ["D-1 Notes carry tags (accepted)"], shots: [{ name: "home", before: "https://x/b.png", after: "https://x/a.png" }],
    models: { worker: ["claude-opus-5-5", "claude-sonnet-5-5"], reviewer: ["claude-opus-5-5"] },
  });
  expect(md).toContain("Worker: Opus 5.5 and Sonnet 5.5. Reviewer: Opus 5.5.");
  expect(md).toContain("checked the diff and before and after screenshots against the intent above. It approved in round 2: Matches the intent.");
  expect(md).toContain("## Description\n\nGreet.");
  expect(md).toContain("## How to test\n\n1. Open the app. It says hi.");
  expect(md).toContain("## Assumptions\n\n- Hi, not hello.");
  expect(md).toContain("- D-1 Notes carry tags (accepted)");
  expect(md).toContain('| home | <img src="https://x/b.png" width="400"> | <img src="https://x/a.png" width="400"> |');
  expect(md).toContain("**low**: Copy change only.");
});

test("deliver refuses until the latest review approves, then writes the packet", () => {
  const { repo, commit } = setup(["T1"]);
  commit("T1");
  expect(() => deliver(repo, "T1", { dryRun: true })).toThrow("no finished review");
  mkdirSync(roundDir(repo, "T1", 1), { recursive: true });
  writeFileSync(join(roundDir(repo, "T1", 1), "verdict.json"), JSON.stringify({ ...approve, verdict: "changes" }));
  updateTask(repo, "T1", { reviews: 1 });
  expect(() => deliver(repo, "T1", { dryRun: true })).toThrow("asked for changes");
  writeFileSync(join(roundDir(repo, "T1", 1), "verdict.json"), JSON.stringify(approve));
  appendEvent(repo, "T1", "done", "Greets in T1");
  expect(() => deliver(repo, "T1")).toThrow("conventional commits");
  const r = deliver(repo, "T1", { title: "feat: greet in T1" });
  expect(r.note).toContain("no origin remote");
  const md = readFileSync(r.packet, "utf8");
  expect(md).toContain("Greet in T1.");
  expect(md).toContain("Greets in T1");
  expect(md).toContain("T1.txt");
});

test("sync marks a merged task, asks the others to rebase once, and teardown accepts the merge", () => {
  const { repo, term, commit } = setup(["T1", "T2", "T3"]);
  commit("T1");
  commit("T2");
  expect(sync(repo, "main", term, noProbes)).toMatchObject({ merged: [], asked: [] });

  must(["git", "-C", repo.root, "merge", "-q", "--no-ff", "-m", "merge T1", "foreman/T1"]);
  const r = sync(repo, "main", term, noProbes);
  expect(r.merged).toEqual(["T1"]);
  expect(r.asked.sort()).toEqual(["T2", "T3"]);
  expect(findTask(repo, "T1")).toMatchObject({ status: "merged" });
  const inbox = term.sent.join("\n");
  expect(inbox).toContain("Foreman message waiting");
  expect(sync(repo, "main", term, noProbes).asked).toEqual([]);

  expect(teardown(repo, "T1", false, term).removed).toBe(true);
});

test("sync trusts a merged PR even when the branch was squashed", () => {
  const { repo, term, commit } = setup(["T1"]);
  commit("T1");
  updateTask(repo, "T1", { pr: 7 });
  const r = sync(repo, "main", term, { fetch: () => {}, prState: (n) => (n === 7 ? "MERGED" : undefined) });
  expect(r.merged).toEqual(["T1"]);
  expect(readEvents(repo, "T1")).toEqual([]);
});

test("modelName turns model ids into the names people use", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
  expect(modelName("gpt-x")).toBe("gpt-x");
});
