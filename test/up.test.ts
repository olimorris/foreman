import { expect, test } from "bun:test";
import { saveConfig } from "../src/config.ts";
import { orchestratorCommand, orchestratorModel } from "../src/up.ts";
import { tempRepo } from "./helpers.ts";

test("the orchestrator's command has no --model without one", () => {
  expect(orchestratorCommand(["--plugin-dir", "/p"], "/s.sock")).not.toContain("--model");
});

test("the orchestrator's command passes the model to claude", () => {
  const cmd = orchestratorCommand(["--plugin-dir", "/p"], "/s.sock", "opus");
  expect(cmd.slice(cmd.indexOf("--model"), cmd.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
});

test("orchestratorModel comes from the config, and --model wins", () => {
  const repo = tempRepo();
  expect(orchestratorModel(repo)).toBeUndefined();
  saveConfig(repo, { orchestratorModel: "opus" });
  expect(orchestratorModel(repo)).toBe("opus");
  expect(orchestratorModel(repo, "haiku")).toBe("haiku");
});

test("a bad model name fails and says where it came from", () => {
  const repo = tempRepo();
  saveConfig(repo, { orchestratorModel: "opuss" });
  expect(() => orchestratorModel(repo)).toThrow("orchestratorModel in .foreman/config.json");
  expect(() => orchestratorModel(repo, "sonet")).toThrow("--model");
});
