import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Result } from "../src/exec.ts";
import { terminal } from "../src/integrations/index.ts";
import {
  errorText,
  findWorkspace,
  firstPane,
  herdrChecks,
  herdrTerminal,
  launchScript,
  parseAlive,
  parseOpened,
  parseVersion,
  quote,
  serverRunning,
  typedCommand,
  versionAtLeast,
} from "../src/integrations/herdr/index.ts";

const ok = (result: unknown): Result => ({ code: 0, stdout: JSON.stringify({ id: "cli:request", result }), stderr: "" });
const done: Result = { code: 0, stdout: "", stderr: "" };
const failed = (code: string, message: string): Result => ({
  code: 1,
  stdout: "",
  stderr: JSON.stringify({ id: "cli:request", error: { code, message } }),
});

const pane = (pane_id: string, tab_id = "w1:t2") => ({ pane_id, tab_id, workspace_id: "w1", terminal_id: "term-1", focused: false, agent_status: "none", revision: 0 });
const tabCreated = ok({ type: "tab_created", tab: { tab_id: "w1:t2", workspace_id: "w1", label: "T1 tags" }, root_pane: pane("w1:p3") });
const workspaceCreated = ok({ type: "workspace_created", workspace: { workspace_id: "w1", label: "foreman-app" }, tab: { tab_id: "w1:t1" }, root_pane: pane("w1:p1", "w1:t1") });
const split = ok({ type: "pane_info", pane: pane("w1:p2", "w1:t1") });

function fakeHerdr(replies: Record<string, Result>) {
  const calls: string[][] = [];
  const scripts: { cwd: string; cmd: string[] }[] = [];
  const term = herdrTerminal(
    (cmd) => (calls.push(cmd), replies[cmd.slice(1, 3).join(" ")] ?? failed("unknown", `no reply for ${cmd.join(" ")}`)),
    (cwd, cmd) => (scripts.push({ cwd, cmd }), "/tmp/foreman-herdr-x/launch.sh"),
  );
  return { term, calls, scripts };
}

test("Herdr is selectable by its folder name", () => {
  expect(terminal("herdr").name).toBe("Herdr");
  expect(terminal("herdr").requires).toEqual(["herdr"]);
});

test("a worker opens as a tab in the orchestrator's workspace without taking focus, then runs its launch script", () => {
  const { term, calls, scripts } = fakeHerdr({ "tab create": tabCreated, "pane run": done });
  const tab = term.open("w1", "T1 tags", "/code/app/.foreman/worktrees/T1", ["claude", "-n", "T1"]);
  expect(tab).toEqual({ session: "w1", window: "w1:t2", pane: "w1:p3" });
  expect(calls).toEqual([
    ["herdr", "tab", "create", "--workspace", "w1", "--cwd", "/code/app/.foreman/worktrees/T1", "--label", "T1 tags", "--no-focus"],
    ["herdr", "pane", "run", "w1:p3", "exec /bin/sh '/tmp/foreman-herdr-x/launch.sh'"],
  ]);
  expect(scripts).toEqual([{ cwd: "/code/app/.foreman/worktrees/T1", cmd: ["claude", "-n", "T1"] }]);
});

test("foreman up opens the orchestrator in a new, focused workspace labelled with the session name", () => {
  const { term, calls } = fakeHerdr({ "workspace create": workspaceCreated, "pane run": done });
  expect(term.newSession("foreman-app", "/code/app", ["claude"])).toBe("w1");
  expect(calls[0]).toEqual(["herdr", "workspace", "create", "--cwd", "/code/app", "--label", "foreman-app", "--focus"]);
  expect(calls[1]?.slice(0, 4)).toEqual(["herdr", "pane", "run", "w1:p1"]);
});

test("the status pane splits the given pane to the right, keeps focus where it was and takes about a third", () => {
  const { term, calls } = fakeHerdr({ "pane split": split, "pane rename": done, "pane run": done });
  expect(term.openBeside!("w1", "w1:p1", "status", "/code/app", ["foreman", "pane", "--live"])).toEqual({ session: "w1", window: "w1:t1", pane: "w1:p2" });
  expect(calls.slice(0, 2)).toEqual([
    ["herdr", "pane", "split", "w1:p1", "--direction", "right", "--ratio", "0.65", "--cwd", "/code/app", "--no-focus"],
    ["herdr", "pane", "rename", "w1:p2", "status"],
  ]);
});

test("without an anchor the status pane opens beside the workspace's first pane", () => {
  const { term, calls } = fakeHerdr({
    "pane list": ok({ type: "pane_list", panes: [pane("w1:p1", "w1:t1"), pane("w1:p3")] }),
    "pane split": split,
    "pane rename": done,
    "pane run": done,
  });
  term.openBeside!("w1", undefined, "status", "/code/app", ["foreman", "pane", "--live"]);
  expect(calls[0]).toEqual(["herdr", "pane", "list", "--workspace", "w1"]);
  expect(calls[1]?.[3]).toBe("w1:p1");
});

test("a failed request says what Herdr said, not its JSON", () => {
  const { term } = fakeHerdr({ "tab create": failed("workspace_not_found", "workspace w9 not found") });
  expect(() => term.open("w9", "T1", "/code/app", ["claude"])).toThrow("herdr tab create failed (1): workspace w9 not found");
  expect(errorText({ code: 1, stdout: "", stderr: "server not running\n" })).toBe("server not running");
});

test("send types the text, then presses Enter as a separate key, and close closes the one pane", () => {
  const { term, calls } = fakeHerdr({ "pane send-text": done, "pane send-keys": done, "pane close": ok({ type: "ok" }) });
  const tab = { session: "w1", window: "w1:t2", pane: "w1:p3" };
  term.send(tab, "rebase please");
  term.close(tab);
  expect(calls).toEqual([
    ["herdr", "pane", "send-text", "w1:p3", "rebase please"],
    ["herdr", "pane", "send-keys", "w1:p3", "enter"],
    ["herdr", "pane", "close", "w1:p3"],
  ]);
});

test("the current session and pane come from the ids Herdr sets in each pane", () => {
  const before = { ws: process.env.HERDR_WORKSPACE_ID, pane: process.env.HERDR_PANE_ID };
  try {
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
    expect(herdrTerminal().currentSession()).toBe("w1");
    expect(herdrTerminal().currentPane!()).toBe("w1:p1");
    process.env.HERDR_WORKSPACE_ID = "";
    expect(herdrTerminal().currentSession()).toBeUndefined();
  } finally {
    for (const [key, value] of [["HERDR_WORKSPACE_ID", before.ws], ["HERDR_PANE_ID", before.pane]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a worker is alive while Herdr still knows its pane", () => {
  expect(parseAlive(ok({ type: "pane_info", pane: pane("w1:p3") }))).toBe(true);
  expect(parseAlive(failed("pane_not_found", "pane w1:p3 not found"))).toBe(false);
  expect(parseAlive({ code: 0, stdout: "not json", stderr: "" })).toBe(false);
  const { term, calls } = fakeHerdr({ "pane get": ok({ type: "pane_info", pane: pane("w1:p3") }) });
  expect(term.alive({ session: "w1", window: "w1:t2", pane: "w1:p3" })).toBe(true);
  expect(calls[0]).toEqual(["herdr", "pane", "get", "w1:p3"]);
});

test("findSession finds the workspace by its label, and nothing when Herdr isn't reachable", () => {
  const listing = ok({ type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "api" }, { workspace_id: "w4", label: "foreman-app" }] });
  expect(findWorkspace(listing.stdout, "foreman-app")).toBe("w4");
  expect(findWorkspace(listing.stdout, "missing")).toBeUndefined();
  expect(fakeHerdr({ "workspace list": failed("server_not_running", "herdr server is not running") }).term.findSession("foreman-app")).toBeUndefined();
});

test("parseOpened refuses a reply with no pane, and firstPane reads an empty workspace as none", () => {
  expect(() => parseOpened(ok({ type: "tab_created", tab: {} }).stdout)).toThrow("didn't say which pane");
  expect(firstPane(ok({ type: "pane_list", panes: [] }).stdout)).toBeUndefined();
});

test("doctor checks Herdr's version and that its server is running", () => {
  const replies = (version: string, status: string) => (cmd: string[]): Result =>
    cmd[1] === "--version" ? { code: 0, stdout: version, stderr: "" } : { code: 0, stdout: status, stderr: "" };
  expect(herdrChecks(replies("herdr 0.9.5\n", "status: running\nversion: 0.9.5\n"))).toEqual([
    { name: "herdr version", ok: true, detail: "0.9.5" },
    { name: "herdr server", ok: true, detail: "running" },
  ]);
  const old = herdrChecks(replies("herdr 0.6.10\n", "status: not running\nsocket: /tmp/herdr.sock\n"));
  expect(old.map((c) => c.ok)).toEqual([false, false]);
  expect(old[0]!.detail).toContain("need Herdr 0.7.0+, found 0.6.10");
  expect(herdrChecks(() => ({ code: 127, stdout: "", stderr: "not found" }))).toEqual([]);
});

test("versions compare part by part", () => {
  expect(parseVersion("herdr 0.10.0")).toEqual([0, 10, 0]);
  expect(versionAtLeast([0, 10, 0])).toBe(true);
  expect(versionAtLeast([0, 7, 0])).toBe(true);
  expect(versionAtLeast([0, 6, 99])).toBe(false);
  expect(serverRunning("status: running\n")).toBe(true);
  expect(serverRunning("status: not running\n")).toBe(false);
});

test("the typed line refuses a script path a shell would read differently", () => {
  expect(typedCommand("/tmp/a b/launch.sh")).toBe("exec /bin/sh '/tmp/a b/launch.sh'");
  expect(() => typedCommand("/tmp/it's/launch.sh")).toThrow("can't hand Herdr a script path");
});

test("the launch script runs the command in its folder, removes itself and keeps every argument whole", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "foreman-herdr-test-")));
  const dir = mkdtempSync(join(root, "launch-"));
  const cwd = mkdtempSync(join(root, "it's a worktree-"));
  const script = join(dir, "launch.sh");
  const out = join(root, "out");
  const prompt = `Your brief is "x". Don't stop; $HOME isn't expanded \\ and 'quotes' stay`;
  writeFileSync(script, launchScript(dir, cwd, ["sh", "-c", `pwd > ${quote(out)}; printf '%s' "$1" >> ${quote(out)}`, "sh", prompt]));
  const r = run(["/bin/sh", script]);
  expect(r.code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe(`${cwd}\n${prompt}`);
  expect(existsSync(dir)).toBe(false);
});
