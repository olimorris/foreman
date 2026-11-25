import { OVERVIEW_TOOLS } from "./overview.ts";
import type { Tool } from "./tool.ts";
import { WORKER_TOOLS } from "./worker.ts";

export const TOOLS: Tool[] = [...OVERVIEW_TOOLS, ...WORKER_TOOLS];
