import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adrLayout, adrSkill, loadSkills, prSkill, skillsDir } from "../src/skills.ts";
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

test("a skill is named by its folder, so a copied ADR skill becomes the adr skill", () => {
  const repo = tempRepo();
  addSkill(skillsDir(repo), "adr", "---\nname: documentation-and-adrs\ndescription: Records decisions.\n---\n\n```markdown\n# ADR-001: Title\n\n## Status\n\nAccepted\n```\n");
  const skills = loadSkills(repo);
  expect(adrSkill(skills)?.name).toBe("adr");
  expect(adrLayout(skills)).toMatchObject({ title: "# ADR-{N}: {title}", status: { kind: "section" } });
  expect(adrLayout([])).toBeUndefined();
});
