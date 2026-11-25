import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { findDecision, updateDecision } from "./ledger.ts";
import type { Repo } from "./paths.ts";
import { withLock } from "./store.ts";

export type Question = {
  id: string;
  question: string;
  call: string;
  task?: string;
  decision?: string;
  askedAt: string;
  answeredAt?: string;
  answer?: string;
  by?: "user" | "foreman";
  userAnswer?: string;
  userAnsweredAt?: string;
};

export const ANSWER_MINUTES = 30;

const questionsPath = (repo: Repo) => join(repo.foreman, "questions.jsonl");

export const answerMs = (repo: Repo) => (loadConfig(repo).answerMinutes ?? ANSWER_MINUTES) * 60_000;

// Each line is a whole question as it stood then, so an answer is one appended line and the last line for an id wins.
export function loadQuestions(repo: Repo): Question[] {
  const path = questionsPath(repo);
  if (!existsSync(path)) return [];
  const byId = new Map<string, Question>();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const q = JSON.parse(line) as Question;
      byId.set(q.id, q);
    } catch {}
  }
  return [...byId.values()];
}

export const openQuestions = (repo: Repo) => loadQuestions(repo).filter((q) => !q.answeredAt);

function withQuestions(repo: Repo, fn: (questions: Question[]) => Question): Question {
  mkdirSync(repo.foreman, { recursive: true });
  return withLock(join(repo.foreman, "questions.lock"), () => {
    const q = fn(loadQuestions(repo));
    appendFileSync(questionsPath(repo), JSON.stringify(q) + "\n");
    return q;
  });
}

export function ask(repo: Repo, q: { question: string; call: string; task?: string; decision?: string }, at = new Date()): Question {
  if (!q.question.trim()) throw new Error("ask needs the question you're putting to the user");
  if (!q.call.trim()) throw new Error('ask needs --call "<what you would do>". A question with no call of yours waits for the user, so just ask it');
  if (q.decision && findDecision(repo, q.decision).status !== "proposed") throw new Error(`${q.decision} isn't waiting for a decision`);
  return withQuestions(repo, (questions) => {
    const n = Math.max(0, ...questions.map((x) => Number(x.id.slice(2)))) + 1;
    return { id: `Q-${n}`, ...q, askedAt: at.toISOString() };
  });
}

export function answer(repo: Repo, id: string, a: { answer: string } | { byForeman: true }): Question {
  const byForeman = "byForeman" in a;
  if (!byForeman && !a.answer.trim()) throw new Error("answer needs the user's answer in their words, or --by-foreman");
  return withQuestions(repo, (questions) => {
    const q = questions.find((x) => x.id === id);
    if (!q) throw new Error(`no question ${id}`);
    const now = new Date().toISOString();
    if (q.by === "user" || q.userAnswer || (q.by === "foreman" && byForeman)) throw new Error(`${id} is already answered`);
    // A late answer sits beside Foreman's call, so the summary keeps showing a call that still stands until it's overruled.
    if (!byForeman) return q.by === "foreman" ? { ...q, userAnswer: a.answer.trim(), userAnsweredAt: now } : { ...q, answeredAt: now, answer: a.answer.trim(), by: "user" };
    if (q.decision) {
      const d = findDecision(repo, q.decision);
      if (d.status === "proposed") throw new Error(`${q.decision} is still proposed. Accept or reject it first, then run this again`);
      if (Date.parse(d.resolvedAt!) < Date.parse(q.askedAt) + answerMs(repo)) throw new Error(`${q.decision} was ${d.status} before ${id} ran out of time, so it was the user's call. Record their answer with foreman answer ${id} "<their answer>"`);
      if (d.status === "accepted") updateDecision(repo, d.id, { decidedBy: "foreman" });
    }
    return { ...q, answeredAt: now, answer: q.call, by: "foreman" };
  });
}

// Settling a decision in time can only be on the user's say-so, so its question closes as theirs and Foreman can't later claim it.
export function settleQuestions(repo: Repo, decision: string, outcome: string, at = Date.now()): void {
  const ms = answerMs(repo);
  for (const q of openQuestions(repo).filter((x) => x.decision === decision && (!ms || at < Date.parse(x.askedAt) + ms))) answer(repo, q.id, { answer: outcome });
}

export const questionTag = (q: Question) => {
  const about = [q.task, q.decision].filter(Boolean);
  return `${q.id}${about.length ? ` (${about.join(", ")})` : ""}`;
};

export function waitingLines(questions: Question[], now: number, ms: number): string[] {
  return questions.filter((q) => !q.answeredAt).map((q) => {
    const left = Math.ceil((Date.parse(q.askedAt) + ms - now) / 60_000);
    const when = !ms ? "It waits for you." : left > 0 ? `Foreman goes ahead in ${left} min.` : "Foreman is going ahead with it.";
    return `${questionTag(q)}: ${q.question} Foreman's call: ${q.call.replace(/\.$/, "")}. ${when}`;
  });
}
