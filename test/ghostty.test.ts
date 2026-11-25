import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must, run } from "../src/exec.ts";
import { terminal } from "../src/integrations/index.ts";
import {
  appleScriptDisabled,
  controllingTty,
  ghostty,
  parseTab,
  shellQuote,
  surfaceCommand,
  versionAtLeast,
} from "../src/integrations/ghostty/index.ts";

const awkward = ["it's", "a b", "$HOME", "back\\slash", "", "--", "line\nbreak", "*"];

// Ghostty hands a tab's command to `bash -c "exec -l <command>"`, so the test runs it the same way.
const asGhosttyRuns = (command: string, env?: Record<string, string>) =>
  must(["/bin/bash", "--noprofile", "--norc", "-c", `exec -l ${command}`], { env });

test("FOREMAN_TERMINAL=ghostty selects this folder", () => {
  const term = terminal("ghostty");
  expect(term.name).toBe("Ghostty");
  expect(term.requires).toEqual(["osascript"]);
  expect(typeof term.checks).toBe("function");
});

test("Foreman picks Ghostty inside a Ghostty terminal without FOREMAN_TERMINAL", () => {
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "ghostty" }).name).toBe("Ghostty");
});

test("plain words stay unquoted and everything else survives the shell", () => {
  expect(shellQuote("claude")).toBe("claude");
  expect(shellQuote("FOREMAN_TASK=T5")).toBe("FOREMAN_TASK=T5");
  const printed = asGhosttyRuns(surfaceCommand(["/usr/bin/printf", "%s|", ...awkward], true));
  expect(printed).toBe(awkward.map((arg) => `${arg}|`).join(""));
});

test("a tab that shouldn't stay open closes itself through its own tty once the command exits", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-ghostty-"));
  // A stand-in osascript, so the test also holds on Linux, where CI runs.
  const fakeOsascript = join(dir, "osascript");
  writeFileSync(fakeOsascript, `#!/bin/sh\necho "$*"\n`);
  chmodSync(fakeOsascript, 0o755);
  const out = asGhosttyRuns(surfaceCommand(["/usr/bin/printf", "%s\\n", "ran it's"], false, "/foreman/ghostty.applescript"), {
    PATH: `${dir}:${process.env.PATH}`,
  });
  expect(out).toBe("ran it's\n/foreman/ghostty.applescript close-tty not a tty\n");
});

test("the tty is found by walking up past processes Claude Code detached from it", () => {
  const ps = [
    "    1     0 ??",
    "  500     1 ??",
    "  600   500 ttys030",
    "  700   600 ??",
    "  800   700 ??",
  ].join("\n");
  expect(controllingTty(ps, 800)).toBe("/dev/ttys030");
  expect(controllingTty(ps, 600)).toBe("/dev/ttys030");
  expect(controllingTty(ps, 500)).toBeUndefined();
  expect(controllingTty(ps, 999)).toBeUndefined();
});

test("the reply from open and split becomes a tab in the session it was opened from", () => {
  expect(parseTab("A-1", "tab-0x1\nT-2\n")).toEqual({ session: "A-1", window: "tab-0x1", pane: "T-2" });
  expect(() => parseTab("A-1", "")).toThrow("Ghostty didn't say which tab it opened");
});

test("only Ghostty 1.4 and later has what Foreman needs", () => {
  expect(versionAtLeast("1.4.0")).toBe(true);
  expect(versionAtLeast("1.10.0")).toBe(true);
  expect(versionAtLeast("2.0.0")).toBe(true);
  expect(versionAtLeast("1.3.1")).toBe(false);
  expect(versionAtLeast("")).toBe(false);
});

test("doctor notices AppleScript switched off in the Ghostty config", () => {
  expect(appleScriptDisabled("font-size = 13\nmacos-applescript = false\n")).toBe(true);
  expect(appleScriptDisabled("macos-applescript = true\n")).toBe(false);
  expect(appleScriptDisabled("font-size = 13\n")).toBe(false);
});

test("outside Ghostty there is no current session, and Ghostty isn't asked", () => {
  const before = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = "not-ghostty";
  try {
    expect(ghostty.currentSession()).toBeUndefined();
  } finally {
    process.env.TERM_PROGRAM = before;
  }
});

// Compiling reads Ghostty's dictionary from the app bundle and doesn't launch it.
test.skipIf(!existsSync("/Applications/Ghostty.app"))("the AppleScript compiles against Ghostty's dictionary", () => {
  const out = join(mkdtempSync(join(tmpdir(), "foreman-ghostty-")), "ghostty.scpt");
  const compiled = run(["osacompile", "-o", out, join(import.meta.dir, "..", "src", "integrations", "ghostty", "ghostty.applescript")]);
  expect(compiled.stderr).toBe("");
  expect(compiled.code).toBe(0);
});
