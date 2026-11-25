import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { invalidParams, type Capability, type Params } from "./mcp.ts";
import { skillsDir } from "./skills.ts";
import type { Repo } from "./paths.ts";

// Serves .foreman/skills over MCP's skills extension, so sessions working in a worktree load the user's skills without copying them into it.

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

type File = { uri: string; bytes: Uint8Array };
type Served = { uri: string; frontmatter: Record<string, unknown>; files: File[] };

// Short, so a skill the user adds or edits mid-run reaches sessions soon after.
const CACHE = { ttlMs: 30_000, cacheScope: "private" };

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

const MIME: Record<string, string> = { ".md": "text/markdown", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf" };

export function skillsCapability(repo: Repo): Capability {
  const all = () => servedSkills(skillsDir(repo));
  const find = (uri: unknown) => {
    const skill = all().find((s) => s.uri === uri);
    if (!skill) throw invalidParams(`no skill at ${String(uri)}`);
    return skill;
  };
  return {
    capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } },
    methods: {
      "skills/list": () => ({ resultType: "complete", skills: all().map(entry), ...CACHE }),
      "skills/get": (params: Params) => ({ resultType: "complete", skill: entry(find(params.uri)), ...CACHE }),
      "resources/list": () => ({ resultType: "complete", resources: all().flatMap((s) => s.files.map((f) => resource(f, s))), ...CACHE }),
      "resources/templates/list": () => ({ resultType: "complete", resourceTemplates: [], ...CACHE }),
      "resources/read": (params: Params) => {
        const file = all().flatMap((s) => s.files).find((f) => f.uri === params.uri);
        if (!file) throw invalidParams(`no resource at ${String(params.uri)}`);
        return { resultType: "complete", contents: [content(file)], ...CACHE };
      },
    },
  };
}

export function servedSkills(dir: string): Served[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const root = `skill://${name}`;
      const skillMd = servedSkillMd(readFileSync(join(dir, name, "SKILL.md"), "utf8"), name);
      const others = walk(join(dir, name), "").filter((rel) => rel !== "SKILL.md");
      const files: File[] = [
        { uri: `${root}/SKILL.md`, bytes: new TextEncoder().encode(skillMd) },
        ...others.map((rel) => ({ uri: `${root}/${rel}`, bytes: new Uint8Array(readFileSync(join(dir, name, rel))) })),
      ];
      return { uri: `${root}/SKILL.md`, frontmatter: frontmatterOf(skillMd), files };
    });
}

// Foreman names a skill by its folder, and the extension requires the URI's last segment to equal the frontmatter's name, so a copied skill's name is rewritten to match.
export function servedSkillMd(text: string, name: string): string {
  const m = text.match(FRONTMATTER);
  const fields = m ? frontmatterOf(text) : {};
  const described = typeof fields.description === "string" && fields.description.trim() !== "";
  if (fields.name === name && described) return text;
  const lines = (m?.[1] ?? "").split(/\r?\n/).filter((l) => l !== "");
  const named = lines.some((l) => /^name\s*:/.test(l)) ? lines.map((l) => (/^name\s*:/.test(l) ? `name: ${name}` : l)) : [`name: ${name}`, ...lines];
  // Claude Code needs a description to decide when to load a skill, and the user may have left it out.
  const full = described ? named : [...named.filter((l) => !/^description\s*:/.test(l)), `description: The user's own ${name} skill.`];
  return `---\n${full.join("\n")}\n---\n${m ? text.slice(m[0].length) : text}`;
}

function frontmatterOf(text: string): Record<string, unknown> {
  const m = text.match(FRONTMATTER);
  if (!m) return {};
  try {
    const parsed = Bun.YAML.parse(m[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function walk(dir: string, prefix: string): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter((d) => !d.name.startsWith("."))
    .flatMap((d) => {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      return d.isDirectory() ? walk(dir, rel) : d.isFile() ? [rel] : [];
    })
    .sort();
}

const entry = (s: Served) => ({
  uri: s.uri,
  frontmatter: s.frontmatter,
  resources: s.files.map((f) => ({ uri: f.uri, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}`, size: f.bytes.byteLength })),
});

function resource(f: File, s: Served) {
  const name = f.uri.split("/").pop()!;
  return f.uri === s.uri
    ? { uri: f.uri, name: s.frontmatter.name, description: s.frontmatter.description, mimeType: "text/markdown" }
    : { uri: f.uri, name, mimeType: mimeType(f) };
}

function content(f: File) {
  const text = asText(f.bytes);
  return text === undefined ? { uri: f.uri, mimeType: mimeType(f), blob: Buffer.from(f.bytes).toString("base64") } : { uri: f.uri, mimeType: mimeType(f), text };
}

const mimeType = (f: File) => MIME[extname(f.uri).toLowerCase()] ?? (asText(f.bytes) === undefined ? "application/octet-stream" : "text/plain");

function asText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
