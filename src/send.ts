import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.ts";
import { socketPath, taskDir, type Repo } from "./paths.ts";
import type { Rex } from "./rex.ts";
import type { Task } from "./state.ts";

export function sendSocket(path: string, text: string): boolean {
  if (!existsSync(path)) return false;
  const line = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
  return run(["nc", "-U", "-w", "2", path], { stdin: line }).code === 0;
}

// Typing long text into the TUI drops characters and Enters, so the fallback types only a pointer to a file.
export function sendToTask(repo: Repo, task: Task, text: string, rex: Rex): "socket" | "typed" {
  const body = `[foreman] ${text}`;
  if (sendSocket(task.socket, body)) return "socket";
  if (!task.rex) throw new Error(`task ${task.id} has no socket and no Rex tab to type into`);
  const inbox = join(taskDir(repo, task.id), "inbox");
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, `${Date.now()}.md`);
  writeFileSync(file, body + "\n");
  rex.send(task.rex, `Foreman message waiting: read ${file} and act on it.`);
  return "typed";
}

export function notifyOrchestrator(repo: Repo, text: string): boolean {
  return sendSocket(socketPath(repo, "orchestrator"), text);
}
