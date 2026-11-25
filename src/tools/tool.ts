import type { Repo } from "../paths.ts";
import type { Terminal } from "../terminal.ts";

export type Role = "orchestrator" | "worker";

// term is lazy, since most tools never open a tab and finding the terminal runs its detection.
export type Session = { role?: Role; task?: string; repo: Repo; term: () => Terminal };

export type Schema = { type: "object"; properties: Record<string, { type: "string" | "number" | "integer" | "boolean"; description: string }>; required?: string[] };

export type Args = Record<string, unknown>;

export type Tool = {
  name: string;
  description: string;
  inputSchema: Schema;
  roles: Role[];
  handler: (args: Args, session: Session) => string | Promise<string>;
};

export const noInput: Schema = { type: "object", properties: {} };

export function asRole(value: string | undefined): Role | undefined {
  return value === "orchestrator" || value === "worker" ? value : undefined;
}

export function toolsFor(tools: Tool[], role: Role | undefined): Tool[] {
  return role ? tools.filter((t) => t.roles.includes(role)) : [];
}
