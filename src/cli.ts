import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { defaultConvention, detectAdr } from "./adr.ts";
import { writeAdrs } from "./adrwrite.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { accept, findContext, reject, writeIndex } from "./decisions.ts";
import { doctor } from "./doctor.ts";
import { printBanner } from "./banner.ts";
import { helpText, usageError, UsageError } from "./help.ts";
import { loadDecisions, propose } from "./ledger.ts";
import { baseRef, snapshot } from "./snapshot.ts";
import { runReview, sendFeedback, startReview } from "./review.ts";
import { capture, parseScreens } from "./shots.ts";
import { join } from "node:path";
import { appendEvent, REPORT_TYPES, type ReportType } from "./events.ts";
import { areaLock, sessionStartContext, stopHook, type HookInput, type LockContext } from "./hooks.ts";
import { defaultBase, findRepo, pluginArgs, socketPath, type Repo } from "./paths.ts";
import { terminal } from "./integrations/index.ts";
import { requireSession } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { ensureForeman, plainTitle, spawn } from "./spawn.ts";
import { budgetOverview, byActivity, statusLabel, table, taskTitle } from "./overview.ts";
import { findTask, inFlight, loadTasks, updateTask } from "./state.ts";
import { teardown } from "./teardown.ts";
import { setTrust } from "./trust.ts";
import { deliver } from "./deliver.ts";
import { describePlan, loadPlan, maxWorkers, parsePlan, planBrief, readyTasks, savePlan, validatePlan } from "./plan.ts";
import { sync } from "./sync.ts";
import { writeSummary } from "./summary.ts";
import { budgetLeft, budgetOf, orchestratorCost, recordSession, sessionsFile, taskCost, usd } from "./cost.ts";
import { restartWorker, resume, stopWorker } from "./stop.ts";
import { watch, watcherArmed } from "./watch.ts";


function flags(args: string[]): { positional: string[]; opts: Record<string, string[]> } {
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (["--json", "--discard", "--all", "--dry-run", "--no-push"].includes(a)) opts[a.slice(2)] = ["true"];
    else (opts[a.slice(2)] ??= []).push(args[++i] ?? "");
  }
  return { positional, opts };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const term = terminal();
  const { positional, opts } = flags(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      return 0;
    case "doctor": {
      printBanner();
      const checks = doctor();
      const failed = checks.filter((c) => !c.ok);
      if (!failed.length) return console.log(`All ${checks.length} checks passed. Foreman is ready.`), 0;
      const width = Math.max(...failed.map((c) => c.name.length));
      for (const c of failed) console.log(`FAIL ${c.name.padEnd(width)}  ${c.detail}`);
      console.log(`${checks.length - failed.length} of ${checks.length} checks passed.`);
      return 1;
    }
    case "up": {
      printBanner();
      const repo = findRepo();
      ensureForeman(repo);
      const name = `foreman-${basename(repo.root)}`;
      const existing = term.findSession(name);
      if (existing) return console.log(`${term.name} session ${name} already exists (${existing})`), 0;
      // Claude Code's trust prompt would otherwise swallow the user's first message and exit.
      setTrust(repo.root, true);
      const session = term.newSession(name, repo.root, [
        "env", "FOREMAN_ROLE=orchestrator",
        "claude", ...pluginArgs(),
        "--agent", "foreman:orchestrator",
        "--allowedTools", "Bash(foreman *)",
        "--messaging-socket-path", socketPath(repo, "orchestrator"),
        "-n", "foreman",
      ]);
      console.log(`Started the orchestrator in ${term.name} session ${name} (${session})`);
      return 0;
    }
    case "spawn": {
      const repo = findRepo();
      const [id] = positional;
      if (!id || !opts.brief?.[0]) throw usageError("spawn");
      const session = requireSession(term, "spawn");
      const left = budgetLeft(repo, loadTasks(repo));
      if (left.reason) throw new Error(`no new tasks start: ${left.reason}`);
      const task = spawn(repo, { id, title: opts.title?.[0], brief: opts.brief[0], owns: opts.owns ?? [], base: opts.base?.[0] ?? defaultBase(repo), session }, term);
      console.log(`spawned ${task.id}: ${task.worktree} on ${task.branch}, ${term.name} tab ${task.tab?.window}`);
      return 0;
    }
    case "send": {
      const repo = findRepo();
      const [id, ...words] = positional;
      if (!id) throw usageError("send");
      const text = words.length ? words.join(" ") : await Bun.stdin.text();
      console.log(`sent to ${id} via ${sendToTask(repo, findTask(repo, id), text.trim(), term)}`);
      return 0;
    }
    case "report": {
      const repo = findRepo();
      const id = process.env.FOREMAN_TASK;
      const [type, ...words] = positional;
      if (!id) throw new Error("FOREMAN_TASK isn't set: only workers report");
      if (!REPORT_TYPES.includes(type as ReportType) || !words.length) throw usageError("report");
      if (type === "done" && !opts.test?.length) {
        throw new Error('done needs at least one --test "<step>": how the user checks this by hand, in the words they see on screen. Add --assume "<assumption>" for each choice the brief didn\'t settle');
      }
      appendEvent(repo, id, type as ReportType, words.join(" "), { test: opts.test, assumptions: opts.assume });
      if (type !== "rebased") updateTask(repo, id, { status: type as Exclude<ReportType, "rebased"> });
      console.log(`reported ${type} for ${id}`);
      return 0;
    }
    case "propose": {
      const repo = findRepo();
      const title = positional.join(" ");
      const body = opts["body-file"]?.[0] ? await Bun.file(opts["body-file"][0]).text() : (opts.body?.[0] ?? "");
      const by = process.env.FOREMAN_TASK ?? "orchestrator";
      const d = propose(repo, { title, body, paths: opts.paths ?? [], supersedes: (opts.supersedes ?? []).map(Number), slug: opts.slug?.[0], by });
      if (process.env.FOREMAN_TASK) appendEvent(repo, by, "needs-decision", `${d.id} ${d.title}`);
      console.log(`proposed ${d.id}. Carry on with the parts of your work it doesn't block.`);
      return 0;
    }
    case "accept": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("accept");
      const body = opts["body-file"]?.[0] ? await Bun.file(opts["body-file"][0]).text() : undefined;
      const r = accept(repo, id, { title: opts.title?.[0], body, paths: opts.paths, slug: opts.slug?.[0], supersedes: opts.supersedes?.map(Number) }, term);
      console.log(`accepted ${id}. Told: ${r.sent.join(", ") || "nobody"}${r.failed.length ? `. Couldn't reach: ${r.failed.join(", ")}` : ""}`);
      return 0;
    }
    case "reject": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("reject");
      const r = reject(repo, id, opts.reason?.[0] ?? "", term);
      console.log(`rejected ${id}. Told: ${r.sent.join(", ") || "nobody"}`);
      return 0;
    }
    case "decisions": {
      const repo = findRepo();
      const ds = loadDecisions(repo).filter((d) => opts.all || d.status === "proposed" || (d.status === "accepted" && !d.adr));
      for (const d of ds) console.log(`${d.id.padEnd(6)} ${d.status.padEnd(9)} ${d.by.padEnd(12)} ${d.title}`);
      if (!ds.length) console.log("no open decisions");
      return 0;
    }
    case "review": {
      const [id] = positional;
      if (!id) throw usageError("review");
      startReview(findRepo(), id, term);
      console.log(`review of ${id} started in its own tab. The verdict arrives through the watcher.`);
      return 0;
    }
    case "review-run": {
      const [id] = positional;
      if (!id) throw usageError("review");
      console.log(await runReview(findRepo(), id));
      return 0;
    }
    case "feedback": {
      const [id] = positional;
      if (!id) throw usageError("feedback");
      console.log(sendFeedback(findRepo(), id, term));
      return 0;
    }
    case "shots": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("shots");
      const task = findTask(repo, id);
      const cfg = loadConfig(repo).screenshots;
      if (!cfg) throw new Error("no screenshots entry in .foreman/config.json; see the review skill");
      const screens = parseScreens(await Bun.file(join(repo.foreman, "tasks", id, "brief.md")).text());
      if (!screens.length) throw new Error(`${id}'s brief has no ## Screens section`);
      const out = join(repo.foreman, "tasks", id, "shots-test");
      const r = await capture(repo, cfg, task.worktree, id, screens, out);
      for (const f of r.files) console.log(`captured ${f}`);
      for (const e of r.errors) console.log(`problem: ${e}`);
      return r.errors.length ? 1 : 0;
    }
    case "adr":
      return adr(positional[0], opts);
    case "plan":
      return plan(positional[0]);
    case "next": {
      const repo = findRepo();
      const p = loadPlan(repo);
      if (!p?.approvedAt) throw new Error("no approved plan. Write one with the intake skill, then run foreman plan approve once the user agrees");
      
      const session = requireSession(term, "next");
      const room = budgetLeft(repo, loadTasks(repo));
      if (room.reason) throw new Error(`no new tasks start: ${room.reason}`);
      const max = maxWorkers(repo, opts.max?.[0]);
      const { start, waiting } = readyTasks(p, loadTasks(repo), max);
      for (const t of start) {
        spawn(repo, { id: t.id, title: t.title, brief: planBrief(repo, t.id), owns: t.owns, base: defaultBase(repo), session }, term);
        console.log(`spawned ${t.id}: ${t.title}`);
      }
      for (const w of waiting) console.log(`waiting ${w.id}: ${w.reason}`);
      const left = p.tasks.filter((t) => !loadTasks(repo).some((x) => x.id === t.id)).length;
      if (!start.length && !left) console.log("every task in the plan has been started");
      return 0;
    }
    case "sync": {
      const repo = findRepo();
      const base = defaultBase(repo);
      const r = sync(repo, base, term);
      console.log(`${base} is at ${r.head.slice(0, 8)}`);
      if (r.merged.length) console.log(`merged: ${r.merged.join(", ")}. Tear them down, then run foreman next`);
      if (r.asked.length) console.log(`asked to rebase: ${r.asked.join(", ")}`);
      if (r.failed.length) console.log(`couldn't reach: ${r.failed.join(", ")}`);
      return 0;
    }
    case "summary":
      console.log(`wrote ${writeSummary(findRepo())}`);
      return 0;
    case "cost": {
      const repo = findRepo();
      const budget = budgetOf(repo);
      const costs = loadTasks(repo).map((t) => taskCost(repo, t));
      const orch = orchestratorCost(repo);
      for (const c of costs) {
        const limit = budget?.tasks?.[c.id] ?? budget?.perTask;
        console.log(`${c.id.padEnd(8)} ${usd(c.total).padStart(8)}  worker ${usd(c.worker)}, reviews ${usd(c.review)}${limit !== undefined ? `, limit ${usd(limit)}` : ""}`);
      }
      const total = costs.reduce((s, c) => s + c.total, 0) + orch.usd;
      console.log(`${"foreman".padEnd(8)} ${usd(orch.usd).padStart(8)}  orchestrator`);
      console.log(`${"total".padEnd(8)} ${usd(total).padStart(8)}${budget?.plan !== undefined ? `  of ${usd(budget.plan)}` : ""}  at list prices`);
      const unpriced = [...new Set([...costs.flatMap((c) => c.unpriced), ...orch.unpriced])];
      if (unpriced.length) console.log(`not counted: ${unpriced.join(", ")} has no price. Add it under "prices" in .foreman/config.json`);
      return 0;
    }
    case "budget": {
      const repo = findRepo();
      if (!positional.length && !opts.plan) return console.log(budgetOverview(repo)), 0;
      const budget = { ...budgetOf(repo) };
      const amount = Number(opts.plan?.[0] ?? positional.at(-1));
      if (!Number.isFinite(amount) || amount <= 0) throw usageError("budget");
      if (opts.plan) budget.plan = amount;
      else if (positional.length === 2) budget.tasks = { ...budget.tasks, [positional[0]!]: amount };
      else budget.perTask = amount;
      saveConfig(repo, { budget });
      console.log(`budget: ${budget.perTask !== undefined ? `${usd(budget.perTask)} per task` : "no per-task limit"}, ${budget.plan !== undefined ? `${usd(budget.plan)} for the plan` : "no plan limit"}${Object.entries(budget.tasks ?? {}).map(([id, n]) => `, ${id} ${usd(n)}`).join("")}`);
      return 0;
    }
    case "pause": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("pause");
      console.log(stopWorker(repo, findTask(repo, id), term) ? `stopped ${id}'s worker. Its work so far is in its worktree` : `${id} had no worker running`);
      return 0;
    }
    case "restart": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("restart");
      const session = requireSession(term, "restart");
      restartWorker(repo, findTask(repo, id), term, session);
      console.log(`restarted ${id}'s worker in a new tab, carrying on its last session`);
      return 0;
    }
    case "resume": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("resume");
      const session = requireSession(term, "resume");
      resume(repo, id, term, session);
      console.log(`resumed ${id}'s worker in a new tab`);
      return 0;
    }
    case "deliver": {
      const [id] = positional;
      if (!id) throw usageError("deliver");
      console.log(deliver(findRepo(), id, { dryRun: !!opts["dry-run"], title: opts.title?.[0] }).note);
      return 0;
    }
    case "status": {
      const repo = findRepo();
      const tasks = loadTasks(repo);
      if (opts.json) return console.log(JSON.stringify(tasks, null, 2)), 0;
      const p = loadPlan(repo);
      if (p) console.log(`plan: ${p.title}${p.deadline ? `, deadline ${p.deadline}` : ""}${p.approvedAt ? "" : " (not approved yet)"}`);
      const waiting = p?.approvedAt ? readyTasks(p, tasks, maxWorkers(repo)).waiting : [];
      const rows = [
        ["Task", "What it builds", "Status", "Spent", "PR"],
        ...byActivity(tasks).map((t) => [t.id, taskTitle(repo, t), statusLabel(t), usd(taskCost(repo, t).total), t.pr ? `#${t.pr}` : ""]),
        ...waiting.map((w) => [w.id, plainTitle(p!.tasks.find((t) => t.id === w.id)!.title), `planned, ${w.reason}`, "", ""]),
      ];
      if (rows.length > 1) console.log(table(rows, [3]).join("\n"));
      console.log(`watcher: ${watcherArmed(repo) ? "armed" : "not armed"}`);
      return 0;
    }
    case "watch":
      return watch(findRepo(), defaultBase(findRepo()), term);
    case "teardown": {
      const [id] = positional;
      if (!id) throw usageError("teardown");
      const r = teardown(findRepo(), id, !!opts.discard, term);
      console.log(r.message);
      return r.removed ? 0 : 3;
    }
    case "hook":
      return hook(positional[0]);
    default:
      console.error(`foreman: there's no command "${cmd}". Run foreman help to see every command.`);
      return 2;
  }
}

function plan(sub: string | undefined): number {
  const repo = findRepo();
  if (sub === "approve") {
    const p = loadPlan(repo);
    if (!p) throw new Error("no plan to approve. Run foreman plan <file> first");
    savePlan(repo, { ...p, approvedAt: new Date().toISOString() });
    console.log(`approved: ${p.title}. Run foreman next to start the first tasks`);
    return 0;
  }
  if (sub === "show" || !sub) {
    const p = loadPlan(repo);
    if (!p) return console.log("no plan"), 1;
    console.log(describePlan(p) + (p.approvedAt ? `\napproved ${p.approvedAt}` : "\nnot approved yet"));
    return 0;
  }
  const p = parsePlan(readFileSync(sub, "utf8"));
  const errors = validatePlan(p);
  if (errors.length) {
    for (const e of errors) console.log(`problem: ${e}`);
    return 1;
  }
  savePlan(repo, p);
  console.log(describePlan(p));
  console.log("Saved as a draft. Show the user, and once they approve run: foreman plan approve");
  return 0;
}

async function adr(sub: string | undefined, opts: Record<string, string[]>): Promise<number> {
  const repo = findRepo();
  const base = defaultBase(repo);
  switch (sub) {
    case "detect": {
      const snap = snapshot(repo, baseRef(repo, base), ["docs", "doc", "adr", "decisions", ".adr-dir", "CONTEXT.md"]);
      const conv = detectAdr(snap);
      const context = findContext(snap);
      saveConfig(repo, { ...(conv ? { adr: conv } : {}), ...(context ? { context } : {}) });
      if (!conv) {
        console.log(`No ADR folder on ${base}. To start one, run: foreman adr init`);
        return 1;
      }
      console.log(JSON.stringify({ base, ...conv, ...(context ? { context } : {}) }, null, 2));
      writeIndex(repo, base);
      return 0;
    }
    case "init": {
      if (loadConfig(repo).adr) throw new Error("this repo already has an ADR convention; see .foreman/config.json");
      const conv = defaultConvention(opts.dir?.[0]);
      saveConfig(repo, { adr: conv });
      console.log(`New decisions will go to ${conv.dir}, with its README, in the first decisions PR.`);
      return 0;
    }
    case "write": {
      const batch = writeAdrs(repo, { dryRun: !!opts["dry-run"], push: !opts["no-push"] && !opts["dry-run"], base });
      for (const f of batch.files) console.log(f.from && f.from !== f.file ? `move  ${f.from} -> ${f.file}` : `write ${f.file}`);
      if (opts["dry-run"]) for (const f of batch.files.filter((x) => !x.from)) console.log(`\n--- ${f.file}\n${f.content}`);
      else console.log(batch.pr ? `opened PR #${batch.pr} from ${batch.branch}` : `committed on ${batch.branch}`);
      return 0;
    }
    case "index":
      console.log(writeIndex(repo, base));
      return 0;
    default:
      throw usageError("adr");
  }
}

async function hook(event: string | undefined): Promise<number> {
  const role = process.env.FOREMAN_ROLE;
  if (role !== "worker" && role !== "orchestrator") return 0;
  const input = JSON.parse(await Bun.stdin.text()) as HookInput;
  let repo: Repo;
  try {
    repo = findRepo(input.cwd);
  } catch {
    return 0;
  }
  const ctx: LockContext =
    role === "orchestrator"
      ? { role, repo }
      : { role, repo, task: loadTasks(repo).find((t) => t.id === process.env.FOREMAN_TASK) };
  input.cwd = realpathSync(input.cwd);

  if (event === "pre-tool-use") {
    const reason = areaLock(input, ctx);
    if (reason) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    }
  } else if (event === "stop") {
    if (role === "orchestrator") console.log(JSON.stringify(stopHook(repo)));
  } else if (event === "session-start") {
    if (input.session_id) recordSession(sessionsFile(repo, role === "worker" ? process.env.FOREMAN_TASK : undefined), input.session_id);
    const additionalContext = sessionStartContext(input, ctx, terminal());
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
  }
  return 0;
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (err) {
  console.error(err instanceof UsageError ? err.message : `foreman: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
