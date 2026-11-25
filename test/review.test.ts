import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_REVISIONS, parseVerdict, renderFeedback, roundDir, sendFeedback, verdictLine, type Verdict } from "../src/review.ts";
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
