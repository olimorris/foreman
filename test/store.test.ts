import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, savePlan } from "../src/plan.ts";
import { jsonStore } from "../src/store.ts";
import { tempRepo } from "./helpers.ts";

const folder = () => mkdtempSync(join(tmpdir(), "foreman-store-"));

test("a store reads as empty until its first update, which makes the folder and leaves no lock or temp file behind", () => {
  const dir = join(folder(), "nested");
  const store = jsonStore<{ n: number }>(join(dir, "count.json"), () => ({ n: 0 }));
  expect(store.read()).toEqual({ n: 0 });
  expect(store.update((v) => (v.n += 2))).toBe(2);
  expect(JSON.parse(readFileSync(join(dir, "count.json"), "utf8"))).toEqual({ n: 2 });
  expect(readdirSync(dir)).toEqual(["count.json"]);
});

test("an update that throws leaves the file as it was", () => {
  const store = jsonStore<{ n: number }>(join(folder(), "count.json"), () => ({ n: 0 }));
  store.update((v) => (v.n = 1));
  expect(() => store.update((v) => {
    v.n = 5;
    throw new Error("no");
  })).toThrow("no");
  expect(store.read()).toEqual({ n: 1 });
});

test("updates from several processes at once all land", async () => {
  const path = join(folder(), "count.json");
  const store = join(import.meta.dir, "..", "src", "store.ts");
  await Promise.all(Array.from({ length: 8 }, () => Bun.spawn(["bun", "-e", `
    const { jsonStore } = await import(${JSON.stringify(store)});
    jsonStore(${JSON.stringify(path)}, () => ({ n: 0 })).update((v) => v.n++);
  `]).exited));
  expect(jsonStore<{ n: number }>(path, () => ({ n: 0 })).read()).toEqual({ n: 8 });
});

test("plan.json takes a lock, so the worker limit, automerge and a budget reset never overwrite each other", async () => {
  const repo = tempRepo();
  savePlan(repo, { title: "Tags", tasks: [] });
  const plan = join(import.meta.dir, "..", "src", "plan.ts");
  const fields = ["maxWorkers", "automerge", "budgetResetAt", "deadline", "approvedAt", "startedAt"];
  await Promise.all(fields.map((field) => Bun.spawn(["bun", "-e", `
    const { updatePlan } = await import(${JSON.stringify(plan)});
    updatePlan(${JSON.stringify(repo)}, (p) => ({ ...p, ${field}: "set" }));
  `]).exited));
  const stored = loadPlan(repo) as unknown as Record<string, unknown>;
  expect(fields.filter((f) => stored[f] !== "set")).toEqual([]);
  expect(existsSync(join(repo.foreman, "plan.lock"))).toBe(false);
});
