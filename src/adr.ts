import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ADR_DIRS = ["docs/decisions", "docs/adr", "docs/adrs", "doc/adr", "adr", "decisions"];

export type StatusStyle =
  | { kind: "none" }
  | { kind: "line"; label: string; accepted: string }
  | { kind: "section"; heading: string; accepted: string }
  | { kind: "frontmatter"; key: string; accepted: string };

export type AdrConvention = {
  dir: string;
  pad: number;
  separator: string;
  title: string;
  status: StatusStyle;
  supersededDir?: string;
  supersededLine: string;
  readme?: string;
  template?: string;
};

export type AdrRecord = { number: number; file: string; title: string };

export type AdrLayout = { title: string; status: StatusStyle; sections: string[] };

const RECORD = /^(\d+)([-_])(.+)\.md$/;
const TITLE = /^(#\s*(?:ADR[-\s]?)?)(\d+)([.:)]?\s+|\s*[-:]\s+)(.*)$/i;

export function findAdrDir(root: string): string | undefined {
  const marker = join(root, ".adr-dir");
  if (existsSync(marker)) return readFileSync(marker, "utf8").trim().replace(/\/$/, "");
  return ADR_DIRS.find((d) => existsSync(join(root, d)) && records(root, d).length > 0);
}

export function detectAdr(root: string): AdrConvention | undefined {
  const dir = findAdrDir(root);
  if (!dir) return undefined;
  const files = records(root, dir);
  if (!files.length) return undefined;
  const latest = files.slice(-8).map((f) => readFileSync(join(root, dir, f), "utf8"));
  const names = files.map((f) => f.match(RECORD)!);
  const supersededDir = existsSync(join(root, dir, "superseded")) ? `${dir}/superseded` : undefined;
  const entries = readdirSync(join(root, dir));
  const template = entries.find((f) => /template/i.test(f) && !isRecord(f));
  return {
    dir,
    pad: mostCommon(names.map((m) => m[1]!.length)),
    separator: mostCommon(names.map((m) => m[2]!)),
    title: mostCommon(latest.map(titleTemplate)),
    status: statusStyle(latest),
    supersededDir,
    supersededLine: supersededDir ? supersededTemplate(root, supersededDir) : "Superseded by ADR {n}.",
    readme: entries.includes("README.md") ? `${dir}/README.md` : undefined,
    template: template && `${dir}/${template}`,
  };
}

export function listAdrs(root: string, dir: string): AdrRecord[] {
  return records(root, dir).map((file) => {
    const text = readFileSync(join(root, dir, file), "utf8");
    const heading = headingLine(text) ?? file;
    const m = heading.match(TITLE);
    return { number: Number(file.match(RECORD)![1]), file: `${dir}/${file}`, title: m ? m[4]! : heading.replace(/^#\s*/, "") };
  });
}

export function highestNumber(root: string, conv: AdrConvention): number {
  const dirs = [conv.dir, ...(conv.supersededDir ? [conv.supersededDir] : [])];
  return Math.max(0, ...dirs.flatMap((d) => records(root, d).map((f) => Number(f.match(RECORD)![1]))));
}

export function renderAdr(conv: AdrConvention, n: number, title: string, body: string, slug?: string): { file: string; content: string } {
  const heading = conv.title.replace("{n}", String(n)).replace("{N}", pad(n, conv.pad)).replace("{title}", title);
  const s = conv.status;
  const lines: string[] = [];
  if (s.kind === "frontmatter") lines.push("---", `${s.key}: ${s.accepted}`, "---");
  lines.push(heading, "");
  if (s.kind === "line") lines.push(`${s.label} ${s.accepted}`, "");
  if (s.kind === "section" && !body.includes(s.heading)) lines.push(s.heading, "", s.accepted, "");
  lines.push(body.trim(), "");
  return { file: `${conv.dir}/${pad(n, conv.pad)}${conv.separator}${slug ?? slugify(title)}.md`, content: lines.join("\n") };
}


// Returns the record's new path and content once it names its replacements.
export function supersede(conv: AdrConvention, file: string, text: string, by: number[]): { file: string; content: string } {
  const note = conv.supersededLine.replace("{n}", by.join(", ADR "));
  const s = conv.status;
  if (s.kind === "line") {
    return { file, content: text.replace(new RegExp(`^(${escape(s.label)}).*$`, "m"), `$1 ${note.replace(/\.$/, "")}`) };
  }
  if (s.kind === "frontmatter") {
    return { file, content: text.replace(new RegExp(`^(${escape(s.key)}:).*$`, "m"), `$1 ${note.replace(/\.$/, "")}`) };
  }
  if (s.kind === "section") {
    return { file, content: text.replace(new RegExp(`(${escape(s.heading)}[ \\t]*\\n(?:\\s*\\n)?)[^\\n]*`), `$1${note}`) };
  }
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("#"));
  lines.splice(at + 1, 0, "", note);
  const name = file.split("/").pop()!;
  return { file: conv.supersededDir ? `${conv.supersededDir}/${name}` : file, content: lines.join("\n") };
}

// Matches Strata's own convention, which is what the user chose as the default.
export function defaultConvention(dir = "docs/decisions", layout?: AdrLayout): AdrConvention {
  const conv: AdrConvention = {
    dir,
    pad: 4,
    separator: "-",
    title: "# {n}. {title}",
    status: { kind: "none" },
    supersededDir: `${dir}/superseded`,
    supersededLine: "Superseded by ADR {n}.",
    readme: `${dir}/README.md`,
  };
  return layout ? withLayout(conv, layout) : conv;
}

export function withLayout(conv: AdrConvention, layout: AdrLayout): AdrConvention {
  return { ...conv, title: layout.title, status: layout.status };
}

// An ADR skill shows its record layout as an example inside a fence, so the first fenced block with a numbered heading is the template.
export function skillLayout(body: string): AdrLayout | undefined {
  for (const m of body.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)) {
    const text = m[2]!;
    if (!headingLine(text)?.match(TITLE)) continue;
    const sections = [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((h) => h[1]!);
    return { title: titleTemplate(text), status: statusStyle([text]), sections };
  }
  return undefined;
}

export function layoutReadme(conv: AdrConvention, layout: AdrLayout): string {
  const title = conv.title.replace("{N}", "N".repeat(conv.pad)).replace("{n}", "N").replace("{title}", "<the decision>");
  const moves = conv.status.kind === "none" && conv.supersededDir;
  return [
    "# Decisions, one per file",
    "",
    `- Each record is \`${"N".repeat(conv.pad)}${conv.separator}short-name.md\`, and its title line is \`${title}\`.`,
    ...(layout.sections.length ? [`- Its sections, in order: ${layout.sections.join(", ")}.`] : []),
    `- A new record takes one above the highest number in this folder${moves ? ", `superseded/` included" : ""}.`,
    moves
      ? `- When a decision is reversed, move its file to \`superseded/\`, add "${conv.supersededLine.replace("{n}", "N")}" under its title, and write the new decision as a new record.`
      : `- When a decision is reversed, its status becomes "${conv.supersededLine.replace("{n}", "N")}" and the new decision is written as a new record.`,
    "",
  ].join("\n");
}

export const DEFAULT_README = `# Decisions, one per file

Decisions that are hard to reverse, would surprise a reader of the code, and came from a real trade-off.

- The title states the decision. It's the only part always read.
- One decision per record. Say what is true now and why, with what was rejected.
- A new record takes one above the highest number in this folder, \`superseded/\` included, as \`NNNN-short-name.md\`.
- When a decision is reversed, move its file to \`superseded/\`, add "Superseded by ADR N." under its title, and write the new decision as a new record.
`;

export function slugify(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);
  return words.slice(0, 8).join("-") || "decision";
}

function records(root: string, dir: string): string[] {
  const path = join(root, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path).filter(isRecord).sort((a, b) => Number(a.match(RECORD)![1]) - Number(b.match(RECORD)![1]));
}

// A template is often numbered 0000, and a real record may have "template" in its name.
function isRecord(name: string): boolean {
  const m = name.match(RECORD);
  return !!m && Number(m[1]) > 0;
}

function headingLine(text: string): string | undefined {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n").find((l) => l.startsWith("#"));
}

function titleTemplate(text: string): string {
  const heading = headingLine(text) ?? "# {title}";
  const m = heading.match(TITLE);
  if (!m) return "# {title}";
  const n = m[2]!.length > 1 && m[2]!.startsWith("0") ? "{N}" : "{n}";
  return `${m[1]}${n}${m[3]}{title}`;
}

function statusStyle(texts: string[]): StatusStyle {
  const values = (re: RegExp) => texts.map((t) => t.match(re)?.[1]?.trim()).filter((v): v is string => !!v);
  const accepted = (vs: string[]) => vs.flatMap((v) => v.split("|").map((x) => x.trim())).find((v) => /accepted/i.test(v)) ?? "Accepted";
  const fm = values(/^---\n[\s\S]*?^status:\s*(.+)$[\s\S]*?^---$/m);
  if (fm.length) return { kind: "frontmatter", key: "status", accepted: accepted(fm) };
  const section = values(/^##\s*Status[ \t]*\n(?:\s*\n)?(.+)$/m);
  if (section.length) return { kind: "section", heading: "## Status", accepted: accepted(section) };
  const line = texts.map((t) => t.match(/^((?:\*\*)?Status:?(?:\*\*)?:?)\s*(.+)$/m)).filter((m) => !!m);
  if (line.length) return { kind: "line", label: line[0]![1]!, accepted: accepted(line.map((m) => m![2]!.trim())) };
  return { kind: "none" };
}

function supersededTemplate(root: string, dir: string): string {
  for (const f of records(root, dir)) {
    const line = readFileSync(join(root, dir, f), "utf8").split("\n").find((l) => /^superseded by/i.test(l.trim()));
    if (line) return line.trim().replace(/\d+(?:,? (?:and )?(?:ADR )?\d+)*/, "{n}");
  }
  return "Superseded by ADR {n}.";
}

function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
