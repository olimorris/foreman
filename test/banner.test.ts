import { expect, test } from "bun:test";
import { banner } from "../src/banner.ts";

test("the banner is yellow at a terminal, plain with NO_COLOR, and absent when output is piped", () => {
  expect(banner({ isTTY: true }, {})).toStartWith("\x1b[33m    ______");
  expect(banner({ isTTY: true }, { NO_COLOR: "1" })).not.toContain("\x1b[");
  expect(banner({ isTTY: false }, {})).toBeUndefined();
});
