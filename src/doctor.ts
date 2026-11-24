import { join } from "node:path";
import { run } from "./exec.ts";
import { pluginRoot } from "./paths.ts";

type Check = { name: string; ok: boolean; detail: string };

const MIN_CLAUDE = [2, 1, 224];

export function doctor(): Check[] {
  const has = (bin: string) => run(["sh", "-c", `command -v ${bin}`]).code === 0;
  const checks: Check[] = ["bun", "git", "rex", "fswatch", "jq", "nc", "gh"].map((bin) => ({
    name: bin,
    ok: has(bin),
    detail: has(bin) ? "found" : `missing - install ${bin}`,
  }));
  if (has("gh")) {
    const ok = run(["gh", "auth", "status"]).code === 0;
    checks.push({ name: "gh auth", ok, detail: ok ? "logged in" : "run: gh auth login" });
  }
  const version = run(["claude", "--version"]).stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  const parts = version ? version.slice(1).map(Number) : [];
  const ok = parts.length === 3 && compare(parts, MIN_CLAUDE) >= 0;
  checks.push({
    name: "claude",
    ok,
    detail: ok ? parts.join(".") : `need ${MIN_CLAUDE.join(".")}+ for the messaging socket${version ? `, found ${parts.join(".")}` : ""}`,
  });
  const capture = run(["swift", join(pluginRoot, "scripts", "windows.swift"), "check"]).stdout.trim();
  checks.push({
    name: "screen",
    ok: capture === "granted",
    detail: capture === "granted"
      ? "Screen Recording allowed (needed for macOS screenshots)"
      : "allow this terminal app in System Settings > Privacy & Security > Screen & System Audio Recording (only needed for macOS screenshots)",
  });
  const browsers = join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright");
  const playwright = run(["bunx", "playwright", "--version"]).code === 0 && run(["sh", "-c", `ls -d "${browsers}"/chromium* >/dev/null 2>&1`]).code === 0;
  checks.push({ name: "playwright", ok: playwright, detail: playwright ? "found (web screenshots)" : "run: bunx playwright install chromium (only needed for web screenshots)" });
  return checks;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
