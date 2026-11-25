import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Env, Terminal } from "../terminal.ts";

const DEFAULT_TERMINAL = "rex";

/** The folders here that hold an `index.ts`; the folder name is what `FOREMAN_TERMINAL` selects. */
export function availableTerminals(root = import.meta.dir): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "index.ts")))
    .map((entry) => entry.name)
    .sort();
}

/** `FOREMAN_TERMINAL` if set, else the integration whose terminal this process runs inside, else Rex. */
export function terminal(name?: string, root = import.meta.dir, env: Env = process.env): Terminal {
  const available = availableTerminals(root);
  name ||= env.FOREMAN_TERMINAL || detect(available, root, env) || DEFAULT_TERMINAL;
  if (!available.includes(name)) {
    throw new Error(`there's no terminal integration called "${name}". Foreman has: ${available.join(", ")}`);
  }
  return load(name, root);
}

function detect(available: string[], root: string, env: Env): string | undefined {
  const claimed = available.filter((name) => claims(name, root, env));
  if (claimed.length > 1) {
    const names = `${claimed.slice(0, -1).join(", ")} and ${claimed.at(-1)}`;
    const match = claimed.length === 2 ? `both ${names} match` : `${names} all match`;
    throw new Error(`Foreman can't tell which terminal it's in: ${match}. Set FOREMAN_TERMINAL to the one you're running in`);
  }
  return claimed[0];
}

// A folder that fails to load just doesn't claim, so a broken integration can't stop Foreman running in another terminal.
function claims(name: string, root: string, env: Env): boolean {
  try {
    return load(name, root).inside?.(env) === true;
  } catch {
    return false;
  }
}

function load(name: string, root: string): Terminal {
  const exports = require(join(root, name, "index.ts")) as Record<string, unknown>;
  const found = [exports[name], exports.default, ...Object.values(exports)].find(isTerminal);
  if (!found) throw new Error(`src/integrations/${name}/index.ts must export a Terminal, either as default or named "${name}"`);
  return found;
}

function isTerminal(value: unknown): value is Terminal {
  const candidate = value as Partial<Terminal> | undefined;
  return typeof candidate?.open === "function" && typeof candidate.close === "function" && typeof candidate.name === "string";
}
