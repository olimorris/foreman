import { expect, test } from "bun:test";
import { bar, table } from "../src/overview.ts";
import { PLAIN } from "../src/style.ts";
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
