import type { Terminal } from "../terminal.ts";
import { rex } from "./rex/index.ts";

export const TERMINALS: Record<string, Terminal> = { rex };

export function terminal(name = process.env.FOREMAN_TERMINAL ?? "rex"): Terminal {
  const term = TERMINALS[name];
  if (!term) throw new Error(`there's no terminal integration called "${name}". Foreman has: ${Object.keys(TERMINALS).join(", ")}`);
  return term;
}
