import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdrConvention } from "./adr.ts";
import type { Repo } from "./paths.ts";
import type { ShotsConfig } from "./shots.ts";
import type { Budget, Price } from "./cost.ts";
import { jsonStore } from "./store.ts";

export type Config = { adr?: AdrConvention; context?: string; screenshots?: ShotsConfig; maxWorkers?: number; prScreenshots?: "branch" | "local"; budget?: Budget; prices?: Record<string, Price>; stallMinutes?: number; stackTasks?: boolean; test?: string; testMinutes?: number; answerMinutes?: number; workerModel?: string; reviewerModel?: string; orchestratorModel?: string; never?: string[]; telegram?: { when?: string } };

// Blank entries would print as empty bullets under a heading that promises rules.
export const neverRules = (config: Config): string[] => (config.never ?? []).map((r) => r.trim()).filter(Boolean);

const configStore = (repo: Repo) => jsonStore<Config>(join(repo.foreman, "config.json"), () => ({}));

export const loadConfig = (repo: Repo): Config => configStore(repo).read();

export function saveConfig(repo: Repo, patch: Partial<Config>): Config {
  return configStore(repo).update((config) => Object.assign(config, patch));
}

const DEFAULT_WHEN = "when a question needs the user's answer, or the run is finished";

export const telegramWhen = (config: Config): string | undefined =>
  config.telegram ? config.telegram.when?.trim() || DEFAULT_WHEN : undefined;

// The plugin's README installs it from claude-plugins-official, but Claude Code's plugin directory publishes the same plugin as telegram@anthropic-plugin-directory.
export const OFFICIAL_TELEGRAM = "telegram@claude-plugins-official";

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export function telegramPlugins(dir = claudeDir()): string[] {
  try {
    const installed = JSON.parse(readFileSync(join(dir, "plugins", "installed_plugins.json"), "utf8"));
    return Object.keys(installed.plugins ?? {}).filter((id) => id.startsWith("telegram@"));
  } catch {
    return [];
  }
}

export const channelPlugin = (plugins: string[]): string =>
  plugins.includes(OFFICIAL_TELEGRAM) ? OFFICIAL_TELEGRAM : plugins[0] ?? OFFICIAL_TELEGRAM;

// Every session that loads the plugin starts its own bot and kills the one already running, so a worker or the reviewer would take the bot from the orchestrator.
export const withoutTelegram = (plugins: string[]): { enabledPlugins?: Record<string, false> } =>
  plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((p) => [p, false])) } : {};

export type TelegramSetup = { token: boolean; chats: string[]; access: string };

// Mirrors where the plugin itself keeps its token and allowlist.
export function telegramSetup(state = process.env.TELEGRAM_STATE_DIR ?? join(claudeDir(), "channels", "telegram")): TelegramSetup {
  const read = (file: string) => (existsSync(join(state, file)) ? readFileSync(join(state, file), "utf8") : "");
  const token = !!process.env.TELEGRAM_BOT_TOKEN || /^TELEGRAM_BOT_TOKEN=\S/m.test(read(".env"));
  let chats: string[] = [];
  try {
    chats = (JSON.parse(read("access.json")).allowFrom ?? []).map(String);
  } catch {}
  return { token, chats, access: join(state, "access.json") };
}
