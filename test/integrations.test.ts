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

const fake = (name: string, termProgram = name.toLowerCase()) => `
  export const fake = {
    name: "${name}", sessionEnv: [], requires: [], inside: (env) => env.TERM_PROGRAM === "${termProgram}",
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

test("FOREMAN_TERMINAL wins over the terminal Foreman runs inside", () => {
  const root = integrationsFolder({ rex: fake("Rex"), tmux: fake("Tmux") });
  expect(terminal(undefined, root, { FOREMAN_TERMINAL: "rex", TERM_PROGRAM: "tmux" }).name).toBe("Rex");
});

test("without FOREMAN_TERMINAL, the integration that says it's running inside its terminal is used", () => {
  const root = integrationsFolder({ rex: fake("Rex"), tmux: fake("Tmux") });
  expect(terminal(undefined, root, { TERM_PROGRAM: "tmux" }).name).toBe("Tmux");
});

test("Rex is the fallback when no integration says it's running inside its terminal", () => {
  const root = integrationsFolder({ rex: fake("Rex"), tmux: fake("Tmux") });
  expect(terminal(undefined, root, { TERM_PROGRAM: "Apple_Terminal" }).name).toBe("Rex");
  expect(terminal(undefined, root, {}).name).toBe("Rex");
  expect(terminal(undefined, root, { FOREMAN_TERMINAL: "" }).name).toBe("Rex");
});

test("an integration without an inside check is only used when FOREMAN_TERMINAL names it", () => {
  const root = integrationsFolder({ rex: fake("Rex"), zellij: fake("Zellij").replace(/inside: [^,]+,/, "") });
  expect(terminal(undefined, root, { TERM_PROGRAM: "zellij" }).name).toBe("Rex");
  expect(terminal(undefined, root, { FOREMAN_TERMINAL: "zellij" }).name).toBe("Zellij");
});

test("a broken integration doesn't stop Foreman detecting another terminal", () => {
  const root = integrationsFolder({
    broken: "throw new Error('broken on load');",
    empty: "export const x = 1;",
    rex: fake("Rex"),
    throws: fake("Throws").replace(/inside: [^,]+,/, "inside: () => { throw new Error('no'); },"),
    tmux: fake("Tmux"),
  });
  expect(terminal(undefined, root, { TERM_PROGRAM: "tmux" }).name).toBe("Tmux");
  expect(terminal(undefined, root, {}).name).toBe("Rex");
});

test("two integrations that both say they're running inside their terminal ask for FOREMAN_TERMINAL", () => {
  const root = integrationsFolder({ rex: fake("Rex"), tmux: fake("Tmux"), zellij: fake("Zellij", "tmux") });
  expect(() => terminal(undefined, root, { TERM_PROGRAM: "tmux" })).toThrow(
    "Foreman can't tell which terminal it's in: both tmux and zellij match. Set FOREMAN_TERMINAL to the one you're running in",
  );
});

test("each real integration is picked from the environment its terminal sets", () => {
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "rex", REX_SESSION: "s1" }).name).toBe("Rex");
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "ghostty" }).name).toBe("Ghostty");
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "Orca" }).name).toBe("Orca");
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "herdr" }).name).toBe("Herdr");
  expect(terminal(undefined, undefined, { TERM_PROGRAM: "Apple_Terminal" }).name).toBe("Rex");
});
