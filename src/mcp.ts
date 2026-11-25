import { join } from "node:path";
import { pluginRoot } from "./paths.ts";

// Foreman's MCP server, started as `foreman mcp` in every orchestrator and worker session. Each capability, such as skills, plugs in its own methods.

export type Params = Record<string, unknown>;
export type Method = (params: Params) => unknown;
export type Capability = { capabilities: Record<string, unknown>; methods: Record<string, Method> };
export type Server = { name: string; version: string; capabilities: Capability[] };

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

export function respond(message: Message, server: Server): object | undefined {
  // A notification has no id and must get no reply.
  if (message.id === undefined || message.id === null) return undefined;
  const id = message.id;
  try {
    return { jsonrpc: "2.0", id, result: call(message.method ?? "", message.params ?? {}, server) };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: "2.0", id, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

function call(method: string, params: Params, server: Server): unknown {
  const capabilities = Object.assign({}, ...server.capabilities.map((c) => c.capabilities));
  const info = { name: server.name, version: server.version };
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1], capabilities, serverInfo: info };
    }
    case "server/discover":
      return { resultType: "complete", supportedVersions: VERSIONS, capabilities, _meta: { "io.modelcontextprotocol/serverInfo": info }, ttlMs: 0, cacheScope: "private" };
    case "ping":
      return {};
  }
  const handler = server.capabilities.find((c) => Object.hasOwn(c.methods, method))?.methods[method];
  if (!handler) throw new RpcError(-32601, `method not found: ${method}`);
  return handler(params);
}

// Claude Code's stdio transport sends one JSON-RPC message per line and reads one per line back.
export async function serve(server: Server, input: ReadableStream<Uint8Array> = Bun.stdin.stream(), write: (line: string) => void = (l) => process.stdout.write(l)): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
    }
    const reply = respond(message, server);
    if (reply) write(JSON.stringify(reply) + "\n");
  };
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  }
  handle(buffer);
}

// A plugin .mcp.json would start the server in every session a marketplace install loads in, the reviewer's included.
export function mcpArgs(root = pluginRoot): string[] {
  return ["--mcp-config", JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "stdio", command: join(root, "bin", "foreman"), args: ["mcp"] } } })];
}
