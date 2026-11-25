import { BASELINE_RUNS, runBaseline } from "../baseline.ts";
import { terminal } from "../integrations/index.ts";
import type { TaskTool } from "../mcp.ts";
import { defaultBase } from "../paths.ts";
import { openPrs } from "../summary.ts";
import { together } from "../together.ts";
import { watchFor, type WaitForChange } from "../watch.ts";
import { noInput } from "./tool.ts";

// Tests pass their own wait, since the watcher otherwise waits on fswatch, which CI runners lack.
export const taskTools = (wait?: WaitForChange): TaskTool[] => [
  {
    name: "watch",
    description: "Watch the run until something needs you: a worker reports, goes quiet or exits, main moves, a PR changes, a question or permission block arrives, or the budget runs over. Returns at once as a task, and its result wakes you with one line naming what happened. Call it again after handling that line.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    task: true,
    handler: (_args, s, context) => watchFor(s.repo, defaultBase(s.repo), terminal(), { signal: context?.signal, notice: context?.status, wait }),
  },
  {
    name: "baseline",
    description: "Run the repo's test command on the base branch and note what hangs or fails there. The notes reach the running workers. Returns at once as a task, and its result wakes you with one line saying how the runs went.",
    inputSchema: {
      type: "object",
      properties: {
        test: { type: "string", description: "The command that runs the repo's tests. Saved to .foreman/config.json, so give it only the first time or to change it" },
        runs: { type: "integer", description: `How many times to run the tests, to tell flaky tests from failing ones. ${BASELINE_RUNS} by default` },
      },
    },
    roles: ["orchestrator"],
    task: true,
    handler: (args, s, context) =>
      runBaseline(s.repo, { base: defaultBase(s.repo), term: terminal(), test: args.test as string | undefined, runs: args.runs as number | undefined, signal: context?.signal }),
  },
  {
    name: "together",
    description: "Merge every open PR into a throwaway worktree, in review order, and run the repo's tests on the result. Returns at once as a task, and its result wakes you with one together: line.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    task: true,
    handler: async (_args, s, context) => (await together(s.repo, defaultBase(s.repo), () => openPrs(s.repo), { fetch: true, signal: context?.signal })).line,
  },
];

export const TASK_TOOLS = taskTools();
