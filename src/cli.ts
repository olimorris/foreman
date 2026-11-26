import { readFileSync, realpathSync } from "node:fs";
import { doctor } from "./doctor.ts";
import { printBanner } from "./banner.ts";
import { goneText, helpText, usageError, UsageError } from "./help.ts";
import { statusText } from "./status.ts";
import { mcpArgs, serve, SERVER_NAME } from "./mcp.ts";
import { TOOLS } from "./tools/index.ts";
import { asRole } from "./tools/tool.ts";
import { styleFor } from "./style.ts";
import { runReview } from "./review.ts";
import { join } from "node:path";
import { areaLock, hookWho, mergeOrPush, recordHookBlock, sessionStartContext, stopHook, type HookInput, type LockContext } from "./hooks.ts";
import { ensureForeman, findRepo, pluginRoot, socketPath, type Repo } from "./paths.ts";
import { terminal } from "./integrations/index.ts";
import { requireSession, type Terminal } from "./terminal.ts";
import { budgetOverview } from "./overview.ts";
import { findTask, loadTasks } from "./state.ts";
import { lastOrchestratorSession, orchestratorCommand, orchestratorModel, orchestratorPlugins } from "./up.ts";
import { setTrust } from "./trust.ts";
import { workers } from "./plan.ts";
import { forTerminal, page, summaryText, writeSummary } from "./summary.ts";
import { timelineText } from "./timeline.ts";
import { orchestratorSessionName, removeForeman } from "./remove.ts";
import { automerge } from "./automerge.ts";
import { budgetLine, costText, resetBudget, setBudget } from "./cost.ts";
import { recordSession, sessionsFile } from "./transcripts.ts";
import { restartedLine, restartWorker, resume, resumedLine } from "./stop.ts";
import { onModel } from "./spawn.ts";
import { gatherPane, livePane, openPane, renderPane, spendByTask } from "./pane.ts";
import { changeNotes, listNotes, loadNotes } from "./notes.ts";

function version(): string {
  return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
}

function serveMcp(): Promise<void> {
  let term: Terminal | undefined;
  return serve({ name: SERVER_NAME, version: version(), tools: TOOLS, session: { role: asRole(process.env.FOREMAN_ROLE), task: process.env.FOREMAN_TASK, repo: findRepo(), term: () => (term ??= terminal()) } });
}

function flags(args: string[]): { positional: string[]; opts: Record<string, string[]> } {
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (["--json", "--once", "--live", "--discard", "--new"].includes(a)) opts[a.slice(2)] = ["true"];
    else (opts[a.slice(2)] ??= []).push(args[++i] ?? "");
  }
  return { positional, opts };
}

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
      const name = orchestratorSessionName(repo);
      const existing = term.findSession(name);
      if (existing) return console.log(`${term.name} session ${name} already exists (${existing})`), 0;
      // Claude Code's trust prompt would otherwise swallow the user's first message and exit.
      setTrust(repo.root, true);
      const last = opts.new ? undefined : lastOrchestratorSession(repo);
      const session = term.newSession(name, repo.root, orchestratorCommand([...orchestratorPlugins(repo), ...mcpArgs("orchestrator")], socketPath(repo, "orchestrator"), model, undefined, last));
      console.log(`Started the orchestrator in ${term.name} session ${name} (${session})${onModel({ model })}, ${last ? "carrying on its last conversation" : "in a new conversation"}`);
      try {
        openPane(repo, term, session);
      } catch (err) {
        console.log(`Couldn't open the status pane: ${err instanceof Error ? err.message : err}. Run foreman pane to try again`);
      }
      return 0;
    }
    // The review tool opens a tab that runs this, so it stays off the help page.
    case "review-run": {
      const [id] = positional;
      if (!id) throw usageError("review-run");
      console.log(await runReview(findRepo(), id));
      return 0;
    }
    case "summary": {
      if (!process.stdout.isTTY) return console.log(summaryText(findRepo())), 0;
      const md = readFileSync(writeSummary(findRepo()), "utf8");
      await page(process.env.NO_COLOR ? md : forTerminal(md));
      return 0;
    }
    case "timeline":
      console.log(timelineText(findRepo(), positional[0]));
      return 0;
    case "cost":
      console.log(costText(findRepo()));
      return 0;
    case "budget": {
      const repo = findRepo();
      if (!positional.length && !opts.plan) return console.log(budgetOverview(repo, styleFor())), 0;
      if (positional.length === 1 && positional[0] === "reset" && !opts.plan) return resetBudget(repo).forEach((line) => console.log(line)), 0;
      const amount = Number(opts.plan?.[0] ?? positional.at(-1));
      if (!Number.isFinite(amount) || amount <= 0) throw usageError("budget");
      console.log(budgetLine(setBudget(repo, { usd: amount, task: positional.length === 2 ? positional[0] : undefined, plan: !!opts.plan })));
      return 0;
    }
    case "workers":
      for (const line of workers(findRepo(), positional)) console.log(line);
      return 0;
    case "automerge":
      for (const line of automerge(findRepo(), positional)) console.log(line);
      return 0;
    case "restart": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("restart");
      const session = requireSession(term, "restart");
      console.log(restartedLine(restartWorker(repo, findTask(repo, id), term, session, { model: opts.model?.[0] })));
      return 0;
    }
    case "resume": {
      const repo = findRepo();
      const [id] = positional;
      if (!id) throw usageError("resume");
      const session = requireSession(term, "resume");
      console.log(resumedLine(resume(repo, id, term, session, { model: opts.model?.[0] })));
      return 0;
    }
    case "status": {
      const repo = findRepo();
      if (opts.json) return console.log(JSON.stringify(loadTasks(repo), null, 2)), 0;
      console.log(statusText(repo, styleFor()));
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
    case "note": {
      const repo = findRepo();
      const by = process.env.FOREMAN_TASK ?? "orchestrator";
      if (!opts.remove && !positional.length) throw usageError("note");
      console.log(changeNotes(repo, opts.remove ? { remove: Number(opts.remove[0]) } : { add: positional.join(" ") }, by, term));
      return 0;
    }
    case "notes": {
      const notes = loadNotes(findRepo());
      console.log(notes.length ? listNotes(notes).join("\n") : 'no notes yet. Add one with foreman note "<fact>"');
      return 0;
    }
    case "remove": {
      const result = removeForeman(findRepo(), !!opts.discard, term);
      console.log(result.message);
      return result.removed ? 0 : 1;
    }
    case "hook":
      return hook(positional[0]);
    default:
      if (goneText(cmd)) return console.error(goneText(cmd)), 2;
      console.error(`foreman: there's no command "${cmd}". Run foreman help to see every command.`);
      return 2;
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
  if (role === "reviewer") {
    if (event === "pre-tool-use") denyTool(mergeOrPush(input));
    return 0;
  }
  const ctx: LockContext =
    role === "orchestrator"
      ? { role, repo }
      : { role, repo, task: loadTasks(repo).find((t) => t.id === process.env.FOREMAN_TASK) };
  input.cwd = realpathSync(input.cwd);

  if (event === "pre-tool-use") {
    denyTool(areaLock(input, ctx));
  } else if (event === "stop") {
    if (role === "orchestrator") console.log(JSON.stringify(stopHook(repo)));
  } else if (event === "session-start") {
    if (input.session_id) recordSession(sessionsFile(repo, role === "worker" ? process.env.FOREMAN_TASK : undefined), input.session_id);
    const additionalContext = sessionStartContext(input, ctx, terminal());
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
  }
  return 0;
}

function denyTool(reason: string | undefined) {
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (err) {
  console.error(err instanceof UsageError ? err.message : `foreman: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
