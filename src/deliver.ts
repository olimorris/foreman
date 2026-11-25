import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { lastDone, logRun } from "./events.ts";
import { must, run } from "./exec.ts";
import { loadDecisions } from "./ledger.ts";
import { taskDir, type Repo } from "./paths.ts";
import { CONVENTIONAL, loadPlan, stackable } from "./plan.ts";
import { roundDir, type Verdict } from "./review.ts";
import { diffBase, findTask, loadTasks, updateTask, type Task } from "./state.ts";
import { loadSessions, sessionsFile, taskCost, transcriptDir } from "./cost.ts";

export type Shot = { name: string; before?: string; after?: string };
export type PacketInput = {
  task: Task; intent: string; doneNote?: string; test?: string[]; assumptions?: string[]; stat: string; verdict: Verdict; round: number;
  decisions: string[]; shots: Shot[]; shotsNote?: string; buildsOn?: Task;
};

export function section(md: string, heading: string): string {
  const parts = md.split(/^## /m);
  const hit = parts.find((p) => p.startsWith(`${heading}\n`) || p.trim() === heading);
  return hit ? hit.slice(heading.length).trim() : "";
}

const image = (src?: string) => (src ? (src.startsWith("http") ? `<img src="${src}" width="400">` : `\`${src}\``) : "none");

export type Models = { worker: string[]; reviewer: string[] };

// "claude-opus-5-5" reads as "Opus 5.5"; anything unrecognised is shown as its raw id.
export function modelName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id;
}

const names = (ids: string[]) => [...new Set(ids.map(modelName))].join(" and ") || "an unrecorded model";

function buildsOnNote(parent: Task, base: string): string {
  const name = parent.pr ? `#${parent.pr}` : parent.branch;
  const target = parent.pr ? `${name}'s branch` : parent.branch;
  return `This builds on ${name} and should merge after it. It targets ${target}, so the diff shows only this change. Foreman moves it to ${base} once ${name} merges.`;
}

export function renderPacket(p: PacketInput & { models: Models; cost?: number }): string {
  const revisions = p.task.revisions ?? 0;
  return [
    "## Description",
    "",
    ...(p.buildsOn ? [buildsOnNote(p.buildsOn, p.task.base), ""] : []),
    p.intent || "(the brief has no Intent section)",
    "",
    ...(p.doneNote ? [p.doneNote, ""] : []),
    p.stat ? "```\n" + p.stat + "\n```" : "No committed changes.",
    "",
    "## How to test",
    "",
    ...(p.test?.length ? p.test.map((s, i) => `${i + 1}. ${s}`) : ["The worker gave no steps."]),
    "",
    "## Assumptions",
    "",
    ...(p.assumptions?.length ? p.assumptions.map((s) => `- ${s}`) : ["None: the brief settled every choice."]),
    "",
    "## Decisions",
    "",
    ...(p.decisions.length ? p.decisions.map((d) => `- ${d}`) : ["None."]),
    "",
    "## AI Usage",
    "",
    "AI wrote this change. A person set its scope and merges it.",
    "",
    `**Tools and models used:** Claude Code with Foreman. Worker: ${names(p.models.worker)}. Reviewer: ${names(p.models.reviewer)}.${p.cost ? ` Cost: about $${p.cost.toFixed(2)} at list prices.` : ""}`,
    "",
    `**How the AI output was reviewed:** a separate reviewer session checked the diff${p.shots.length ? " and before and after screenshots" : ""} against the intent above. It approved in round ${p.round}${revisions ? ` after ${revisions} revision round(s)` : ""}: ${p.verdict.summary}`,
    "",
    "## Screenshots",
    "",
    ...(p.shots.length
      ? ["| Screen | Before | After |", "| --- | --- | --- |", ...p.shots.map((s) => `| ${s.name} | ${image(s.before)} | ${image(s.after)} |`)]
      : [p.shotsNote ?? "None: the brief names no screens."]),
    ...(p.shots.length && p.shotsNote ? ["", p.shotsNote] : []),
    "",
    "## Risk",
    "",
    `**${p.verdict.risk}**${p.verdict.risk_note ? `: ${p.verdict.risk_note}` : ""}`,
    "",
  ].join("\n");
}

export function workerModels(repo: Repo, task: Task): string[] {
  const sessions = loadSessions(sessionsFile(repo, task.id));
  const dir = transcriptDir(task.worktree);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && sessions.some((s) => f.includes(s)))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/"model":"(claude-[^"]+)"/g)].map((m) => m[1]!));
  return [...new Set(ids)];
}

export function reviewerModels(repo: Repo, task: Task): string[] {
  const ids: string[] = [];
  for (let r = 1; r <= (task.reviews ?? 0); r++) {
    try {
      ids.push(...Object.keys(JSON.parse(readFileSync(join(roundDir(repo, task.id, r), "reviewer.json"), "utf8")).modelUsage ?? {}));
    } catch {}
  }
  return [...new Set(ids)];
}

function approvedRound(repo: Repo, task: Task): { verdict: Verdict; round: number } {
  const round = task.reviews ?? 0;
  const file = join(roundDir(repo, task.id, round), "verdict.json");
  if (!round || !existsSync(file)) throw new Error(`${task.id} has no finished review. Run foreman review ${task.id} first`);
  const verdict = JSON.parse(readFileSync(file, "utf8")) as Verdict;
  if (verdict.verdict !== "approve") throw new Error(`${task.id}'s latest review (round ${round}) asked for changes, so there's nothing to deliver yet`);
  return { verdict, round };
}

function localShots(dir: string): Shot[] {
  const names = new Set<string>();
  for (const side of ["before", "after"]) {
    const d = join(dir, side);
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith(".png")) names.add(f.slice(0, -4));
  }
  return [...names].sort().map((name) => {
    const at = (side: string) => (existsSync(join(dir, side, `${name}.png`)) ? join(dir, side, `${name}.png`) : undefined);
    return { name, before: at("before"), after: at("after") };
  });
}

// GitHub has no API for PR image uploads, so screenshots go to a side branch and the packet links them by commit.
export function uploadShots(repo: Repo, shots: Shot[], prefix: string, nwo: string): Shot[] {
  const git = (args: string[], env?: Record<string, string>) => must(["git", "-C", repo.root, ...args], { env }).trim();
  const branch = "foreman-screenshots";
  run(["git", "-C", repo.root, "fetch", "-q", "origin", `${branch}:refs/remotes/origin/${branch}`]);
  const parent = run(["git", "-C", repo.root, "rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]).stdout.trim();
  const env = { GIT_INDEX_FILE: join(mkdtempSync(join(tmpdir(), "foreman-index-")), "index") };
  git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
  const path = (s: Shot, side: "before" | "after") => `${prefix}/${side}/${s.name}.png`;
  for (const s of shots) for (const side of ["before", "after"] as const) {
    if (s[side]) git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", s[side]!])},${path(s, side)}`], env);
  }
  const tree = git(["write-tree"], env);
  const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `Screenshots for ${prefix}`]);
  git(["push", "-q", "origin", `${commit}:refs/heads/${branch}`]);
  const url = (s: Shot, side: "before" | "after") => (s[side] ? `https://github.com/${nwo}/blob/${commit}/${path(s, side)}?raw=true` : undefined);
  return shots.map((s) => ({ name: s.name, before: url(s, "before"), after: url(s, "after") }));
}

export type Delivery = { packet: string; pr?: number; url?: string; note: string };

export function deliver(repo: Repo, id: string, opts: { dryRun?: boolean; title?: string } = {}): Delivery {
  const task = findTask(repo, id);
  const { verdict, round } = approvedRound(repo, task);
  const brief = readFileSync(join(taskDir(repo, id), "brief.md"), "utf8");
  const done = lastDone(repo, id);
  const doneNote = done?.note;
  const buildsOn = task.stackedOn ? findTask(repo, task.stackedOn) : undefined;
  const stat = run(["git", "-C", repo.root, "diff", "--stat", `${diffBase(repo, task)}...${task.branch}`]).stdout.trimEnd();
  const decisions = loadDecisions(repo)
    .filter((d) => d.by === id || verdict.decisions_touched.some((t) => t.includes(d.id)))
    .map((d) => `${d.id} ${d.title} (${d.status}${d.adr ? `, ADR ${d.adr.number}` : ""})`);
  const title = opts.title ?? loadPlan(repo)?.tasks.find((t) => t.id === id)?.title ?? task.title ?? "";
  if (!CONVENTIONAL.test(title)) throw new Error(`PR titles must be conventional commits. Rerun with --title "<type>: <summary>", like --title "feat: add tags to notes"`);

  const origin = run(["git", "-C", repo.root, "remote", "get-url", "origin"]).code === 0;
  const nwo = origin && !opts.dryRun ? run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: repo.root }) : undefined;
  const github = nwo?.code === 0 ? nwo.stdout.trim() : undefined;

  const dir = roundDir(repo, id, round);
  let shots = localShots(dir);
  let shotsNote: string | undefined = shots.length ? `Screenshots are on the machine that ran the review, in \`${dir}\`.` : undefined;
  if (shots.length && github && loadConfig(repo).prScreenshots === "branch") {
    shots = uploadShots(repo, shots, `${id}/round-${round}`, github);
    shotsNote = undefined;
  }
  const packet = join(taskDir(repo, id), "pr.md");
  writeFileSync(packet, renderPacket({ task, intent: section(brief, "Intent"), doneNote, test: done?.test, assumptions: done?.assumptions, stat, verdict, round, decisions, shots, shotsNote, buildsOn, models: { worker: workerModels(repo, task), reviewer: reviewerModels(repo, task) }, cost: taskCost(repo, task).total }));

  if (opts.dryRun) return { packet, note: `wrote the PR packet to ${packet}` };
  if (!origin) return { packet, note: `this repo has no origin remote, so nothing was pushed. The PR packet is at ${packet}` };
  must(["git", "-C", repo.root, "push", "-q", "--force-with-lease", "origin", `${task.branch}:refs/heads/${task.branch}`]);
  if (!github) return { packet, note: `pushed ${task.branch}, but gh can't see a GitHub repo for origin. Open the PR by hand with the body in ${packet}` };

  if (task.pr) {
    must(["gh", "pr", "edit", String(task.pr), "--body-file", packet], { cwd: repo.root });
    logRun(repo, id, "pr-updated", `#${task.pr}`);
    const stacked = loadTasks(repo).filter((t) => t.stackedOn === id && t.status !== "torn-down").map((t) => t.id);
    const restack = stacked.length ? `. ${stacked.join(", ")} ${stacked.length > 1 ? "build" : "builds"} on this branch, so run foreman sync to ask ${stacked.length > 1 ? "their workers" : "its worker"} to rebase` : "";
    return { packet, pr: task.pr, note: `pushed ${task.branch} and refreshed PR #${task.pr}${restack}` };
  }
  const url = must(["gh", "pr", "create", "--base", buildsOn?.branch ?? task.base, "--head", task.branch, "--title", title, "--body-file", packet], { cwd: repo.root }).trim().split("\n").at(-1)!;
  const pr = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  updateTask(repo, id, { pr, status: "pr-open" });
  logRun(repo, id, "pr-opened", `#${pr}`);
  const started = new Set(loadTasks(repo).map((t) => t.id));
  const next = stackable(repo) ? loadPlan(repo)?.tasks.filter((t) => t.deps.includes(id) && !started.has(t.id)).map((t) => t.id) ?? [] : [];
  return { packet, pr, url, note: `opened PR #${pr}: ${url}${next.length ? `. Run foreman next, which can start ${next.join(", ")} on top of it` : ""}` };
}
