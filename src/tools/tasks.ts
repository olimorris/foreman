import { terminal } from "../integrations/index.ts";
import type { TaskTool } from "../mcp.ts";
import { defaultBase } from "../paths.ts";
import { watchFor } from "../watch.ts";
import { noInput } from "./tool.ts";

export const TASK_TOOLS: TaskTool[] = [
  {
    name: "watch",
    description: "Watch the run until something needs you: a worker reports, goes quiet or exits, main moves, a PR changes, a question or permission block arrives, or the budget runs over. Returns at once as a task, and its result wakes you with one line naming what happened. Call it again after handling that line.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    task: true,
    handler: async (_args, s, context) => (await watchFor(s.repo, defaultBase(s.repo), terminal(), { signal: context?.signal, notice: context?.status })).line,
  },
];
