import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUPS, helpText, styleFor, usageError } from "../src/help.ts";

test("every command in the help fits on one line, so the descriptions line up", () => {
  const text = helpText(styleFor({ isTTY: false }), undefined);
  for (const line of text.split("\n").filter((l) => l.startsWith("  "))) expect(line).toMatch(/^  \S.{0,22}\S?\s{2,}\S/);
  expect(text).not.toContain("\x1b[");
});

test("a usage error lists only that command's forms, with their full flags", () => {
  expect(usageError("budget").message.split("\n").slice(0, 4)).toEqual([
    "usage: foreman budget",
    "       foreman budget <usd>",
    "       foreman budget <task> <usd>",
    "       foreman budget --plan <usd>",
  ]);
  expect(usageError("workers").message.split("\n").slice(0, 2)).toEqual(["usage: foreman workers", "       foreman workers <n>"]);
  expect(usageError("automerge").message.split("\n").slice(0, 2)).toEqual(["usage: foreman automerge", "       foreman automerge on|off"]);
  expect(usageError("deliver").message).toStartWith('usage: foreman deliver <task> [--title "<type>: <summary>"] [--dry-run]');
});

test("each command name appears once per form", () => {
  const usages = GROUPS.flatMap((g) => g.commands.map((c) => c.usage));
  expect(new Set(usages).size).toBe(usages.length);
});

test("--version and version print the version in plugin.json, from any directory", () => {
  const root = join(import.meta.dir, "..");
  const expected = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
  for (const arg of ["--version", "version"]) {
    const p = Bun.spawnSync(["bun", join(root, "src", "cli.ts"), arg], { cwd: tmpdir() });
    expect(p.stdout.toString().trim()).toBe(expected);
    expect(p.exitCode).toBe(0);
  }
});

test("the help lists the version command", () => {
  expect(helpText(styleFor({ isTTY: false }), undefined)).toMatch(/^  version\s+Print the installed version/m);
});
