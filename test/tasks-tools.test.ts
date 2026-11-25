import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";
import { appendEvent } from "../src/events.ts";
import { must, run } from "../src/exec.ts";
import { loadNotes } from "../src/notes.ts";
import { respond, TASKS, type Server } from "../src/mcp.ts";
import type { Repo } from "../src/paths.ts";
import { ensureForeman } from "../src/spawn.ts";
import { taskTools } from "../src/tools/tasks.ts";
import type { WaitForChange } from "../src/watch.ts";
import { tempRepo } from "./helpers.ts";

const offer = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS]: {} } } };

function runningRepo(): Repo {
  const repo = tempRepo();
  ensureForeman(repo);
  const task = { id: "T1", status: "running", title: "feat: build T1", worker: "W1", branch: "foreman/T1", base: "main", worktree: "/w/T1", owns: [], socket: "", createdAt: "" };
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task] }));
  return repo;
}

const rescan: WaitForChange = () => Bun.sleep(50);
const orchestrator = (repo: Repo): Server => ({ name: "foreman", version: "0", tools: taskTools(rescan), session: { role: "orchestrator", repo } });
const ask = async (s: Server, method: string, params: Record<string, unknown>) => ((await respond({ jsonrpc: "2.0", id: 1, method, params }, s)) as { result: any }).result;

async function settled(s: Server, taskId: string) {
  for (let i = 0; i < 150; i++) {
    const task = await ask(s, "tasks/get", { taskId });
    if (task.status !== "working") return task;
    await Bun.sleep(100);
  }
  throw new Error(`task ${taskId} never finished`);
}

test("watch returns a task that keeps working until a worker reports, then completes with the watcher's line", async () => {
  const repo = runningRepo();
  const s = orchestrator(repo);
  const started = await ask(s, "tools/call", { name: "watch", arguments: {}, _meta: offer });
  expect(started).toMatchObject({ resultType: "task", status: "working" });

  await Bun.sleep(300);
  expect(await ask(s, "tasks/get", { taskId: started.taskId })).toMatchObject({ resultType: "complete", status: "working" });
  expect(existsSync(join(repo.foreman, "watch.pid"))).toBe(true);

  appendEvent(repo, "T1", "done", "built the tags list");
  const done = await settled(s, started.taskId);
  expect(done.status).toBe("completed");
  expect(done.result).toEqual({ content: [{ type: "text", text: "done T1: built the tags list" }] });
  expect(existsSync(join(repo.foreman, "watch.pid"))).toBe(false);
});

test("a second watch while one runs says the watcher is already running", async () => {
  const s = orchestrator(runningRepo());
  const first = await ask(s, "tools/call", { name: "watch", arguments: {}, _meta: offer });
  const second = await ask(s, "tools/call", { name: "watch", arguments: {}, _meta: offer });
  expect((await settled(s, second.taskId)).result.content[0].text).toBe(`watcher: already running (pid ${process.pid})`);
  await ask(s, "tasks/cancel", { taskId: first.taskId });
});

test("cancelling the watch task stops the watcher and disarms it", async () => {
  const repo = runningRepo();
  const s = orchestrator(repo);
  const started = await ask(s, "tools/call", { name: "watch", arguments: {}, _meta: offer });
  await Bun.sleep(300);
  expect(await ask(s, "tasks/cancel", { taskId: started.taskId })).toEqual({});
  expect((await ask(s, "tasks/get", { taskId: started.taskId })).status).toBe("cancelled");
  for (let i = 0; i < 50 && existsSync(join(repo.foreman, "watch.pid")); i++) await Bun.sleep(100);
  expect(existsSync(join(repo.foreman, "watch.pid"))).toBe(false);
});

test("a worker can't call watch", async () => {
  const s: Server = { ...orchestrator(runningRepo()), session: { role: "worker", task: "T1", repo: tempRepo() } };
  expect((await respond({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "watch", arguments: {}, _meta: offer } }, s) as { error: { message: string } }).error.message).toBe("unknown tool: watch");
});

const start = async (s: Server, name: string, args: Record<string, unknown> = {}) => {
  const started = await ask(s, "tools/call", { name, arguments: args, _meta: offer });
  expect(started).toMatchObject({ resultType: "task", status: "working" });
  return started.taskId as string;
};
const text = (task: { result: { content: { text: string }[] } }) => task.result.content[0]!.text;

test("baseline returns a task, saves the test command and completes with the line it used to message", async () => {
  const repo = tempRepo();
  const s = orchestrator(repo);
  const done = await settled(s, await start(s, "baseline", { test: "test -f README.md", runs: 1 }));
  expect(done).toMatchObject({ status: "completed", result: { content: [{ type: "text", text: "`test -f README.md` passed 1 of 1 runs on main" }] } });
  expect(loadConfig(repo).test).toBe("test -f README.md");
});

test("baseline notes what fails on the base branch, and says so in its line", async () => {
  const repo = tempRepo();
  saveConfig(repo, { test: "echo '(fail) tags > always'; exit 1" });
  const s = orchestrator(repo);
  const done = await settled(s, await start(s, "baseline", { runs: 1 }));
  expect(text(done)).toBe("`echo '(fail) tags > always'; exit 1` passed 0 of 1 runs on main. Added 1 note. Read them with foreman notes");
  expect(loadNotes(repo).map((n) => n.by)).toEqual(["baseline"]);
});

test("baseline without a test command completes with an error saying how to give one", async () => {
  const s = orchestrator(tempRepo());
  const done = await settled(s, await start(s, "baseline"));
  expect(done.result.isError).toBe(true);
  expect(text(done)).toContain("Call baseline again with test set to the command");
});

test("cancelling the baseline task kills its test run, notes nothing and removes its worktree", async () => {
  const repo = tempRepo();
  const marker = `cancelled-${Date.now()}`;
  const s = orchestrator(repo);
  const taskId = await start(s, "baseline", { test: `echo waiting; sleep 30; echo ${marker}`, runs: 1 });
  const log = join(repo.foreman, "baseline", "run-1.log");
  for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, "utf8").includes("waiting")); i++) await Bun.sleep(50);
  await ask(s, "tasks/cancel", { taskId });
  const pid = join(repo.foreman, "baseline", "pid");
  for (let i = 0; i < 100 && existsSync(pid); i++) await Bun.sleep(50);
  expect(existsSync(pid)).toBe(false);
  expect(existsSync(join(repo.foreman, "baseline", "worktree"))).toBe(false);
  expect(run(["pgrep", "-f", marker]).stdout).toBe("");
  expect(loadNotes(repo)).toEqual([]);
  expect((await ask(s, "tasks/get", { taskId })).status).toBe("cancelled");
}, 15_000);

function withPrs(ids: string[]): Repo {
  const repo = tempRepo();
  ensureForeman(repo);
  const tasks = ids.map((id, i) => {
    must(["git", "-C", repo.root, "checkout", "-qb", `foreman/${id}`, "main"]);
    writeFileSync(join(repo.root, `${id}.txt`), `${id}\n`);
    must(["git", "-C", repo.root, "add", "."]);
    must(["git", "-C", repo.root, "commit", "-qm", `work ${id}`]);
    return { id, status: "pr-open", pr: 70 + i, title: `feat: build ${id}`, branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, owns: [], socket: "", createdAt: "" };
  });
  must(["git", "-C", repo.root, "checkout", "-q", "main"]);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks }));
  return repo;
}

test("together returns a task and completes with its together line", async () => {
  const repo = withPrs(["T1", "T2"]);
  saveConfig(repo, { test: "test -f T1.txt && test -f T2.txt" });
  const s = orchestrator(repo);
  expect(text(await settled(s, await start(s, "together")))).toBe("together: 2 PRs merge cleanly and the tests pass");
});

test("together with fewer than two open PRs completes at once saying there's nothing to test", async () => {
  const s = orchestrator(withPrs(["T1"]));
  expect(text(await settled(s, await start(s, "together")))).toBe("together: only #70 is open, so there's nothing to test together");
});
