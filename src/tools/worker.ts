import { appendEvent, REPORT_TYPES, type ReportType } from "../events.ts";
import { propose } from "../ledger.ts";
import { changeNotes } from "../notes.ts";
import { names, tidy, unstoppableLine } from "../procs.ts";
import { findTask } from "../state.ts";
import { transition } from "../lifecycle.ts";
import type { Session, Tool } from "./tool.ts";

// The server is started with FOREMAN_TASK, so a missing one means Foreman started it wrong, not that the worker asked wrong.
function taskOf(session: Session): string {
  if (!session.task) throw new Error("FOREMAN_TASK isn't set: only workers report");
  return session.task;
}

// The schema has no arrays, and a step per line reads the same to an agent as a list.
const lines = (text: unknown) => (typeof text === "string" ? text.split("\n").map((l) => l.trim()).filter(Boolean) : []);

export const WORKER_TOOLS: Tool[] = [
  {
    name: "report",
    description: "Tell the orchestrator your task changed state: done when the intent is met and checks pass, blocked when you can't continue, needs-decision for a question for the user that isn't a cross-cutting decision, rebased after a rebase the orchestrator asked for. Report only when the state changes, then stop and wait.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "done, blocked, needs-decision or rebased" },
        summary: { type: "string", description: "One line: what you built, what stops you, your question, or what the rebase changed" },
        tests: { type: "string", description: "Needed for done. One step per line: how the user checks your work by hand, in the words they see on screen, with what to look for" },
        assumptions: { type: "string", description: "For done. One per line: each choice you made that the brief didn't settle, such as a default, a wording, an edge case or something left out" },
      },
      required: ["type", "summary"],
    },
    roles: ["worker"],
    handler: (args, s) => {
      const id = taskOf(s);
      const type = args.type as ReportType;
      if (!REPORT_TYPES.includes(type)) throw new Error(`type must be one of ${REPORT_TYPES.join(", ")}`);
      const summary = String(args.summary).trim();
      if (!summary) throw new Error("summary is empty. Say in one line what changed");
      const test = lines(args.tests);
      if (type === "done" && !test.length) {
        throw new Error("done needs at least one step in tests: how the user checks this by hand, in the words they see on screen. Add each choice the brief didn't settle to assumptions");
      }
      const assumptions = lines(args.assumptions);
      appendEvent(s.repo, id, type, summary, { test: test.length ? test : undefined, assumptions: assumptions.length ? assumptions : undefined });
      transition(s.repo, id, { type: "reported", report: type });
      return `reported ${type} for ${id}`;
    },
  },
  {
    name: "propose",
    description: "Propose a decision when your task needs a change outside your owned paths, or a choice that affects other tasks, such as a shared type, an API shape or a convention. Carry on with the parts of your work it doesn't block. You'll get a [foreman] message when it's accepted or rejected.",
    inputSchema: {
      type: "object",
      properties: {
        decision: { type: "string", description: "The decision, stated as fact" },
        body: { type: "string", description: "Why, and what you rejected" },
        paths: { type: "string", description: "The globs the decision covers, separated by spaces, such as src/tools/ test/tools.test.ts" },
      },
      required: ["decision", "body"],
    },
    roles: ["worker"],
    handler: (args, s) => {
      const by = taskOf(s);
      const paths = typeof args.paths === "string" ? args.paths.split(/\s+/).filter(Boolean) : [];
      const d = propose(s.repo, { title: String(args.decision).trim(), body: String(args.body), paths, supersedes: [], by });
      appendEvent(s.repo, by, "needs-decision", `${d.id} ${d.title}`);
      return `proposed ${d.id}. Carry on with the parts of your work it doesn't block.`;
    },
  },
  {
    name: "note",
    description: "Record a fact about the setup that every worker should know, such as a command that hangs, a flaky test or a test that already fails on the base branch, and send it to every running worker. Add one once you find a way past a hang or a failure that isn't yours. A note is a fact, not a decision.",
    inputSchema: {
      type: "object",
      properties: { fact: { type: "string", description: 'The fact, such as "swift test -j 3 deadlocks on main, use -j 1"' } },
      required: ["fact"],
    },
    roles: ["worker"],
    handler: (args, s) => {
      return changeNotes(s.repo, { add: String(args.fact) }, taskOf(s), s.term());
    },
  },
  {
    name: "tidy",
    description: "Stop the processes your task's runs left behind, such as a test runner still holding the build folder. Use it after a run times out or you kill one.",
    inputSchema: { type: "object", properties: {} },
    roles: ["worker"],
    handler: (_args, s) => {
      const id = taskOf(s);
      const r = tidy(findTask(s.repo, id));
      const out = [
        ...(r.stopped.length ? [`stopped what ${id}'s old runs left behind: ${names(r.stopped)}`] : []),
        ...(r.failed.length ? [unstoppableLine(r.failed)] : []),
      ];
      if (r.failed.length) throw new Error(out.join("\n"));
      return out.length ? out.join("\n") : `${id} has no processes left over from old runs`;
    },
  },
];
