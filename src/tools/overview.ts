import { costText } from "../cost.ts";
import { budgetOverview } from "../overview.ts";
import { statusText } from "../status.ts";
import { PLAIN } from "../style.ts";
import { summaryText } from "../summary.ts";
import { timelineText } from "../timeline.ts";
import { noInput, type Tool } from "./tool.ts";

export const OVERVIEW_TOOLS: Tool[] = [
  {
    name: "status",
    description: "Every task with its status, plus open permission blocks, the baseline and questions waiting on the user. Trust it over your memory after a restart.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    handler: (_args, s) => statusText(s.repo, PLAIN),
  },
  {
    name: "timeline",
    description: "The run in time order, grouped by task: starts, reports, reviews, nudges, restarts, PRs and merges, and the stretches where a worker went quiet.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "Show only this task, such as T3" } } },
    roles: ["orchestrator"],
    handler: (args, s) => timelineText(s.repo, args.task as string | undefined),
  },
  {
    name: "summary",
    description: "Write .foreman/summary.md: the open PRs in the order the user should review them, with how to test each one. Returns the file's path.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    handler: (_args, s) => summaryText(s.repo),
  },
  {
    name: "cost",
    description: "What each task has spent, split into its worker and its reviews, and the total against the plan's limit, at list prices.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    handler: (_args, s) => costText(s.repo),
  },
  {
    name: "budget",
    description: "What each task has spent against its limit, and what the plan has left.",
    inputSchema: noInput,
    roles: ["orchestrator"],
    handler: (_args, s) => budgetOverview(s.repo, PLAIN),
  },
];
