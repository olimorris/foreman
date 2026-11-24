import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./paths.ts";
import { writeJson } from "./state.ts";
import { withLock } from "./store.ts";

export type DecisionStatus = "proposed" | "accepted" | "rejected";

export type Decision = {
  id: string;
  title: string;
  body: string;
  paths: string[];
  supersedes: number[];
  slug?: string;
  status: DecisionStatus;
  by: string;
  createdAt: string;
  resolvedAt?: string;
  reason?: string;
  adr?: { number: number; file: string; pr?: number };
};

export type Proposal = { title: string; body: string; paths: string[]; supersedes: number[]; slug?: string; by: string };

export const decisionsDir = (repo: Repo) => join(repo.foreman, "decisions");
export const recordPath = (repo: Repo, id: string) => join(decisionsDir(repo), `${id}.md`);
const ledgerPath = (repo: Repo) => join(decisionsDir(repo), "ledger.json");

export function loadDecisions(repo: Repo): Decision[] {
  const path = ledgerPath(repo);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).decisions ?? [] : [];
}

export function findDecision(repo: Repo, id: string): Decision {
  const d = loadDecisions(repo).find((x) => x.id === id);
  if (!d) throw new Error(`no decision ${id}`);
  return d;
}

function withDecisions<T>(repo: Repo, fn: (decisions: Decision[]) => T): T {
  mkdirSync(decisionsDir(repo), { recursive: true });
  return withLock(join(decisionsDir(repo), "ledger.lock"), () => {
    const decisions = loadDecisions(repo);
    const result = fn(decisions);
    writeJson(ledgerPath(repo), { decisions });
    for (const d of decisions) writeFileSync(recordPath(repo, d.id), renderRecord(d));
    return result;
  });
}

export function propose(repo: Repo, p: Proposal): Decision {
  if (!p.title.trim() || !p.body.trim()) throw new Error("a proposal needs a title and a body");
  return withDecisions(repo, (decisions) => {
    const n = Math.max(0, ...decisions.map((d) => Number(d.id.slice(2)))) + 1;
    const d: Decision = { id: `D-${n}`, ...p, status: "proposed", createdAt: new Date().toISOString() };
    decisions.push(d);
    return d;
  });
}

export function updateDecision(repo: Repo, id: string, patch: Partial<Decision>): Decision {
  return withDecisions(repo, (decisions) => {
    const d = decisions.find((x) => x.id === id);
    if (!d) throw new Error(`no decision ${id}`);
    return Object.assign(d, patch);
  });
}

function renderRecord(d: Decision): string {
  return [
    `# ${d.id}: ${d.title}`,
    "",
    `- Status: ${d.status}${d.reason ? ` (${d.reason})` : ""}`,
    `- Proposed by: ${d.by}`,
    `- Paths: ${d.paths.length ? d.paths.join(", ") : "whole repo"}`,
    ...(d.supersedes.length ? [`- Supersedes: ${d.supersedes.map((n) => `ADR ${n}`).join(", ")}`] : []),
    ...(d.adr ? [`- Recorded as: ${d.adr.file}${d.adr.pr ? ` (PR #${d.adr.pr})` : ""}`] : []),
    "",
    d.body.trim(),
    "",
  ].join("\n");
}
