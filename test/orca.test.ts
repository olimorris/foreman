import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Result } from "../src/exec.ts";
import { terminal } from "../src/integrations/index.ts";
import {
  createArgs,
  findTabWorkspace,
  launchScript,
  orcaTerminal,
  parseAlive,
  parseCreate,
  quote,
  typedCommand,
} from "../src/integrations/orca/index.ts";

const ok = (result: unknown): Result => ({ code: 0, stdout: JSON.stringify({ id: "1", ok: true, result }), stderr: "" });
const failed = (stderr: string): Result => ({ code: 1, stdout: "", stderr });

const created = ok({ terminal: { handle: "term_w1", tabId: "tab-2", worktreeId: "repo-1::/code/app", title: "T1 tags" } });

function fakeOrca(replies: Record<string, Result>) {
  const calls: string[][] = [];
  const scripts: { cwd: string; cmd: string[] }[] = [];
  const term = orcaTerminal(
    (cmd) => (calls.push(cmd), replies[cmd.slice(1, 3).join(" ")] ?? failed(`no reply for ${cmd.join(" ")}`)),
    (cwd, cmd) => (scripts.push({ cwd, cmd }), "/tmp/foreman-orca-x/launch.sh"),
  );
  return { term, calls, scripts };
}

test("Orca is selectable by its folder name", () => {
  expect(terminal("orca").name).toBe("Orca");
  expect(terminal("orca").requires).toEqual(["orca"]);
});

test("Foreman picks Orca inside an Orca terminal without FOREMAN_TERMINAL", () => {
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "Orca", ORCA_WORKTREE_ID: "repo-1::/code/app" }).name).toBe("Orca");
});

test("a worker tab opens in the orchestrator's workspace without asking for focus", () => {
  const { term, calls, scripts } = fakeOrca({ "terminal create": created });
  const tab = term.open("repo-1::/code/app", "T1 tags", "/code/app/.foreman/worktrees/T1", ["claude", "-n", "T1"]);
  expect(tab).toEqual({ session: "repo-1::/code/app", window: "tab-2", pane: "term_w1" });
  expect(calls[0]).toEqual([
    "orca", "terminal", "create", "--worktree", "id:repo-1::/code/app", "--title", "T1 tags",
    "--command", "exec /bin/sh '/tmp/foreman-orca-x/launch.sh'", "--json",
  ]);
  expect(scripts).toEqual([{ cwd: "/code/app/.foreman/worktrees/T1", cmd: ["claude", "-n", "T1"] }]);
});

test("foreman up opens the orchestrator by the repo's path and focuses it", () => {
  const { term, calls } = fakeOrca({ "terminal create": created });
  expect(term.newSession("foreman-app", "/code/app", ["claude"])).toBe("repo-1::/code/app");
  expect(calls[0]).toContain("path:/code/app");
  expect(calls[0]).toContain("--focus");
});

test("a failed create says what Orca said", () => {
  const { term } = fakeOrca({ "terminal create": failed("no Orca workspace matches path:/code/app") });
  expect(() => term.newSession("foreman-app", "/code/app", ["claude"])).toThrow("no Orca workspace matches path:/code/app");
});

test("send types the text and presses Enter, close closes the one pane", () => {
  const { term, calls } = fakeOrca({ "terminal send": ok({}), "terminal close": ok({}) });
  const tab = { session: "repo-1::/code/app", window: "tab-2", pane: "term_w1" };
  term.send(tab, "rebase please");
  term.close(tab);
  expect(calls).toEqual([
    ["orca", "terminal", "send", "--terminal", "term_w1", "--text", "rebase please", "--enter", "--json"],
    ["orca", "terminal", "close", "--terminal", "term_w1", "--json"],
  ]);
});

test("the current session is the Orca workspace of the calling terminal", () => {
  const before = process.env.ORCA_WORKTREE_ID;
  try {
    process.env.ORCA_WORKTREE_ID = "repo-1::/code/app";
    expect(orcaTerminal().currentSession()).toBe("repo-1::/code/app");
    process.env.ORCA_WORKTREE_ID = "";
    expect(orcaTerminal().currentSession()).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.ORCA_WORKTREE_ID;
    else process.env.ORCA_WORKTREE_ID = before;
  }
});

test("alive reads the terminal's liveness from terminal show", () => {
  const show = (terminal: object) => parseAlive(ok({ terminal: { handle: "term_w1", ...terminal } }));
  expect(show({ connected: true })).toBe(true);
  expect(show({ connected: true, verdict: "live" })).toBe(true);
  expect(show({ connected: true, verdict: "exited" })).toBe(false);
  expect(show({ connected: true, exitCause: "process-exit" })).toBe(false);
  expect(show({ connected: false })).toBe(false);
  expect(show({ connected: false, verdict: "unverifiable" })).toBe(false);
  expect(parseAlive(failed("terminal_handle_stale"))).toBe(false);
});

test("findSession finds the workspace holding a tab with that title, nested in splits", () => {
  const listing = ok({
    terminals: [],
    visualLayouts: [
      { worktreeId: "repo-2::/code/other", worktreePath: "/code/other", root: { type: "group", tabs: [{ tabId: "a", title: "foreman-app" }] } },
      {
        worktreeId: "repo-1::/code/app",
        worktreePath: "/code/app",
        root: {
          type: "split",
          first: { type: "group", tabs: [{ tabId: "b", title: "zsh" }] },
          second: { type: "group", tabs: [{ tabId: "c", title: null }, { tabId: "d", title: "foreman-app-2" }] },
        },
      },
    ],
  });
  expect(findTabWorkspace(listing.stdout, "foreman-app-2")).toBe("repo-1::/code/app");
  expect(findTabWorkspace(listing.stdout, "foreman-app")).toBe("repo-2::/code/other");
  expect(findTabWorkspace(listing.stdout, "missing")).toBeUndefined();
  expect(findTabWorkspace(JSON.stringify({ ok: true, result: { terminals: [] } }), "foreman-app")).toBeUndefined();
});

test("findSession returns nothing when Orca isn't reachable", () => {
  const { term } = fakeOrca({ "terminal list": failed("runtime_unavailable") });
  expect(term.findSession("foreman-app")).toBeUndefined();
});

test("parseCreate refuses a reply with no terminal handle", () => {
  expect(() => parseCreate(ok({ terminal: {} }).stdout)).toThrow("didn't say which terminal");
});

test("createArgs only adds --focus when asked", () => {
  expect(createArgs("id:w", "T1", "exec x")).not.toContain("--focus");
  expect(createArgs("path:/a", "T1", "exec x", true)).toContain("--focus");
});

test("the typed line refuses a script path a shell would read differently", () => {
  expect(typedCommand("/tmp/a b/launch.sh")).toBe("exec /bin/sh '/tmp/a b/launch.sh'");
  expect(() => typedCommand("/tmp/it's/launch.sh")).toThrow("can't hand Orca a script path");
});

test("the launch script runs the command in its folder, removes itself and keeps every argument whole", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "foreman-orca-test-")));
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
