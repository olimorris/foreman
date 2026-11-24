import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

// Claude Code asks to trust every new worktree, and a worker can't answer that dialog itself.
export function setTrust(dir: string, trusted: boolean, configPath = claudeConfigPath()): void {
  if (!existsSync(configPath)) return;
  // Running sessions rewrite this file too, so read, change and replace it in one quick step.
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.projects ??= {};
  if (trusted) config.projects[dir] = { ...config.projects[dir], hasTrustDialogAccepted: true };
  else delete config.projects[dir];
  const tmp = `${configPath}.foreman-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, configPath);
}
