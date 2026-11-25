import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, telegramPlugins, telegramSetup } from "../src/config.ts";
import { telegramChecks } from "../src/doctor.ts";
import { lastOrchestratorSession, orchestratorCommand, orchestratorModel, orchestratorTelegram } from "../src/up.ts";
import { recordSession, sessionsFile, transcriptDir } from "../src/cost.ts";
import { stableRoot } from "../src/paths.ts";
import { tempRepo } from "./helpers.ts";

test("the orchestrator's command has no --model without one", () => {
  expect(orchestratorCommand(["--plugin-dir", "/p"], "/s.sock", undefined, false)).not.toContain("--model");
});

test("the orchestrator's command passes the model to claude", () => {
  const cmd = orchestratorCommand(["--plugin-dir", "/p"], "/s.sock", "opus", false);
  expect(cmd.slice(cmd.indexOf("--model"), cmd.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
});

test("the orchestrator can't run the foreman CLI, and no foreman command is allowed", () => {
  const cmd = orchestratorCommand([], "/s.sock", undefined, false);
  expect(cmd[cmd.indexOf("--disallowedTools") + 1]).toBe("Bash(foreman *)");
  const allowed = cmd.slice(cmd.indexOf("--allowedTools") + 1, cmd.indexOf("--disallowedTools"));
  expect(allowed.length).toBeGreaterThan(0);
  expect(allowed.every((a) => a.startsWith("mcp__foreman__"))).toBe(true);
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

describe("the orchestrator's last conversation", () => {
  const always = () => true;

  test("foreman up carries on the most recent conversation the orchestrator recorded", () => {
    const repo = tempRepo();
    recordSession(sessionsFile(repo), "first");
    recordSession(sessionsFile(repo), "second");
    const last = lastOrchestratorSession(repo, always);
    expect(last).toBe("second");
    const cmd = orchestratorCommand([], "/s.sock", undefined, false, last);
    expect(cmd.slice(cmd.indexOf("--resume"), cmd.indexOf("--resume") + 2)).toEqual(["--resume", "second"]);
    expect(cmd).toContain("--agent");
    expect(cmd).not.toContain("--continue");
  });

  test("a repo with no recorded conversation starts a new one", () => {
    const repo = tempRepo();
    expect(lastOrchestratorSession(repo, always)).toBeUndefined();
    expect(orchestratorCommand([], "/s.sock", undefined, false, undefined)).not.toContain("--resume");
  });

  test("a recorded conversation Claude Code has no transcript for is skipped, since claude --resume would exit at once", () => {
    const repo = tempRepo();
    recordSession(sessionsFile(repo), "kept");
    recordSession(sessionsFile(repo), "closed-before-a-message");
    expect(lastOrchestratorSession(repo, (id) => id === "kept")).toBe("kept");
    expect(lastOrchestratorSession(repo, () => false)).toBeUndefined();
  });

  test("by default it looks for the transcript in Claude Code's folder for the repo", () => {
    const repo = tempRepo();
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
    try {
      recordSession(sessionsFile(repo), "with-transcript");
      recordSession(sessionsFile(repo), "without-transcript");
      mkdirSync(transcriptDir(repo.root), { recursive: true });
      writeFileSync(join(transcriptDir(repo.root), "with-transcript.jsonl"), "");
      expect(lastOrchestratorSession(repo)).toBe("with-transcript");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

const flag = (cmd: string[], name: string) => (cmd.includes(name) ? cmd[cmd.indexOf(name) + 1] : undefined);

describe("Telegram", () => {
  test("without the setting, the orchestrator starts as before", () => {
    const repo = tempRepo();
    expect(orchestratorTelegram(repo)).toBe(false);
    const cmd = orchestratorCommand([], "/s.sock", undefined, false);
    expect(cmd).not.toContain("--channels");
    expect(cmd).not.toContain("--settings");
  });

  test("with the setting, the orchestrator loads the installed plugin as a channel", () => {
    const cmd = orchestratorCommand([], "/s.sock", undefined, ["telegram@anthropic-plugin-directory"]);
    expect(flag(cmd, "--channels")).toBe("plugin:telegram@anthropic-plugin-directory");
    expect(JSON.parse(flag(cmd, "--settings")!)).toEqual({ enabledPlugins: { "telegram@anthropic-plugin-directory": true } });
    expect(cmd.slice(-2)).toEqual(["-n", "foreman"]);
  });

  test("with two copies installed, the orchestrator loads the official one and turns the other off", () => {
    const cmd = orchestratorCommand([], "/s.sock", undefined, ["telegram@anthropic-plugin-directory", "telegram@claude-plugins-official"]);
    expect(flag(cmd, "--channels")).toBe("plugin:telegram@claude-plugins-official");
    expect(JSON.parse(flag(cmd, "--settings")!).enabledPlugins).toEqual({ "telegram@anthropic-plugin-directory": false, "telegram@claude-plugins-official": true });
  });

  test("with the setting but no plugin installed, the orchestrator still asks for the official one", () => {
    const cmd = orchestratorCommand([], "/s.sock", undefined, []);
    expect(flag(cmd, "--channels")).toBe("plugin:telegram@claude-plugins-official");
  });

  test("the installed plugins come from Claude Code's plugin list", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-claude-"));
    expect(telegramPlugins(dir)).toEqual([]);
    mkdirSync(join(dir, "plugins"));
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "telegram@anthropic-plugin-directory": [], "slack@claude-plugins-official": [] } }));
    expect(telegramPlugins(dir)).toEqual(["telegram@anthropic-plugin-directory"]);
  });

  test("the setup reads the plugin's token and allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-telegram-"));
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(telegramSetup(dir)).toEqual({ token: false, chats: [], access: join(dir, "access.json") });
      writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
      writeFileSync(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["412587349"] }));
      expect(telegramSetup(dir)).toEqual({ token: true, chats: ["412587349"], access: join(dir, "access.json") });
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  test("foreman doctor checks the plugin only when the setting is on", () => {
    const paired = () => ({ token: true, chats: ["1"], access: "" });
    const on = { telegram: { when: "the run is finished" } };
    expect(telegramChecks({}, [], paired)).toEqual([]);
    expect(telegramChecks(on, [], paired)[0]).toMatchObject({ ok: false, detail: expect.stringContaining("/plugin install telegram@claude-plugins-official") });
    expect(telegramChecks(on, ["telegram@x"], () => ({ token: false, chats: [], access: "" }))[0]).toMatchObject({ ok: false, detail: expect.stringContaining("/telegram:configure") });
    expect(telegramChecks(on, ["telegram@x"], () => ({ token: true, chats: [], access: "" }))[0]).toMatchObject({ ok: false, detail: expect.stringContaining("/telegram:access pair") });
    expect(telegramChecks(on, ["telegram@x"], paired)[0]).toMatchObject({ ok: true });
  });

  test("an empty setting is on, with a default for when to ping", () => {
    const repo = tempRepo();
    saveConfig(repo, { telegram: {} });
    expect(orchestratorTelegram(repo)).toBeArray();
  });
});

describe("Homebrew", () => {
  const cellar = "/opt/homebrew/Cellar/foreman/0.2.0/libexec";
  const opt = "/opt/homebrew/opt/foreman/libexec";

  test("an install from Homebrew loads the plugin through the opt link, which survives brew upgrade and brew cleanup", () => {
    expect(stableRoot(cellar, (p) => p === opt)).toBe(opt);
  });

  test("without the opt link, the plugin loads from where the script runs", () => {
    expect(stableRoot(cellar, () => false)).toBe(cellar);
  });

  test("a clone loads from where it is, even when a parent folder is called Cellar", () => {
    expect(stableRoot("/Users/me/Code/Foreman", () => true)).toBe("/Users/me/Code/Foreman");
    expect(stableRoot("/Users/me/Cellar/foreman/main", () => true)).toBe("/Users/me/Cellar/foreman/main");
  });
});
