import { channelPlugin, loadConfig, telegramPlugins } from "./config.ts";
import { checkModel } from "./spawn.ts";
import { findRepo, pluginArgs, type Repo } from "./paths.ts";
import { skillsPluginArgs } from "./skills.ts";
import { SERVER_NAME } from "./mcp.ts";
import { TOOLS } from "./tools/index.ts";
import { toolsFor, type Tool } from "./tools/tool.ts";

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

// The installed Telegram plugins when the repo turns pings on, or false to leave the plugin as the user set it.
export function orchestratorTelegram(repo: Repo): string[] | false {
  return loadConfig(repo).telegram ? telegramPlugins() : false;
}

export function orchestratorPlugins(repo: Repo): string[] {
  return [...pluginArgs(), ...skillsPluginArgs(repo)];
}

// watch, baseline and together stay CLI commands until they become MCP tasks, and pane is the user's to ask for.
const STILL_ON_THE_CLI = ["watch", "baseline", "together", "pane"];

export function orchestratorAllowedTools(tools: Tool[] = TOOLS): string[] {
  return [
    ...toolsFor(tools, "orchestrator").map((t) => `mcp__${SERVER_NAME}__${t.name}`),
    ...STILL_ON_THE_CLI.map((cmd) => `Bash(foreman ${cmd} *)`),
  ];
}

export function orchestratorCommand(plugin: string[], socket: string, model?: string, telegram: string[] | false = orchestratorTelegram(findRepo())): string[] {
  const channel = telegram && channelPlugin(telegram);
  return [
    "env", "FOREMAN_ROLE=orchestrator",
    "claude", ...plugin,
    "--agent", "foreman:orchestrator",
    ...(model ? ["--model", model] : []),
    "--allowedTools", ...orchestratorAllowedTools(),
    // Messages from Telegram only reach a session started with --channels, and only one copy of the plugin may load, since each kills the other's bot.
    ...(channel ? [
      "--channels", `plugin:${channel}`,
      "--settings", JSON.stringify({ enabledPlugins: Object.fromEntries([...telegram, channel].map((p) => [p, p === channel])) }),
    ] : []),
    "--messaging-socket-path", socket,
    "-n", "foreman",
  ];
}
