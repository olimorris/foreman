import { expect, test } from "bun:test";
import { table } from "../src/overview.ts";
import { plainTitle } from "../src/spawn.ts";

test("table lines up columns and right-aligns the ones asked for", () => {
  expect(table([["Task", "Spent"], ["T1", "$5.00"], ["T10", "$12.50"]], [1])).toEqual(["Task   Spent", "T1     $5.00", "T10   $12.50"]);
});

test("plainTitle drops the conventional commit type and scope", () => {
  expect(plainTitle("feat(captions)!: word-by-word captions")).toBe("word-by-word captions");
  expect(plainTitle("add tags")).toBe("add tags");
});
