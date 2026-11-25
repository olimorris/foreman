import { join } from "node:path";
import { pluginRoot } from "./paths.ts";
import { toolsFor, type Args, type Role, type Schema, type Session, type Tool } from "./tools/tool.ts";

export type Params = Record<string, unknown>;
export type Server = { name: string; version: string; tools: Tool[]; session: Session; tasks?: Map<string, RunningTask> };

// A task tool's handler can run for hours, so it gets a way to show progress in /tasks and hears when it's stopped.
export type TaskContext = { signal: AbortSignal; status: (message: string) => void };
export type TaskTool = Omit<Tool, "handler"> & { task: true; handler: (args: Args, session: Session, context?: TaskContext) => Promise<string>; now?: (args: Args, session: Session) => string | undefined };

type Status = "working" | "completed" | "cancelled";
export type RunningTask = { taskId: string; status: Status; statusMessage?: string; createdAt: string; lastUpdatedAt: string; result?: object; stop: AbortController };

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Params };

export const SERVER_NAME = "foreman";
export const TASKS = "io.modelcontextprotocol/tasks";
// Claude Code clamps this to 250-30000 and checks the task this often, so it bounds how late a finished task reaches the agent.
export const POLL_MS = 5_000;

// 2026-07-28 drops initialize for server/discover, and Claude Code may speak either.
const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export const invalidParams = (message: string) => new RpcError(-32602, message);

export async function respond(message: Message, server: Server): Promise<object | undefined> {
  // A notification has no id and must get no reply.
  if (message.id === undefined || message.id === null) return undefined;
  const id = message.id;
  try {
    return { jsonrpc: "2.0", id, result: await call(message.method ?? "", message.params ?? {}, server) };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: "2.0", id, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

async function call(method: string, params: Params, server: Server): Promise<unknown> {
  const capabilities = { tools: {} };
  const info = { name: server.name, version: server.version };
  const tools = toolsFor(server.tools, server.session.role);
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1], capabilities, serverInfo: info };
    }
    // Only 2026-07-28 carries the tasks extension, and it negotiates through server/discover.
    case "server/discover":
      return { resultType: "complete", supportedVersions: VERSIONS, capabilities: { ...capabilities, extensions: { [TASKS]: {} } }, _meta: { "io.modelcontextprotocol/serverInfo": info }, ttlMs: 0, cacheScope: "private" };
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw invalidParams(`unknown tool: ${params.name}`);
      const args = (params.arguments ?? {}) as Args;
      checkArgs(tool.inputSchema, args);
      if (isTaskTool(tool)) {
        // A call with nothing to wait for answers in the caller's own turn, since a finished task wakes the orchestrator.
        const quick = tool.now?.(args, server.session);
        if (quick !== undefined) return toolResult(() => quick);
        if (offersTasks(params)) return startTask(tool, args, server);
      }
      return toolResult(() => tool.handler(args, server.session));
    }
    case "tasks/get": {
      const { stop: _, ...task } = findTask(params, server);
      return { resultType: "complete", ...task, ttlMs: null, pollIntervalMs: POLL_MS };
    }
    case "tasks/cancel": {
      const task = findTask(params, server);
      if (task.status === "working") settle(task, "cancelled");
      task.stop.abort();
      return {};
    }
    // Foreman's tasks never ask for input, so there's nothing to take.
    case "tasks/update":
      findTask(params, server);
      return {};
  }
  throw new RpcError(-32601, `method not found: ${method}`);
}

// A tool that fails tells the agent why in its result, since a protocol error reads as Foreman being broken.
async function toolResult(run: () => string | Promise<string>): Promise<object> {
  try {
    return { content: [{ type: "text", text: await run() }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

function isTaskTool(tool: Tool | TaskTool): tool is TaskTool {
  return "task" in tool && tool.task === true;
}

// A client that can't follow a task gets the tool's result the plain way, once the handler finishes.
function offersTasks(params: Params): boolean {
  const meta = params._meta as { "io.modelcontextprotocol/clientCapabilities"?: { extensions?: Record<string, unknown> } } | undefined;
  return meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[TASKS] !== undefined;
}

function startTask(tool: TaskTool, args: Args, server: Server): object {
  const now = new Date().toISOString();
  const task: RunningTask = { taskId: `${tool.name}-${crypto.randomUUID()}`, status: "working", createdAt: now, lastUpdatedAt: now, stop: new AbortController() };
  (server.tasks ??= new Map()).set(task.taskId, task);
  const status = (message: string) => {
    if (task.status !== "working") return;
    task.statusMessage = message;
    task.lastUpdatedAt = new Date().toISOString();
  };
  void toolResult(() => tool.handler(args, server.session, { signal: task.stop.signal, status })).then((result) => settle(task, "completed", result));
  const { stop: _, ...handle } = task;
  return { resultType: "task", ...handle, ttlMs: null, pollIntervalMs: POLL_MS };
}

function settle(task: RunningTask, status: Exclude<Status, "working">, result?: object): void {
  if (task.status !== "working") return;
  task.status = status;
  task.result = result;
  task.statusMessage = undefined;
  task.lastUpdatedAt = new Date().toISOString();
}

function findTask(params: Params, server: Server): RunningTask {
  const task = server.tasks?.get(String(params.taskId));
  if (!task) throw invalidParams(`unknown task: ${params.taskId}`);
  return task;
}

function checkArgs(schema: Schema, args: Args): void {
  if (typeof args !== "object" || Array.isArray(args)) throw invalidParams("arguments must be an object");
  for (const key of schema.required ?? []) if (args[key] === undefined) throw invalidParams(`missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) throw invalidParams(`unknown argument: ${key}`);
    const ok = prop.type === "integer" ? Number.isInteger(value) : typeof value === prop.type;
    if (!ok) throw invalidParams(`${key} must be of type ${prop.type}`);
  }
}

// Claude Code's stdio transport sends one JSON-RPC message per line and reads one per line back.
export async function serve(server: Server, input: ReadableStream<Uint8Array> = Bun.stdin.stream(), write: (line: string) => void = (l) => process.stdout.write(l)): Promise<void> {
  const decoder = new TextDecoder();
  const pending = new Set<Promise<void>>();
  let buffer = "";
  const handle = async (line: string) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
    }
    const reply = await respond(message, server);
    if (reply) write(JSON.stringify(reply) + "\n");
  };
  // A slow tool mustn't hold up a ping that Claude Code sends behind it.
  const start = (line: string) => {
    const p = handle(line).finally(() => pending.delete(p));
    pending.add(p);
  };
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      start(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  }
  start(buffer);
  // Claude Code closing the pipe ends the session, so a watcher still running has no one to wake.
  for (const task of server.tasks?.values() ?? []) task.stop.abort();
  await Promise.all(pending);
}

// A plugin .mcp.json would start the server in every session a marketplace install loads in, the reviewer's included.
export function mcpArgs(role: Role, task?: string, root = pluginRoot): string[] {
  const env = { FOREMAN_ROLE: role, ...(task ? { FOREMAN_TASK: task } : {}) };
  return ["--mcp-config", JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "stdio", command: join(root, "bin", "foreman"), args: ["mcp"], env } } })];
}
