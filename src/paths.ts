import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { run } from "./exec.ts";

export type Repo = { root: string; foreman: string };

export function findRepo(cwd = process.cwd()): Repo {
  const r = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (r.code !== 0) throw new Error(`not inside a git repository: ${cwd}`);
  const root = dirname(realpathSync(r.stdout.trim()));
  return { root, foreman: join(root, ".foreman") };
}

export function taskDir(repo: Repo, id: string): string {
  return join(repo.foreman, "tasks", id);
}

export function worktreeDir(repo: Repo, id: string): string {
  return join(repo.foreman, "worktrees", id);
}

export function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// Claude Code refuses a socket in a symlinked or shared directory, and macOS caps socket paths at ~104 bytes.
export function socketPath(repo: Repo, name: string): string {
  const dir = join(realpathSync(tmpdir()), `foreman-${Bun.hash(repo.root).toString(36).slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return join(dir, `${name}.sock`);
}

// The main checkout may be on a feature branch, so its current branch says nothing about where work should land.
export function defaultBase(repo: Repo): string {
  const git = (...args: string[]) => run(["git", "-C", repo.root, ...args]);
  const remoteHead = git("symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD").stdout.trim();
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  const local = ["main", "master"].find((b) => git("rev-parse", "--verify", "-q", `refs/heads/${b}`).code === 0);
  return local ?? (git("symbolic-ref", "--short", "HEAD").stdout.trim() || "main");
}

export const pluginRoot = resolve(import.meta.dir, "..");

export function pluginArgs(): string[] {
  return pluginRoot.includes("/.claude/plugins/") ? [] : ["--plugin-dir", pluginRoot];
}
