import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { respond, type Server } from "../src/mcp.ts";
import { ask } from "../src/questions.ts";
import { ensureForeman } from "../src/spawn.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { Role } from "../src/tools/tool.ts";
import { tempRepo } from "./helpers.ts";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const task = (id: string, status: string) => ({ id, status, title: `feat: build ${id}`, worker: "W1", branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, owns: [], socket: "", createdAt: "" });

function busyRepo() {
  const repo = tempRepo();
  ensureForeman(repo);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task("T1", "running"), task("T2", "needs-decision")] }));
  ask(repo, { question: "Tabs or spaces?", call: "spaces" });
  return repo;
}

const list = async (role: Role) => {
  const r = (await respond({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { name: "foreman", version: "0", tools: TOOLS, session: { role, repo: tempRepo() } })) as { result: { tools: { name: string }[] } };
  return r.result.tools.map((t) => t.name);
};

test("the orchestrator gets the commands it shares with the CLI and its own, and a worker gets its own four", async () => {
  expect(await list("orchestrator")).toEqual([
    "status", "timeline", "summary", "cost", "budget",
    "plan", "next", "spawn", "send", "review", "feedback", "deliver", "sync", "teardown", "pause", "resume", "restart", "tidy", "unblock",
    "workers", "automerge", "set_budget", "decisions", "accept", "reject", "propose", "adr", "ask", "answer", "note", "notes", "shots",
    "watch", "baseline", "together",
  ]);
  expect(await list("worker")).toEqual(["report", "propose", "note", "tidy"]);
});

test("status reads the same through the CLI and through foreman mcp", async () => {
  const repo = busyRepo();
  const env = { ...process.env, NO_COLOR: "1", FOREMAN_TASK: "" };
  const fromCli = Bun.spawnSync(["bun", cli, "status"], { cwd: repo.root, env }).stdout.toString();

  const server = Bun.spawn(["bun", cli, "mcp"], { cwd: repo.root, env: { ...env, FOREMAN_ROLE: "orchestrator" }, stdin: "pipe", stdout: "pipe" });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) + "\n");
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } }) + "\n");
  server.stdin.end();
  const replies = (await new Response(server.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  const fromServer = replies.find((r) => r.id === 2).result.content[0].text;

  expect(fromServer).toContain("Questions waiting on you");
  expect(fromServer + "\n").toBe(fromCli);
});

test("each shared tool answers through the server", async () => {
  const repo = busyRepo();
  const server: Server = { name: "foreman", version: "0", tools: TOOLS, session: { role: "orchestrator", repo } };
  const call = async (name: string, args: object = {}) => {
    const r = (await respond({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, server)) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(r.result.isError).toBeUndefined();
    return r.result.content[0]!.text;
  };
  expect(await call("cost")).toContain("total");
  expect(await call("budget")).toContain("T1");
  expect(await call("timeline", { task: "T1" })).toContain("T1");
  expect(await call("summary")).toBe(`wrote ${join(repo.foreman, "summary.md")}`);
});
