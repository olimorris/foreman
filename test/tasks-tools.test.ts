import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../src/events.ts";
import { respond, TASKS, type Server } from "../src/mcp.ts";
import type { Repo } from "../src/paths.ts";
import { ensureForeman } from "../src/spawn.ts";
import { TASK_TOOLS } from "../src/tools/tasks.ts";
import { tempRepo } from "./helpers.ts";

const offer = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS]: {} } } };

function runningRepo(): Repo {
  const repo = tempRepo();
  ensureForeman(repo);
  const task = { id: "T1", status: "running", title: "feat: build T1", worker: "W1", branch: "foreman/T1", base: "main", worktree: "/w/T1", owns: [], socket: "", createdAt: "" };
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task] }));
  return repo;
}

const orchestrator = (repo: Repo): Server => ({ name: "foreman", version: "0", tools: TASK_TOOLS, session: { role: "orchestrator", repo } });
const ask = async (s: Server, method: string, params: Record<string, unknown>) => ((await respond({ jsonrpc: "2.0", id: 1, method, params }, s)) as { result: any }).result;

async function settled(s: Server, taskId: string) {
  for (let i = 0; i < 100; i++) {
    const task = await ask(s, "tasks/get", { taskId });
    if (task.status !== "working") return task;
    await Bun.sleep(100);
  }
  throw new Error("the watch task never finished");
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

test("a second watch while one runs says the watcher is already armed", async () => {
  const s = orchestrator(runningRepo());
  const first = await ask(s, "tools/call", { name: "watch", arguments: {}, _meta: offer });
  const second = await ask(s, "tools/call", { name: "watch", arguments: {}, _meta: offer });
  expect((await settled(s, second.taskId)).result.content[0].text).toBe(`watcher: already armed (pid ${process.pid})`);
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
