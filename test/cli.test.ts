import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { cwd: tmpdir(), env: { ...process.env, NO_COLOR: "1" } });
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
};

test("foreman report says it's gone and points at the MCP tool", () => {
  const r = cli("report", "done", "built it");
  expect(r.err).toContain("report isn't a command anymore");
  expect(r.err).toContain("the report tool on Foreman's MCP server");
  expect(r.code).toBe(2);
});

test("an unknown command still says there's no such command", () => {
  const r = cli("frobnicate");
  expect(r.err).toContain(`there's no command "frobnicate"`);
  expect(r.code).toBe(2);
});

test("foreman help leaves out the commands agents call", () => {
  const r = cli("help");
  expect(r.code).toBe(0);
  for (const gone of ["report", "spawn", "watch", "baseline", "together", "tidy", "deliver"]) expect(r.out).not.toMatch(new RegExp(`^  ${gone}\\b`, "m"));
  expect(r.out).toMatch(/^  status \[--json\]/m);
});
