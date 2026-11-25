import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableTerminals, terminal } from "../src/integrations/index.ts";

function integrationsFolder(folders: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "foreman-integrations-"));
  for (const [name, source] of Object.entries(folders)) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "index.ts"), source);
  }
  return root;
}

const fake = (name: string) => `
  export const fake = {
    name: "${name}", sessionEnv: [], requires: [],
    currentSession: () => undefined, open: () => ({ session: "s", window: "w", pane: "p" }),
    newSession: () => "s", findSession: () => undefined, alive: () => true, send() {}, close() {},
  };`;

test("Rex is found in the real integrations folder and is the default", () => {
  expect(availableTerminals()).toContain("rex");
  expect(terminal("rex").name).toBe("Rex");
});

test("a new folder is selectable by its name with no other file edited", () => {
  const root = integrationsFolder({ rex: fake("Rex"), tmux: fake("Tmux") });
  expect(availableTerminals(root)).toEqual(["rex", "tmux"]);
  expect(terminal("tmux", root).name).toBe("Tmux");
});

test("a default export is accepted", () => {
  const root = integrationsFolder({ zellij: fake("Zellij").replace("export const fake =", "export default") });
  expect(terminal("zellij", root).name).toBe("Zellij");
});

test("folders without an index.ts and loose files are ignored", () => {
  const root = integrationsFolder({ tmux: fake("Tmux") });
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "stray.ts"), fake("Stray"));
  expect(availableTerminals(root)).toEqual(["tmux"]);
});

test("an unknown name lists what exists", () => {
  const root = integrationsFolder({ rex: fake("Rex"), tmux: fake("Tmux") });
  expect(() => terminal("nope", root)).toThrow(`there's no terminal integration called "nope". Foreman has: rex, tmux`);
});

test("a folder that exports no Terminal says what is missing", () => {
  const root = integrationsFolder({ broken: "export const x = 1;" });
  expect(() => terminal("broken", root)).toThrow("must export a Terminal");
});
