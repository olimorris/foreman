import { loadConfig } from "./config.ts";
import { checkModel } from "./spawn.ts";
import type { Repo } from "./paths.ts";

// A bad name would otherwise only fail inside the new session, after its tab has already opened.
export function orchestratorModel(repo: Repo, flag?: string): string | undefined {
  if (flag !== undefined) {
    try {
      checkModel(flag);
    } catch (err) {
      throw new Error(`--model: ${(err as Error).message}`);
    }
    return flag;
  }
  const model = loadConfig(repo).orchestratorModel;
  try {
    if (model !== undefined) checkModel(model);
  } catch (err) {
    throw new Error(`orchestratorModel in .foreman/config.json: ${(err as Error).message}`);
  }
  return model;
}

export function orchestratorCommand(plugin: string[], socket: string, model?: string): string[] {
  return [
    "env", "FOREMAN_ROLE=orchestrator",
    "claude", ...plugin,
    "--agent", "foreman:orchestrator",
    ...(model ? ["--model", model] : []),
    "--allowedTools", "Bash(foreman *)",
    "--messaging-socket-path", socket,
    "-n", "foreman",
  ];
}
