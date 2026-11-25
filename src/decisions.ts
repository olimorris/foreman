import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADR_DIRS, listAdrs } from "./adr.ts";
import { loadConfig } from "./config.ts";
import { decisionsDir, findDecision, loadDecisions, recordPath, updateDecision, type Decision } from "./ledger.ts";
import { defaultBase, type Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { baseRef, snapshot } from "./snapshot.ts";
import { inFlight, loadTasks, type Task } from "./state.ts";
import { settleQuestions } from "./questions.ts";

const staticPrefix = (glob: string) => glob.split(/[*?[{]/)[0]!;

export function overlaps(a: string[], b: string[]): boolean {
  return !a.length || !b.length || shared(a, b).length > 0;
}

export function shared(a: string[], b: string[]): string[] {
  return a.filter((x) => b.some((y) => {
    const px = staticPrefix(x);
    const py = staticPrefix(y);
    return px.startsWith(py) || py.startsWith(px);
  }));
}

export function recipients(tasks: Task[], d: Decision): Task[] {
  return inFlight(tasks).filter((t) => t.id === d.by || overlaps(d.paths, t.owns));
}

export type Broadcast = { decision: Decision; sent: string[]; failed: string[] };

export function accept(repo: Repo, id: string, edits: Partial<Pick<Decision, "title" | "body" | "paths" | "slug" | "supersedes">>, term: Terminal): Broadcast {
  const current = findDecision(repo, id);
  if (current.status !== "proposed") throw new Error(`${id} is already ${current.status}`);
  const clean = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  const d = updateDecision(repo, id, { ...clean, status: "accepted", resolvedAt: new Date().toISOString() });
  settleQuestions(repo, id, `accepted ${id}`);
  writeIndex(repo);
  const file = recordPath(repo, id);
  return broadcast(repo, recipients(loadTasks(repo), d), term, (t) =>
    t.id === d.by
      ? `Your proposal ${id} was accepted: ${d.title}. Final text: ${file}. Carry on with it.`
      : `Decision ${id} was accepted and touches your owned paths: ${d.title}. Read ${file} and adjust your work to match it.`,
    d,
  );
}

export function reject(repo: Repo, id: string, reason: string, term: Terminal): Broadcast {
  if (!reason.trim()) throw new Error("rejecting needs a reason the worker can act on");
  const current = findDecision(repo, id);
  const overrule = current.status === "accepted" && current.decidedBy === "foreman";
  if (current.status !== "proposed" && !overrule) throw new Error(`${id} is already ${current.status}`);
  if (overrule && current.adr) throw new Error(`${id} is already written as ${current.adr.file}. Propose a decision that supersedes it instead`);
  const d = updateDecision(repo, id, { status: "rejected", reason, resolvedAt: new Date().toISOString() });
  if (!overrule) settleQuestions(repo, id, `rejected ${id}: ${reason}`);
  writeIndex(repo);
  if (!overrule) {
    const proposer = inFlight(loadTasks(repo)).filter((t) => t.id === d.by);
    return broadcast(repo, proposer, term, () => `Your proposal ${id} (${d.title}) was rejected: ${reason}. Carry on without it.`, d);
  }
  // Every worker told about the acceptance may have built on it, so each one hears it's gone.
  return broadcast(repo, recipients(loadTasks(repo), d), term, () => `The user overruled decision ${id} (${d.title}), which Foreman accepted while they were away: ${reason}. Undo any work that follows it.`, d);
}

function broadcast(repo: Repo, tasks: Task[], term: Terminal, message: (t: Task) => string, decision: Decision): Broadcast {
  const sent: string[] = [];
  const failed: string[] = [];
  for (const t of tasks) {
    try {
      sendToTask(repo, t, message(t), term);
      sent.push(t.id);
    } catch {
      failed.push(t.id);
    }
  }
  return { decision, sent, failed };
}

export const indexPath = (repo: Repo) => join(decisionsDir(repo), "index.md");

export function writeIndex(repo: Repo, base = defaultBase(repo)): string {
  const config = loadConfig(repo);
  const dir = config.adr?.dir;
  const snap = snapshot(repo, baseRef(repo, base), dir ? [dir] : ADR_DIRS);
  const adrDir = dir ?? ADR_DIRS.find((d) => existsSync(join(snap, d)));
  const adrs = adrDir ? listAdrs(snap, adrDir) : [];
  const inRepo = new Set(adrs.map((a) => a.file));
  const pending = loadDecisions(repo).filter((d) => d.status === "accepted" && !(d.adr && inRepo.has(d.adr.file)));
  const lines = [
    "# Decisions",
    "",
    "One line each. Open a full record only when your work touches it. Propose a new one with Foreman's `propose` tool.",
    ...(config.context ? ["", `Domain terms: ${config.context}`] : []),
    "",
    `## In the repo${adrDir ? ` (${adrDir})` : ""}`,
    "",
    ...(adrs.length ? adrs.map((a) => `- ADR ${a.number}: ${a.title} - ${a.file}`) : ["- none yet"]),
    "",
    "## Accepted, not in the repo yet",
    "",
    ...(pending.length ? pending.map((d) => `- ${d.id}: ${d.title} - ${recordPath(repo, d.id)}`) : ["- none"]),
    "",
  ];
  mkdirSync(decisionsDir(repo), { recursive: true });
  writeFileSync(indexPath(repo), lines.join("\n"));
  return indexPath(repo);
}

export function findContext(root: string): string | undefined {
  return ["CONTEXT.md", "docs/CONTEXT.md"].find((p) => existsSync(join(root, p)));
}
