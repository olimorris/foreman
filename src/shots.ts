import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { must, run } from "./exec.ts";
import { pluginRoot, type Repo } from "./paths.ts";

export type WebShots = { adapter: "web"; install?: string; start: string; url: string; viewport?: string; readySeconds?: number };
export type MacShots = { adapter: "macos"; prepare?: string; build: string; app: string; settleSeconds?: number; env?: Record<string, string> };
export type ShotsConfig = WebShots | MacShots;

export type Screen = { name: string; target: string };
export type Capture = { files: string[]; errors: string[] };

export function parseScreens(brief: string): Screen[] {
  const section = brief.split(/^## /m).find((s) => /^Screens\s*\n/.test(s));
  if (!section) return [];
  return section.split("\n").flatMap((line) => {
    const m = line.match(/^\s*-\s*([A-Za-z0-9][\w-]*)\s*:\s*(.*)$/);
    return m ? [{ name: m[1]!, target: m[2]!.replace(/^`|`$/g, "").trim() }] : [];
  });
}

export const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function splitArgs(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

export async function capture(repo: Repo, cfg: ShotsConfig, worktree: string, key: string, screens: Screen[], outDir: string): Promise<Capture> {
  mkdirSync(outDir, { recursive: true });
  const log = join(outDir, "capture.log");
  writeFileSync(log, "");
  try {
    return cfg.adapter === "web" ? await captureWeb(cfg, worktree, key, screens, outDir, log) : await captureMac(repo, cfg, worktree, key, screens, outDir, log);
  } catch (err) {
    return { files: [], errors: [`${err instanceof Error ? err.message : err} (log: ${log})`] };
  }
}

function shell(cmd: string, cwd: string, log: string): void {
  const r = run(["sh", "-c", `(${cmd}) >> "$0" 2>&1`, log], { cwd });
  if (r.code !== 0) throw new Error(`\`${cmd}\` failed with exit ${r.code}`);
}

async function captureWeb(cfg: WebShots, worktree: string, key: string, screens: Screen[], outDir: string, log: string): Promise<Capture> {
  if (cfg.install) shell(cfg.install, worktree, log);
  const port = await freePort(4100 + (Number(Bun.hash(key)) % 800));
  const url = fill(cfg.url, { port }).replace(/\/$/, "");
  const server = Bun.spawn(["sh", "-c", `exec ${fill(cfg.start, { port })} >> "$0" 2>&1`, log], { cwd: worktree });
  const result: Capture = { files: [], errors: [] };
  try {
    await waitForUrl(url, (cfg.readySeconds ?? 120) * 1000);
    for (const s of screens) {
      const file = join(outDir, `${s.name}.png`);
      const r = run(["bunx", "playwright", "screenshot", `--viewport-size=${cfg.viewport ?? "1280,800"}`, "--full-page", `${url}${s.target.startsWith("/") ? "" : "/"}${s.target}`, file]);
      if (r.code === 0) {
        result.files.push(file);
        continue;
      }
      appendFileSync(log, r.stdout + r.stderr);
      result.errors.push(`${s.name}: ${firstReason(r.stderr || r.stdout)}`);
    }
  } finally {
    killTree(server.pid);
  }
  return result;
}

// Each copy gets its own bundle id and HOME, so two builds of one app don't share preferences or Application Support.
async function captureMac(repo: Repo, cfg: MacShots, worktree: string, key: string, screens: Screen[], outDir: string, log: string): Promise<Capture> {
  const derivedData = join(repo.foreman, "derived", key);
  if (cfg.prepare) shell(cfg.prepare, worktree, log);
  shell(fill(cfg.build, { derivedData }), worktree, log);
  const built = resolve(worktree, fill(cfg.app, { derivedData }));
  if (!existsSync(built)) throw new Error(`the build finished but ${built} doesn't exist`);

  const dir = join(repo.foreman, "apps", key);
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const app = join(dir, built.split("/").pop()!);
  cpSync(built, app, { recursive: true, verbatimSymlinks: true });
  rmSync(join(app, "Contents", "PlugIns"), { recursive: true, force: true });
  const plist = join(app, "Contents", "Info.plist");
  const buddy = (cmd: string) => must(["/usr/libexec/PlistBuddy", "-c", cmd, plist]).trim();
  const bundleId = `${buddy("Print :CFBundleIdentifier")}.foreman.${key.replace(/[^A-Za-z0-9-]/g, "-")}`;
  buddy(`Set :CFBundleIdentifier ${bundleId}`);
  must(["codesign", "--force", "--deep", "--sign", "-", app]);
  const exe = join(app, "Contents", "MacOS", buddy("Print :CFBundleExecutable"));

  const windows = windowsTool(repo);
  const result: Capture = { files: [], errors: [] };
  for (const s of screens) {
    const proc = Bun.spawn([exe, ...splitArgs(s.target)], { env: { ...process.env, HOME: home, ...cfg.env }, stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep((cfg.settleSeconds ?? 5) * 1000);
      const ids = run([windows, String(proc.pid)]).stdout.trim().split("\n").filter(Boolean);
      if (!ids.length) {
        result.errors.push(`${s.name}: the app showed no window`);
        continue;
      }
      const file = join(outDir, `${s.name}.png`);
      const r = run(["screencapture", "-x", "-o", "-l", ids[0]!, file]);
      if (r.code === 0 && existsSync(file)) result.files.push(file);
      else result.errors.push(`${s.name}: screencapture failed. Check Screen Recording permission for the terminal running the review.`);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }
  return result;
}

function windowsTool(repo: Repo): string {
  const bin = join(repo.foreman, "bin", "windows");
  if (!existsSync(bin)) {
    mkdirSync(join(repo.foreman, "bin"), { recursive: true });
    must(["swiftc", "-O", "-o", bin, join(pluginRoot, "scripts", "windows.swift")]);
  }
  return bin;
}

// Playwright wraps its errors in box-drawing frames, so the useful line is the first one with words in it.
function firstReason(output: string): string {
  return output.split("\n").map((l) => l.replace(/[║╔╗╚╝═|]/g, "").trim()).find((l) => /[a-z]{3}/i.test(l)) ?? "unknown error";
}

async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port++) {
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      return port;
    } catch {}
  }
  throw new Error(`no free port near ${start}`);
}

async function waitForUrl(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`${url} didn't answer within ${ms / 1000}s`);
}

// Dev servers fork watchers and bundlers, and killing only the shell leaves them holding the port.
function killTree(pid: number): void {
  for (const child of run(["pgrep", "-P", String(pid)]).stdout.trim().split("\n").filter(Boolean)) killTree(Number(child));
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}
