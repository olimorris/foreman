import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";

// The user's main checkout may sit on any branch with local edits, so ADRs are read from the base branch itself.
export function baseRef(repo: Repo, base: string): string {
  const remote = `refs/remotes/origin/${base}`;
  return run(["git", "-C", repo.root, "rev-parse", "--verify", "-q", remote]).code === 0 ? `origin/${base}` : base;
}

export function snapshot(repo: Repo, ref: string, paths: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "foreman-snap-")));
  const present = paths.filter((p) => run(["git", "-C", repo.root, "cat-file", "-e", `${ref}:${p}`]).code === 0);
  if (present.length) {
    const tar = join(dir, ".snapshot.tar");
    run(["git", "-C", repo.root, "archive", "-o", tar, ref, "--", ...present]);
    run(["tar", "-xf", tar, "-C", dir]);
  }
  return dir;
}
