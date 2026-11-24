export type Result = { code: number; stdout: string; stderr: string };

export type RunOptions = { cwd?: string; stdin?: string; env?: Record<string, string> };

export function run(cmd: string[], opts: RunOptions = {}): Result {
  try {
    const p = Bun.spawnSync(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (err) {
    return { code: 127, stdout: "", stderr: String(err) };
  }
}

export function must(cmd: string[], opts: RunOptions = {}): string {
  const r = run(cmd, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}
