import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../src/events.ts";
import { loadDecisions } from "../src/ledger.ts";
import { respond, type Server } from "../src/mcp.ts";
import { loadNotes } from "../src/notes.ts";
import { ensureForeman } from "../src/paths.ts";
import { workerCommand } from "../src/spawn.ts";
import { findTask, type Task } from "../src/state.ts";
import { TOOLS } from "../src/tools/index.ts";
import { workerTools } from "../src/tools/worker.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

const task = (id: string, worktree: string): Task => ({ id, status: "running", title: `feat: build ${id}`, worker: "W1", branch: `foreman/${id}`, base: "main", worktree, owns: ["src/"], socket: "", tab: { session: "session:1", window: `window:${id}`, pane: "block:1" }, createdAt: "" });

function setup(as = "T1") {
  const repo = tempRepo();
  ensureForeman(repo);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task("T1", repo.root), task("T2", join(repo.root, "nowhere"))] }));
  const term = fakeTerminal();
  const server: Server = { name: "foreman", version: "0", tools: workerTools(() => term), session: { role: "worker", task: as, repo } };
  const call = async (name: string, args: object = {}) => {
    const r = (await respond({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, server)) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: r.result.content[0]!.text, isError: r.result.isError ?? false };
  };
  return { repo, term, call };
}

test("report done records the summary, each test step and each assumption, and marks the task done", async () => {
  const { repo, call } = setup();
  const r = await call("report", { type: "done", summary: "built tags", tests: "Open the list.\n\nSelect the work tag. Only work notes show.", assumptions: "Tags sort by name" });
  expect(r).toEqual({ text: "reported done for T1", isError: false });
  const [event] = readEvents(repo, "T1");
  expect(event).toMatchObject({ type: "done", note: "built tags", test: ["Open the list.", "Select the work tag. Only work notes show."], assumptions: ["Tags sort by name"] });
  expect(findTask(repo, "T1").status).toBe("done");
});

test("report done without a test step is refused and records nothing", async () => {
  const { repo, call } = setup();
  const r = await call("report", { type: "done", summary: "built tags", tests: "  \n" });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("done needs at least one step in tests");
  expect(readEvents(repo, "T1")).toEqual([]);
  expect(findTask(repo, "T1").status).toBe("running");
});

test("report blocked and needs-decision set the task's status, and rebased leaves it alone", async () => {
  const { repo, call } = setup();
  await call("report", { type: "blocked", summary: "needs src/x.ts" });
  expect(findTask(repo, "T1").status).toBe("blocked");
  await call("report", { type: "needs-decision", summary: "tabs or spaces?" });
  expect(findTask(repo, "T1").status).toBe("needs-decision");
  await call("report", { type: "rebased", summary: "onto main" });
  expect(findTask(repo, "T1").status).toBe("needs-decision");
  expect(readEvents(repo, "T1").map((e) => e.type)).toEqual(["blocked", "needs-decision", "rebased"]);
});

test("report refuses a type it doesn't know", async () => {
  const { call } = setup();
  expect(await call("report", { type: "finished", summary: "x" })).toEqual({ text: "type must be one of done, blocked, needs-decision, rebased", isError: true });
});

test("propose records the decision as the worker's, with each path, and tells the orchestrator", async () => {
  const { repo, call } = setup();
  const r = await call("propose", { decision: "Tags are lowercase", body: "Mixed case splits one tag in two. Rejected: folding case on read.", paths: "src/tags.ts  test/tags.test.ts" });
  expect(r.text).toBe("proposed D-1. Carry on with the parts of your work it doesn't block.");
  expect(loadDecisions(repo)).toMatchObject([{ id: "D-1", title: "Tags are lowercase", body: "Mixed case splits one tag in two. Rejected: folding case on read.", paths: ["src/tags.ts", "test/tags.test.ts"], status: "proposed", by: "T1" }]);
  expect(readEvents(repo, "T1")).toMatchObject([{ type: "needs-decision", note: "D-1 Tags are lowercase" }]);
});

test("note records the fact as the worker's and sends it to the other workers", async () => {
  const { repo, term, call } = setup();
  expect((await call("note", { fact: "swift test -j 3 deadlocks on main, use -j 1" })).text).toBe("added note 1. Told: T2");
  expect(loadNotes(repo)).toMatchObject([{ text: "swift test -j 3 deadlocks on main, use -j 1", by: "T1" }]);
  expect(term.sent).toHaveLength(1);
  expect((await call("note", { fact: "swift test -j 3 deadlocks on main, use -j 1" })).text).toBe("that note is already there");
});

test("tidy stops leftovers in the worker's own worktree and says when there are none", async () => {
  const { call } = setup("T2");
  expect(await call("tidy")).toEqual({ text: "T2 has no processes left over from old runs", isError: false });
});

test("a worker's tools refuse to run without a task", async () => {
  const repo = tempRepo();
  const server: Server = { name: "foreman", version: "0", tools: workerTools(fakeTerminal), session: { role: "worker", repo } };
  const r = (await respond({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tidy", arguments: {} } }, server)) as { result: object };
  expect(r.result).toEqual({ content: [{ type: "text", text: "FOREMAN_TASK isn't set: only workers report" }], isError: true });
});

test("a worker starts with its four tools allowed and the foreman command denied", () => {
  const repo = tempRepo();
  const cmd = workerCommand({ ...task("T1", repo.root), socket: "/s" }, fakeTerminal(), "go", undefined, [], []);
  const allowed = cmd.slice(cmd.indexOf("--allowedTools") + 1, cmd.indexOf("--disallowedTools"));
  expect(allowed.filter((t) => t.startsWith("mcp__"))).toEqual(["mcp__foreman__report", "mcp__foreman__propose", "mcp__foreman__note", "mcp__foreman__tidy"]);
  expect(allowed).not.toContain("Bash(foreman *)");
  expect(cmd[cmd.indexOf("--disallowedTools") + 1]).toBe("Bash(foreman *)");
});

test("the tools a worker is allowed are exactly the ones the server offers a worker", () => {
  const worker = TOOLS.filter((t) => t.roles.includes("worker")).map((t) => `mcp__foreman__${t.name}`);
  const cmd = workerCommand({ ...task("T1", tempRepo().root), socket: "/s" }, fakeTerminal(), "go", undefined, [], []);
  expect(cmd.filter((a) => a.startsWith("mcp__"))).toEqual(worker);
});
