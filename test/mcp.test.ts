import { expect, test } from "bun:test";
import { mcpArgs, respond, serve, type Server } from "../src/mcp.ts";
import type { Tool } from "../src/tools/tool.ts";
import { tempRepo } from "./helpers.ts";

const echo: Tool = {
  name: "echo",
  description: "Says it back",
  inputSchema: { type: "object", properties: { text: { type: "string", description: "What to say" }, times: { type: "integer", description: "How often" } }, required: ["text"] },
  roles: ["orchestrator", "worker"],
  handler: (args) => String(args.text).repeat((args.times as number | undefined) ?? 1),
};
const whoami: Tool = { name: "whoami", description: "The worker's task", inputSchema: { type: "object", properties: {} }, roles: ["worker"], handler: (_a, s) => s.task ?? "none" };
const broken: Tool = { name: "broken", description: "Fails", inputSchema: { type: "object", properties: {} }, roles: ["orchestrator"], handler: () => { throw new Error("no tasks yet"); } };

const server = (role?: "orchestrator" | "worker", task?: string): Server => ({ name: "foreman", version: "9.9.9", tools: [echo, whoami, broken], session: { role, task, repo: tempRepo() } });
const ask = (s: Server, method: string, params: Record<string, unknown> = {}) => respond({ jsonrpc: "2.0", id: 1, method, params }, s) as Promise<{ result?: any; error?: { code: number; message: string } }>;
const names = async (s: Server) => (await ask(s, "tools/list")).result.tools.map((t: { name: string }) => t.name);

test("initialize agrees a version Claude Code asks for, and server/discover offers tasks too", async () => {
  const s = server("orchestrator");
  const r = (await ask(s, "initialize", { protocolVersion: "2025-06-18" })).result;
  expect(r).toEqual({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "foreman", version: "9.9.9" } });
  expect((await ask(s, "initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
  expect((await ask(s, "server/discover")).result.capabilities).toEqual({ tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } });
});

test("each role lists only its own tools, and a session with no role gets none", async () => {
  expect(await names(server("orchestrator"))).toEqual(["echo", "broken"]);
  expect(await names(server("worker"))).toEqual(["echo", "whoami"]);
  expect(await names(server())).toEqual([]);
});

test("a tool's listing carries its schema but not who gets it", async () => {
  const [listed] = (await ask(server("worker"), "tools/list")).result.tools;
  expect(listed).toEqual({ name: "echo", description: "Says it back", inputSchema: echo.inputSchema });
});

test("calling a tool returns its text, with the session it runs in", async () => {
  expect((await ask(server("worker"), "tools/call", { name: "echo", arguments: { text: "hi", times: 2 } })).result).toEqual({ content: [{ type: "text", text: "hihi" }] });
  expect((await ask(server("worker", "T4"), "tools/call", { name: "whoami" })).result.content[0].text).toBe("T4");
});

test("a role can't call another role's tool", async () => {
  const r = await ask(server("orchestrator"), "tools/call", { name: "whoami" });
  expect(r.error).toEqual({ code: -32602, message: "unknown tool: whoami" });
});

test("arguments are checked against the tool's schema", async () => {
  const s = server("worker");
  const call = async (args: Record<string, unknown>) => (await ask(s, "tools/call", { name: "echo", arguments: args })).error?.message;
  expect(await call({})).toBe("missing argument: text");
  expect(await call({ text: 3 })).toBe("text must be of type string");
  expect(await call({ text: "a", times: 1.5 })).toBe("times must be of type integer");
  expect(await call({ text: "a", loud: true })).toBe("unknown argument: loud");
});

test("a tool that throws reports the error in its result", async () => {
  const r = await ask(server("orchestrator"), "tools/call", { name: "broken" });
  expect(r.result).toEqual({ content: [{ type: "text", text: "no tasks yet" }], isError: true });
});

test("notifications get no reply, and unknown methods get an error", async () => {
  const s = server("worker");
  expect(await respond({ jsonrpc: "2.0", method: "notifications/initialized" }, s)).toBeUndefined();
  expect((await ask(s, "resources/list")).error?.code).toBe(-32601);
  expect((await ask(s, "ping")).result).toEqual({});
});

test("the server reads one message per line, even split across chunks, and answers each", async () => {
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    "not json",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "ok" } } }),
  ].join("\n");
  const bytes = new TextEncoder().encode(lines);
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, 10));
      c.enqueue(bytes.slice(10));
      c.close();
    },
  });
  const out: string[] = [];
  await serve(server("worker"), input, (l) => void out.push(l));
  const replies = out.map((l) => JSON.parse(l));
  expect(replies).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
  expect(replies).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  expect(replies).toContainEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } });
  expect(replies).toHaveLength(3);
});

test("mcpArgs starts foreman mcp with the session's role and task", () => {
  const [flag, json] = mcpArgs("worker", "T3", "/plugin");
  expect(flag).toBe("--mcp-config");
  expect(JSON.parse(json!)).toEqual({ mcpServers: { foreman: { type: "stdio", command: "/plugin/bin/foreman", args: ["mcp"], env: { FOREMAN_ROLE: "worker", FOREMAN_TASK: "T3" } } } });
  expect(JSON.parse(mcpArgs("orchestrator", undefined, "/plugin")[1]!).mcpServers.foreman.env).toEqual({ FOREMAN_ROLE: "orchestrator" });
});
