import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdrConvention } from "./adr.ts";
import type { Repo } from "./paths.ts";
import type { ShotsConfig } from "./shots.ts";
import type { Budget, Price } from "./cost.ts";
import { writeJson } from "./state.ts";

export type Config = { adr?: AdrConvention; context?: string; screenshots?: ShotsConfig; maxWorkers?: number; prScreenshots?: "branch" | "local"; budget?: Budget; prices?: Record<string, Price>; stallMinutes?: number; stackTasks?: boolean; test?: string; testMinutes?: number };

const configPath = (repo: Repo) => join(repo.foreman, "config.json");

export function loadConfig(repo: Repo): Config {
  const path = configPath(repo);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export function saveConfig(repo: Repo, patch: Partial<Config>): Config {
  mkdirSync(repo.foreman, { recursive: true });
  const config = { ...loadConfig(repo), ...patch };
  writeJson(configPath(repo), config);
  return config;
}
