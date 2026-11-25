import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goneText, GROUPS, helpText, ON_THE_SERVER, styleFor, usageError } from "../src/help.ts";

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
  expect(usageError("resume").message).toStartWith("usage: foreman resume <task> [--model <name>]");
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

test("the help lists only the commands people use, plus the two Claude Code runs", () => {
  const commands = new Set(GROUPS.flatMap((g) => g.commands.map((c) => c.usage.split(" ")[0])));
  expect([...commands].sort()).toEqual(["automerge", "budget", "cost", "doctor", "hook", "mcp", "note", "notes", "pane", "remove", "restart", "resume", "status", "summary", "timeline", "up", "version", "workers"]);
});

test("a command that moved to the MCP server says so and names the tool", () => {
  expect(goneText("report")).toBe("foreman: report isn't a command anymore. The orchestrator and workers call the report tool on Foreman's MCP server instead. Run foreman help to see the commands for people.");
  for (const cmd of ["watch", "baseline", "together", "tidy", "spawn", "deliver"]) expect(goneText(cmd)).toContain(`the ${cmd} tool`);
  expect(goneText("status")).toBeUndefined();
  expect(goneText("frobnicate")).toBeUndefined();
});

test("no string in src names a foreman command that moved to the MCP server", () => {
  const src = join(import.meta.dir, "..", "src");
  // Transpiling drops comments, so only text a caller can see is checked.
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const named = new RegExp(`foreman (${ON_THE_SERVER.join("|")})(?![\\w-])`, "g");
  const found: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(src)) {
    const code = transpiler.transformSync(readFileSync(join(src, file), "utf8"));
    for (const m of code.matchAll(named)) found.push(`${file}: ${m[0]}`);
  }
  expect(found).toEqual([]);
});
