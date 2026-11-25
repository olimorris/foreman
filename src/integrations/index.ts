import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "../terminal.ts";

const DEFAULT_TERMINAL = "rex";

/** The folders here that hold an `index.ts`; the folder name is what `FOREMAN_TERMINAL` selects. */
export function availableTerminals(root = import.meta.dir): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "index.ts")))
    .map((entry) => entry.name)
    .sort();
}

export function terminal(name = process.env.FOREMAN_TERMINAL ?? DEFAULT_TERMINAL, root = import.meta.dir): Terminal {
  const available = availableTerminals(root);
  if (!available.includes(name)) {
    throw new Error(`there's no terminal integration called "${name}". Foreman has: ${available.join(", ")}`);
  }
  return load(name, join(root, name, "index.ts"));
}

// Only the selected folder is loaded, so a broken integration can't stop Foreman running in another terminal.
function load(name: string, file: string): Terminal {
  const exports = require(file) as Record<string, unknown>;
  const found = [exports[name], exports.default, ...Object.values(exports)].find(isTerminal);
  if (!found) throw new Error(`src/integrations/${name}/index.ts must export a Terminal, either as default or named "${name}"`);
  return found;
}

function isTerminal(value: unknown): value is Terminal {
  const candidate = value as Partial<Terminal> | undefined;
  return typeof candidate?.open === "function" && typeof candidate.close === "function" && typeof candidate.name === "string";
}
