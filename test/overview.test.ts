import { expect, test } from "bun:test";
import { bar, budgetOverview, table, taskTitle } from "../src/overview.ts";
import { PLAIN } from "../src/style.ts";
import type { Task } from "../src/state.ts";
import { tempRepo } from "./helpers.ts";
import { saveConfig } from "../src/config.ts";
import { plainTitle } from "../src/spawn.ts";

test("table lines up columns and right-aligns the ones asked for", () => {
  expect(table([["Task", "Spent"], ["T1", "$5.00"], ["T10", "$12.50"]], [1])).toEqual(["Task   Spent", "T1     $5.00", "T10   $12.50"]);
});

test("the spend bar fills with spend against the limit, and is empty with no limit", () => {
  expect(bar(15, 60, PLAIN)).toBe("███░░░░░░░░░");
  expect(bar(90, 60, PLAIN)).toBe("████████████");
  expect(bar(5, undefined, PLAIN)).toBe("");
});

test("plainTitle drops the conventional commit type and scope", () => {
  expect(plainTitle("feat(captions)!: word-by-word captions")).toBe("word-by-word captions");
  expect(plainTitle("add tags")).toBe("add tags");
});

test("a task's title carries its model, and a long title is cut to make room", () => {
  const repo = tempRepo();
  const task = (title: string, model?: string) => ({ id: "T1", title, ...(model ? { model } : {}) }) as Task;
  expect(taskTitle(repo, task("docs: explain tags", "haiku"))).toBe("explain tags (haiku)");
  expect(taskTitle(repo, task("docs: explain tags"))).toBe("explain tags");
  const long = taskTitle(repo, task(`feat: ${"word ".repeat(20)}`, "sonnet"));
  expect(long).toEndWith("... (sonnet)");
  expect(long.length).toBeLessThanOrEqual(44);
});

test("a long model id is shortened, so the title keeps its room", () => {
  const repo = tempRepo();
  const task = (model: string) => ({ id: "T1", title: `feat: ${"word ".repeat(20)}`, model }) as Task;
  expect(taskTitle(repo, task("claude-sonnet-5-5"))).toEndWith("... (sonnet 5.5)");
  const arn = taskTitle(repo, task("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcdef"));
  expect(arn).toStartWith("word word word word word");
  expect(arn).toEndWith("(arn:aws:bed...)");
  expect(arn.length).toBeLessThanOrEqual(44);
});

test("a task on workerModel shows no model, since every task would say the same", () => {
  const repo = tempRepo();
  saveConfig(repo, { workerModel: "sonnet" });
  const task = (model: string) => ({ id: "T1", title: "docs: explain tags", model }) as Task;
  expect(taskTitle(repo, task("sonnet"))).toBe("explain tags");
  expect(taskTitle(repo, task("opus"))).toBe("explain tags (opus)");
});

test("budgetOverview ends with the foreman budget line unless the caller names its own", () => {
  const repo = tempRepo();
  expect(budgetOverview(repo)).toContain("foreman budget --plan <usd>");
  const text = budgetOverview(repo, PLAIN, "Change a limit with set_budget.");
  expect(text.endsWith("Change a limit with set_budget.")).toBe(true);
  expect(text).not.toContain("foreman budget");
});
