import { protectedGlobs, type Config } from "./config.ts";

export const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: \S/;

export const plainTitle = (title: string) => title.replace(/^\w+(\([\w./-]+\))?!?:\s*/, "").trim();

export function checkBrief(text: string): void {
  for (const heading of ["## Intent", "## Spec"]) {
    if (!text.split("\n").some((l) => l.trim() === heading)) throw new Error(`brief is missing a "${heading}" section`);
  }
}

const ALIASES = ["sonnet", "opus", "haiku", "fable", "opusplan", "default"];

// Claude Code only checks the name once the worker starts, and a misspelt "sonet" saved on the task would break every resume and restart after that.
export function checkModel(model: string): void {
  if (!model) throw new Error("the model is empty. Name one, like sonnet, opus or haiku");
  const alias = ALIASES.includes(model.replace(/\[1m\]$/, ""));
  const id = /^[A-Za-z0-9][\w.:@\/[\]-]*$/.test(model) && /^claude-|anthropic|^arn:/.test(model);
  if (!alias && !id) throw new Error(`"${model}" isn't a model name. Use sonnet, opus, haiku, fable, opusplan or default, or a full id like claude-sonnet-5-5`);
}

export function protectedLines(config: Config): string[] {
  const protect = protectedGlobs(config);
  if (!protect.length) return [];
  return [`- Protected paths: ${protect.map((g) => `\`${g}\``).join(", ")}. You can edit these, but a PR that touches one never automerges and stays with the user`];
}
