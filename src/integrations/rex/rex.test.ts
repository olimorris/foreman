import { expect, test } from "bun:test";
import { sessionFor } from "./index.ts";

const lookup = (block: string) => (block === "block:b" ? "session:s" : undefined);

test("REX_SESSION wins and no lookup happens", () => {
  const never = () => {
    throw new Error("looked up");
  };
  expect(sessionFor({ REX_SESSION: "session:x", REX_BLOCK: "block:b" }, never)).toBe("session:x");
});

test("an empty REX_SESSION resolves REX_BLOCK to its session", () => {
  expect(sessionFor({ REX_SESSION: "", REX_BLOCK: "block:b" }, lookup)).toBe("session:s");
});

test("a failed lookup falls back to the block id", () => {
  expect(sessionFor({ REX_BLOCK: "block:zzz" }, lookup)).toBe("block:zzz");
});

test("neither set returns undefined", () => {
  expect(sessionFor({}, lookup)).toBeUndefined();
});
