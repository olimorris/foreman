import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills, prSkill, skillsDir } from "../src/skills.ts";
import { tempRepo } from "./helpers.ts";

function addSkill(dir: string, folder: string, text: string) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "SKILL.md"), text);
}

test("there are no skills without a .foreman/skills folder", () => {
  expect(loadSkills(tempRepo())).toEqual([]);
});

test("loadSkills reads each folder's SKILL.md in Claude Code's format", () => {
  const repo = tempRepo();
  const dir = skillsDir(repo);
  addSkill(dir, "pull-request", "---\nname: pull-request\ndescription: \"Write the PR. Use when opening a PR.\"\n---\n\n# PRs\n\nOne line commits.\n");
  addSkill(dir, "review", "---\ndescription: Review code for this repo.\n---\nNo TODOs.\n");
  addSkill(dir, "plain", "Just a body.\n");
  mkdirSync(join(dir, "empty"), { recursive: true });

  const skills = loadSkills(repo);
  expect(skills.map((s) => s.name)).toEqual(["plain", "pull-request", "review"]);
  expect(skills[1]).toEqual({ name: "pull-request", description: "Write the PR. Use when opening a PR.", body: "# PRs\n\nOne line commits.", path: join(dir, "pull-request", "SKILL.md") });
  expect(skills[2]).toMatchObject({ name: "review", description: "Review code for this repo.", body: "No TODOs." });
  expect(skills[0]).toMatchObject({ description: "", body: "Just a body." });
  expect(prSkill(skills)?.name).toBe("pull-request");
  expect(prSkill(skills.filter((s) => s.name !== "pull-request"))).toBeUndefined();
});
