import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_README, detectAdr, highestNumber, renderAdr, supersede, type AdrConvention } from "./adr.ts";
import { loadConfig } from "./config.ts";
import { writeIndex } from "./decisions.ts";
import { must, run } from "./exec.ts";
import { loadDecisions, updateDecision, type Decision } from "./ledger.ts";
import { worktreeDir, type Repo } from "./paths.ts";
import { baseRef, snapshot } from "./snapshot.ts";

export type PlannedFile = { file: string; content: string; from?: string };
export type Recorded = Record<string, { number: number; file: string }>;
export type AdrPlan = { files: PlannedFile[]; recorded: Recorded };
export type AdrBatch = AdrPlan & { branch: string; pr?: number };

export function planAdrs(root: string, conv: AdrConvention, decisions: Decision[], reserved: number[] = []): AdrPlan {
  const files: PlannedFile[] = [];
  const recorded: Recorded = {};
  if (conv.readme && !existsSync(join(root, conv.readme))) files.push({ file: conv.readme, content: DEFAULT_README });
  let n = Math.max(highestNumber(root, conv), ...reserved);
  const replacedBy = new Map<number, number[]>();
  for (const d of decisions) {
    n += 1;
    const adr = renderAdr(conv, n, d.title, d.body, d.slug);
    files.push(adr);
    recorded[d.id] = { number: n, file: adr.file };
    for (const old of d.supersedes) replacedBy.set(old, [...(replacedBy.get(old) ?? []), n]);
  }
  const existing = existsSync(join(root, conv.dir)) ? readdirSync(join(root, conv.dir)) : [];
  for (const [old, by] of replacedBy) {
    const name = existing.find((f) => Number(f.match(/^(\d+)[-_]/)?.[1]) === old);
    if (!name) throw new Error(`ADR ${old} isn't in ${conv.dir}, so it can't be superseded`);
    const from = `${conv.dir}/${name}`;
    files.push({ ...supersede(conv, from, readFileSync(join(root, from), "utf8"), by), from });
  }
  return { files, recorded };
}

// Numbers on main can lag numbers already claimed by open PRs, and reusing one makes those PRs conflict.
export function numbersInOpenPrs(root: string, conv: AdrConvention): number[] {
  const r = run(["gh", "pr", "list", "--state", "open", "--limit", "100", "--json", "files"], { cwd: root });
  if (r.code !== 0) throw new Error(`couldn't list open PRs to avoid their ADR numbers: ${r.stderr.trim()}`);
  return parseOpenPrNumbers(JSON.parse(r.stdout), conv);
}

export function parseOpenPrNumbers(prs: { files?: { path: string }[] }[], conv: AdrConvention): number[] {
  const dirs = [conv.dir, ...(conv.supersededDir ? [conv.supersededDir] : [])];
  return prs.flatMap((pr) => (pr.files ?? []).flatMap((f) => {
    const m = f.path.match(/^(.*)\/(\d+)[-_][^/]+\.md$/);
    return m && dirs.includes(m[1]!) ? [Number(m[2])] : [];
  }));
}

export type WriteOptions = { dryRun: boolean; push: boolean; base: string; reserved?: number[] };

export function writeAdrs(repo: Repo, opts: WriteOptions): AdrBatch {
  const decisions = loadDecisions(repo).filter((d) => d.status === "accepted" && !d.adr);
  if (!decisions.length) throw new Error("no accepted decisions are waiting to be recorded");
  const configured = loadConfig(repo).adr;
  const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
  const branch = `foreman/decisions-${stamp}`;

  if (opts.push) run(["git", "-C", repo.root, "fetch", "-q", "origin", opts.base]);
  const ref = baseRef(repo, opts.base);

  if (opts.dryRun) {
    const snap = snapshot(repo, ref, configured ? [configured.dir] : ["docs", "doc", "adr", "decisions", ".adr-dir"]);
    const conv = detectAdr(snap) ?? configured;
    if (!conv) throw new Error("this repo has no ADR folder. Run foreman adr init first");
    return { branch, ...planAdrs(snap, conv, decisions, opts.reserved ?? numbersInOpenPrs(repo.root, conv)) };
  }

  const wt = worktreeDir(repo, `decisions-${stamp}`);
  must(["git", "-C", repo.root, "worktree", "add", "-q", "-b", branch, wt, ref]);
  try {
    const conv = detectAdr(wt) ?? configured;
    if (!conv) throw new Error("this repo has no ADR folder. Run foreman adr init first");
    const reserved = opts.reserved ?? (opts.push ? numbersInOpenPrs(repo.root, conv) : []);
    const { files, recorded } = planAdrs(wt, conv, decisions, reserved);
    for (const f of files) {
      if (f.from && f.from !== f.file) {
        mkdirSync(dirname(join(wt, f.file)), { recursive: true });
        must(["git", "-C", wt, "mv", f.from, f.file]);
      }
      mkdirSync(dirname(join(wt, f.file)), { recursive: true });
      writeFileSync(join(wt, f.file), f.content);
    }
    must(["git", "-C", wt, "add", "-A"]);
    must(["git", "-C", wt, "commit", "-q", "-m", `docs: record decisions ${decisions.map((d) => d.id).join(", ")}`]);
    let pr: number | undefined;
    if (opts.push) {
      must(["git", "-C", wt, "push", "-q", "-u", "origin", branch]);
      const url = must(["gh", "pr", "create", "--base", opts.base, "--head", branch, "--title", prTitle(decisions), "--body", prBody(decisions, recorded)], { cwd: wt }).trim();
      pr = Number(url.match(/\/pull\/(\d+)/)?.[1]) || undefined;
    }
    for (const d of decisions) updateDecision(repo, d.id, { adr: { ...recorded[d.id]!, pr } });
    writeIndex(repo, opts.base);
    return { branch, files, recorded, pr };
  } finally {
    run(["git", "-C", repo.root, "worktree", "remove", "--force", wt]);
  }
}

const prTitle = (ds: Decision[]) => (ds.length === 1 ? `docs: record decision "${ds[0]!.title}"` : `docs: record ${ds.length} decisions`);

function prBody(ds: Decision[], recorded: Recorded): string {
  return [
    "Docs only. Records decisions accepted while Foreman workers were running.",
    "",
    ...ds.map((d) => `- ADR ${recorded[d.id]!.number}: ${d.title} (${d.id}, proposed by ${d.by})`),
  ].join("\n");
}
