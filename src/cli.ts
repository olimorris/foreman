import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { defaultConvention, detectAdr } from "./adr.ts";
import { writeAdrs } from "./adrwrite.ts";
import { adrLayout, loadSkills } from "./skills.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { accept, findContext, reject, writeIndex } from "./decisions.ts";
import { doctor } from "./doctor.ts";
import { printBanner } from "./banner.ts";
import { helpText, usageError, UsageError } from "./help.ts";
import { statusView } from "./status.ts";
import { styleFor } from "./style.ts";
import { findDecision, loadDecisions, propose } from "./ledger.ts";
import { answer, answerMs, ask, loadQuestions, waitingLines } from "./questions.ts";
import { baseRef, snapshot } from "./snapshot.ts";
import { runReview, sendFeedback, startReview } from "./review.ts";
import { capture, parseScreens } from "./shots.ts";
import { join } from "node:path";
import { appendEvent, logRun, REPORT_TYPES, type ReportType } from "./events.ts";
import { areaLock, hookWho, recordHookBlock, sessionStartContext, stopHook, type HookInput, type LockContext } from "./hooks.ts";
import { blockSummary, unblock } from "./permissions.ts";
import { defaultBase, findRepo, pluginArgs, pluginRoot, socketPath, type Repo } from "./paths.ts";
import { terminal } from "./integrations/index.ts";
import { requireSession } from "./terminal.ts";
import { notifyOrchestrator, sendToTask } from "./send.ts";
import { ensureForeman, plainTitle, spawn } from "./spawn.ts";
import { budgetOverview, byActivity, statusLabel, table, taskTitle } from "./overview.ts";
import { findTask, inFlight, loadTasks, updateTask } from "./state.ts";
import { orchestratorCommand, orchestratorModel } from "./up.ts";
import { serve, SERVER_NAME } from "./mcp.ts";
import { skillsCapability } from "./skillserver.ts";
import { teardown } from "./teardown.ts";
import { setTrust } from "./trust.ts";
import { deliver } from "./deliver.ts";
import { describePlan, loadPlan, maxWorkers, parsePlan, planBrief, readyTasks, savePlan, stackable, validatePlan, workers } from "./plan.ts";
import { sync } from "./sync.ts";
import { forTerminal, openPrs, page, writeSummary } from "./summary.ts";
import { together } from "./together.ts";
import { timelineText } from "./timeline.ts";
import { automerge } from "./automerge.ts";
import { budgetLeft, budgetOf, orchestratorCost, recordSession, sessionsFile, taskCost, usd } from "./cost.ts";
import { restartWorker, resume, stopWorker } from "./stop.ts";
import { activeLimit, limitLine } from "./limits.ts";
import { watch, watcherArmed } from "./watch.ts";
import { gatherPane, livePane, openPane, renderPane, spendByTask } from "./pane.ts";
import { addNote, listNotes, loadNotes, newNoteMessage, removedNoteMessage, removeNote, shareNote } from "./notes.ts";
import { BASELINE_RUNS, baseline, baselineStatus, TEST_MINUTES } from "./baseline.ts";
import { names, tidy, unstoppableLine } from "./procs.ts";


function flags(args: string[]): { positional: string[]; opts: Record<string, string[]> } {
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (["--json", "--discard", "--all", "--dry-run", "--no-push", "--once", "--live", "--by-foreman"].includes(a)) opts[a.slice(2)] = ["true"];
    else (opts[a.slice(2)] ??= []).push(args[++i] ?? "");
  }
  return { positional, opts };
}

function version(): string {
  return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
}

function serveMcp(): Promise<void> {
  const repo = findRepo();
  return serve({ name: SERVER_NAME, version: version(), capabilities: [skillsCapability(repo)] });
}

const onModel = (task: { model?: string }) => (task.model ? `, on ${task.model}` : ", on Claude Code's default model");

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // Claude Code starts the server, and anything else on stdout would break its protocol.
  if (cmd === "mcp") return await serveMcp(), 0;
  const term = terminal();
  const { positional, opts } = flags(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      return 0;
    case "version":
    case "--version":
      console.log(version());
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
      const model = orchestratorModel(repo, opts.model?.[0]);
      const name = `foreman-${basename(repo.root)}`;
      const existing = term.findSession(name);
      if (existing) return console.log(`${term.name} session ${name} already exists (${existing})`), 0;
      // Claude Code's trust prompt would otherwise swallow the user's first message and exit.
      setTrust(repo.root, true);
      const session = term.newSession(name, repo.root, orchestratorCommand(pluginArgs(), socketPath(repo, "orchestrator"), model));
      console.log(`Started the orchestrator in ${term.name} session ${name} (${session})${onModel({ model })}`);
      try {
        openPane(repo, term, session);
      } catch (err) {
        console.log(`Couldn't open the status pane: ${err instanceof Error ? err.message : err}. Run foreman pane to try again`);
      }
      return 0;
    }
    case "spawn": {
      const repo = findRepo();
      const [id] = positional;
      if (!id || !opts.brief?.[0]) throw usageError("spawn");
      const wait = activeLimit(repo);
      if (wait) throw new Error(`no new tasks start: ${limitLine(wait)}`);
      const session = requireSession(term, "spawn");
      const left = budgetLeft(repo, loadTasks(repo));
      if (left.reason) throw new Error(`no new tasks start: ${left.reason}`);
      const task = spawn(repo, { id, title: opts.title?.[0], model: opts.model?.[0], brief: opts.brief[0], owns: opts.owns ?? [], base: opts.base?.[0] ?? defaultBase(repo), session }, term);
      console.log(`spawned ${task.id}: ${task.worktree} on ${task.branch}, ${term.name} tab ${task.tab?.window}${onModel(task)}`);
      return 0;
    }
    case "send": {
      const repo = findRepo();
      const [id, ...words] = positional;
      if (!id) throw usageError("send");
      const text = words.length ? words.join(" ") : await Bun.stdin.text();
      const task = findTask(repo, id);
      console.log(`sent to ${id} via ${sendToTask(repo, task, text.trim(), term)}`);
      // The orchestrator answers a blocked worker or its question with a message, after which the worker is working again.
      if (task.status === "blocked" || task.status === "needs-decision") updateTask(repo, id, { status: "running" });
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
    case "ask": {
      const repo = findRepo();
      if (process.env.FOREMAN_TASK) throw new Error("only the orchestrator records questions. Report needs-decision instead");
      if (!positional.length || !opts.call?.[0]) throw usageError("ask");
      const decision = opts.decision?.[0];
      const proposer = decision ? findDecision(repo, decision).by : undefined;
      const task = opts.task?.[0] ?? (proposer !== "orchestrator" ? proposer : undefined);
      if (task) findTask(repo, task);
      const q = ask(repo, { question: positional.join(" "), call: opts.call[0], ...(task ? { task } : {}), ...(decision ? { decision } : {}) });
      const minutes = answerMs(repo) / 60_000;
      console.log(`recorded ${q.id}. Ask the user in your own words. ${minutes ? `If they don't answer within ${minutes} min, the watcher wakes you to go ahead with your call` : "answerMinutes is 0, so it waits for the user"}`);
      return 0;
    }
    case "answer": {
      const repo = findRepo();
      const [id, ...words] = positional;
      if (!id || (!words.length && !opts["by-foreman"])) throw usageError("answer");
      const q = answer(repo, id, opts["by-foreman"] ? { byForeman: true } : { answer: words.join(" ") });
      console.log(q.by === "foreman" ? `recorded that Foreman went ahead with ${id}. It shows in the run summary so the user can check it` : `recorded the user's answer to ${id}`);
      return 0;
    }
    case "decisions": {
      const repo = findRepo();
      const ds = loadDecisions(repo).filter((d) => opts.all || d.status === "proposed" || (d.status === "accepted" && !d.adr));
      for (const d of ds) console.log(`${d.id.padEnd(6)} ${d.status.padEnd(9)} ${d.by.padEnd(12)} ${d.title}${d.decidedBy ? " (decided by Foreman)" : ""}`);
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
      const wait = activeLimit(repo);
      if (wait) throw new Error(`no new tasks start: ${limitLine(wait)}`);
      
      const session = requireSession(term, "next");
      const room = budgetLeft(repo, loadTasks(repo));
      if (room.reason) throw new Error(`no new tasks start: ${room.reason}`);
      const max = maxWorkers(repo, opts.max?.[0]);
      const { start, waiting } = readyTasks(p, loadTasks(repo), max, stackable(repo));
      for (const t of start) {
        const task = spawn(repo, { id: t.id, title: t.title, model: t.model, brief: planBrief(repo, t.id), owns: t.owns, base: defaultBase(repo), session, stackedOn: t.stackedOn }, term);
        console.log(`spawned ${t.id}: ${t.title}${t.stackedOn ? ` (on top of ${t.stackedOn}'s branch, which isn't merged yet)` : ""}${onModel(task)}`);
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
      for (const id of r.mergedEarly) console.log(`${id}'s PR merged into ${findTask(repo, id).mergedInto}, not ${base}. Keep ${id} until that branch merges`);
      if (r.asked.length) console.log(`asked to rebase: ${r.asked.join(", ")}`);
      for (const id of r.retargeted) console.log(`moved ${id}'s PR to ${base}`);
      if (r.failed.length) console.log(`couldn't reach: ${r.failed.join(", ")}`);
      return 0;
    }
    case "summary": {
      const path = writeSummary(findRepo());
      // The orchestrator runs this too, and a pager would wait forever for a q nobody types.
      if (!process.stdout.isTTY) return console.log(`wrote ${path}`), 0;
      const md = readFileSync(path, "utf8");
      await page(process.env.NO_COLOR ? md : forTerminal(md));
      return 0;
    }
    case "together": {
      const repo = findRepo();
      const r = await together(repo, defaultBase(repo), () => openPrs(repo), { fetch: true });
      console.log(r.line);
      if (r.result) notifyOrchestrator(repo, r.line);
      return 0;
    }
    case "timeline":
      console.log(timelineText(findRepo(), positional[0]));
      return 0;
    case "cost": {
      const repo = findRepo();
      const budget = budgetOf(repo);
      const tasks = loadTasks(repo);
      const costs = tasks.map((t) => taskCost(repo, t));
      const orch = orchestratorCost(repo);
      for (const [i, c] of costs.entries()) {
        const limit = budget?.tasks?.[c.id] ?? budget?.perTask;
        const model = tasks[i]!.model;
        console.log(`${c.id.padEnd(8)} ${usd(c.total).padStart(8)}  worker ${usd(c.worker)}${model ? ` on ${model}` : ""}, reviews ${usd(c.review)}${limit !== undefined ? `, limit ${usd(limit)}` : ""}`);
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
      if (!positional.length && !opts.plan) return console.log(budgetOverview(repo, styleFor())), 0;
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
    case "workers":
      for (const line of workers(findRepo(), positional)) console.log(line);
      return 0;
    case "automerge":
      for (const line of automerge(findRepo(), positional)) console.log(line);
      return 0;
    case "pause": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("pause");
      const stopped = stopWorker(repo, findTask(repo, id), term);
      if (stopped) logRun(repo, id, "paused");
      console.log(stopped ? `stopped ${id}'s worker. Its work so far is in its worktree` : `${id} had no worker running`);
      return 0;
    }
    case "restart": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("restart");
      const session = requireSession(term, "restart");
      const task = restartWorker(repo, findTask(repo, id), term, session, opts.model?.[0]);
      logRun(repo, id, "restarted");
      console.log(`restarted ${id}'s worker in a new tab, carrying on its last session${onModel(task)}`);
      return 0;
    }
    case "resume": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("resume");
      const session = requireSession(term, "resume");
      const task = resume(repo, id, term, session, opts.model?.[0]);
      logRun(repo, id, "resumed");
      console.log(`resumed ${id}'s worker in a new tab${onModel(task)}`);
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
      console.log(statusView(repo, styleFor(), watcherArmed(repo)));
      const tested = baselineStatus(repo);
      if (tested) console.log(tested);
      const asking = waitingLines(loadQuestions(repo), Date.now(), answerMs(repo));
      if (asking.length) console.log(["", "Questions waiting on you", ...asking.map((l) => `  ${l}`)].join("\n"));
      return 0;
    }
    case "pane": {
      const repo = findRepo();
      if (opts.live) return livePane(repo, term);
      if (opts.once) return console.log(renderPane(gatherPane(repo, Date.now(), spendByTask(repo)), Math.max(30, (process.stdout.columns ?? 72) - 1), !!process.stdout.isTTY && !process.env.NO_COLOR).join("\n")), 0;
      const opened = openPane(repo, term, requireSession(term, "pane"), term.currentPane?.());
      console.log(opened ? "opened the status pane" : "the status pane is already open");
      return 0;
    }
    case "watch":
      return watch(findRepo(), defaultBase(findRepo()), term);
    case "tidy": {
      const repo = findRepo();
      const id = positional[0] ?? process.env.FOREMAN_TASK;
      if (!id) throw usageError("tidy");
      const r = tidy(findTask(repo, id));
      if (r.stopped.length) console.log(`stopped what ${id}'s old runs left behind: ${names(r.stopped)}`);
      if (r.failed.length) console.log(unstoppableLine(r.failed));
      if (!r.stopped.length && !r.failed.length) console.log(`${id} has no processes left over from old runs`);
      return r.failed.length ? 1 : 0;
    }
    case "teardown": {
      const [id] = positional;
      if (!id) throw usageError("teardown");
      const r = teardown(findRepo(), id, !!opts.discard, term);
      console.log(r.message);
      return r.removed ? 0 : 3;
    }
    case "note": {
      const repo = findRepo();
      const by = process.env.FOREMAN_TASK ?? "orchestrator";
      ensureForeman(repo);
      const told = (s: { sent: string[]; failed: string[] }) => `Told: ${s.sent.join(", ") || "nobody"}${s.failed.length ? `. Couldn't reach: ${s.failed.join(", ")}` : ""}`;
      if (opts.remove) {
        const note = removeNote(repo, Number(opts.remove[0]));
        console.log(`removed note ${opts.remove[0]}: ${note.text}. ${told(shareNote(repo, removedNoteMessage(note), by, term))}`);
        return 0;
      }
      if (!positional.length) throw usageError("note");
      const note = addNote(repo, positional.join(" "), by);
      if (!note) return console.log("that note is already there"), 0;
      console.log(`added note ${loadNotes(repo).length}. ${told(shareNote(repo, newNoteMessage(repo, note), by, term))}`);
      return 0;
    }
    case "notes": {
      const notes = loadNotes(findRepo());
      console.log(notes.length ? listNotes(notes).join("\n") : 'no notes yet. Add one with foreman note "<fact>"');
      return 0;
    }
    case "baseline": {
      const repo = findRepo();
      const runs = Number(opts.runs?.[0] ?? BASELINE_RUNS);
      if (!Number.isInteger(runs) || runs < 1) throw usageError("baseline");
      ensureForeman(repo);
      if (opts.test?.[0]) saveConfig(repo, { test: opts.test[0] });
      const config = loadConfig(repo);
      if (!config.test) throw new Error('no test command in .foreman/config.json. Save one with foreman baseline --test "<command>"');
      try {
        console.log((await baseline(repo, { base: defaultBase(repo), command: config.test, minutes: config.testMinutes ?? TEST_MINUTES, runs, term })).line);
      } catch (err) {
        // It runs in the background, so a failure nobody is told about would look like a baseline still going.
        notifyOrchestrator(repo, `[foreman baseline] failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
      return 0;
    }
    case "unblock": {
      const id = positional[0];
      if (!id) throw usageError("unblock");
      const repo = findRepo();
      findTask(repo, id);
      const closed = unblock(repo, id);
      console.log(closed.length ? closed.map((b) => `closed: ${blockSummary(b)}`).join("\n") : `${id} has no open permission blocks`);
      return 0;
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
    console.log(describePlan(p, loadConfig(repo).workerModel) + (p.approvedAt ? `\napproved ${p.approvedAt}` : "\nnot approved yet"));
    return 0;
  }
  const p = parsePlan(readFileSync(sub, "utf8"));
  const errors = validatePlan(p);
  if (errors.length) {
    for (const e of errors) console.log(`problem: ${e}`);
    return 1;
  }
  savePlan(repo, p);
  console.log(describePlan(p, loadConfig(repo).workerModel));
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
      const layout = adrLayout(loadSkills(repo));
      const conv = defaultConvention(opts.dir?.[0], layout);
      saveConfig(repo, { adr: conv });
      console.log(`New decisions will go to ${conv.dir}, with its README, in the first decisions PR.${layout ? " They follow the layout in your adr skill." : ""}`);
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
  if (role !== "worker" && role !== "orchestrator" && role !== "reviewer") return 0;
  const input = JSON.parse(await Bun.stdin.text()) as HookInput;
  let repo: Repo;
  try {
    repo = findRepo(input.cwd);
  } catch {
    return 0;
  }
  // Prints nothing, so the prompt still shows and the refusal stands.
  if (event === "permission-request" || event === "permission-denied") {
    recordHookBlock(repo, event, input, hookWho(role, process.env.FOREMAN_TASK, realpathSync(input.cwd), loadTasks(repo)));
    return 0;
  }
  if (role === "reviewer") return 0;
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
