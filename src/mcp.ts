import { join } from "node:path";
import { pluginRoot } from "./paths.ts";
import { toolsFor, type Args, type Role, type Schema, type Session, type Tool } from "./tools/tool.ts";

export type Params = Record<string, unknown>;
export type Server = { name: string; version: string; tools: Tool[]; session: Session };

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Params };

export const SERVER_NAME = "foreman";

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
    case "server/discover":
      return { resultType: "complete", supportedVersions: VERSIONS, capabilities, _meta: { "io.modelcontextprotocol/serverInfo": info }, ttlMs: 0, cacheScope: "private" };
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw invalidParams(`unknown tool: ${params.name}`);
      const args = (params.arguments ?? {}) as Args;
      checkArgs(tool.inputSchema, args);
      // A tool that fails tells the agent why in its result, since a protocol error reads as Foreman being broken.
      try {
        return { content: [{ type: "text", text: await tool.handler(args, server.session) }] };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
  }
  throw new RpcError(-32601, `method not found: ${method}`);
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
  await Promise.all(pending);
}

// A plugin .mcp.json would start the server in every session a marketplace install loads in, the reviewer's included.
export function mcpArgs(role: Role, task?: string, root = pluginRoot): string[] {
  const env = { FOREMAN_ROLE: role, ...(task ? { FOREMAN_TASK: task } : {}) };
  return ["--mcp-config", JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "stdio", command: join(root, "bin", "foreman"), args: ["mcp"], env } } })];
}
