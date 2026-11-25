import { ORCHESTRATOR_TOOLS } from "./orchestrator.ts";
import { OVERVIEW_TOOLS } from "./overview.ts";
import { TASK_TOOLS } from "./tasks.ts";
import type { Tool } from "./tool.ts";
import { WORKER_TOOLS } from "./worker.ts";

export const TOOLS: Tool[] = [...OVERVIEW_TOOLS, ...ORCHESTRATOR_TOOLS, ...TASK_TOOLS, ...WORKER_TOOLS];
