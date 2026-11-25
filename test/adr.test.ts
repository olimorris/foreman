import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_README, defaultConvention, detectAdr, highestNumber, listAdrs, renderAdr, skillLayout, supersede } from "../src/adr.ts";
import { chooseConvention, parseOpenPrNumbers, planAdrs } from "../src/adrwrite.ts";
import type { Decision } from "../src/ledger.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "foreman-adr-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const decision = (title: string, extra: Partial<Decision> = {}): Decision => ({
  id: "D-1", title, body: "Because reasons. Rejected: the other way.", paths: [], supersedes: [], status: "accepted", by: "T1", createdAt: "", ...extra,
});

describe("a Strata-style folder", () => {
  const root = fixture({
    "docs/decisions/README.md": "# Rules\n",
    "docs/decisions/0001-native-app.md": "# 1. A native Mac app\n\nBody.\n",
    "docs/decisions/0035-one-file.md": "# 35. One file per layer\n\nBody.\n",
    "docs/decisions/0170-menu-bar-draws-a-template.md": "# 170. The menu bar draws a template\n\nBody.\n",
    "docs/decisions/superseded/0171-old.md": "# 171. Old idea\n\nSuperseded by ADR 35.\n\nBody.\n",
  });
  const conv = detectAdr(root)!;

  test("learns numbering, title, status and the superseded folder", () => {
    expect(conv).toMatchObject({ dir: "docs/decisions", pad: 4, separator: "-", title: "# {n}. {title}", status: { kind: "none" } });
    expect(conv.supersededDir).toBe("docs/decisions/superseded");
    expect(conv.supersededLine).toBe("Superseded by ADR {n}.");
    expect(conv.readme).toBe("docs/decisions/README.md");
    expect(conv.template).toBeUndefined();
  });

  test("counts superseded records when numbering and lists only live ones", () => {
    expect(highestNumber(root, conv)).toBe(171);
    expect(listAdrs(root, conv.dir).map((a) => [a.number, a.title])).toEqual([
      [1, "A native Mac app"],
      [35, "One file per layer"],
      [170, "The menu bar draws a template"],
    ]);
  });

  test("skips numbers that open PRs already claim", () => {
    const prs = [{ files: [{ path: "docs/decisions/0180-x.md" }, { path: "src/0190-y.md" }] }, { files: [{ path: "docs/decisions/superseded/0185-z.md" }] }];
    const reserved = parseOpenPrNumbers(prs, conv);
    expect(reserved).toEqual([180, 185]);
    expect(planAdrs(root, conv, [decision("Next")], reserved).recorded["D-1"]!.number).toBe(186);
  });

  test("plans a new record and moves the one it supersedes", () => {
    const plan = planAdrs(root, conv, [decision("Workers own their folders", { supersedes: [35] })]);
    expect(plan.recorded["D-1"]).toEqual({ number: 172, file: "docs/decisions/0172-workers-own-their-folders.md" });
    expect(plan.files[0]!.content).toBe("# 172. Workers own their folders\n\nBecause reasons. Rejected: the other way.\n");
    expect(plan.files[1]).toMatchObject({ from: "docs/decisions/0035-one-file.md", file: "docs/decisions/superseded/0035-one-file.md" });
    expect(plan.files[1]!.content).toBe("# 35. One file per layer\n\nSuperseded by ADR 172.\n\nBody.\n");
  });
});

test("an adr-tools folder found through .adr-dir, with a Status section", () => {
  const root = fixture({
    ".adr-dir": "doc/architecture\n",
    "doc/architecture/0001-record-architecture-decisions.md": "# 1. Record architecture decisions\n\nDate: 2024-01-01\n\n## Status\n\nAccepted\n\n## Context\n\nX\n",
    "doc/architecture/0002-use-postgres.md": "# 2. Use Postgres\n\n## Status\n\nSuperseded by [3. Use SQLite](0003-use-sqlite.md)\n",
  });
  const conv = detectAdr(root)!;
  expect(conv.dir).toBe("doc/architecture");
  expect(conv.status).toEqual({ kind: "section", heading: "## Status", accepted: "Accepted" });
  expect(renderAdr(conv, 3, "Use SQLite", "## Context\n\nSmall.").content).toBe("# 3. Use SQLite\n\n## Status\n\nAccepted\n\n## Context\n\nSmall.\n");
  const old = supersede(conv, "doc/architecture/0001-record-architecture-decisions.md", "# 1. R\n\n## Status\n\nAccepted\n", [3]);
  expect(old.content).toBe("# 1. R\n\n## Status\n\nSuperseded by ADR 3.\n");
});

test("an ADR-prefixed title, a status line and an unpadded underscore name", () => {
  const root = fixture({
    "adr/1_use-bun.md": "# ADR 1: Use Bun\n\nStatus: Accepted\n\nWe use Bun.\n",
    "adr/2_use-rex.md": "# ADR 2: Use Rex\n\nStatus: Proposed\n\nWe use Rex.\n",
    "adr/template.md": "# ADR N: Title\n",
  });
  const conv = detectAdr(root)!;
  expect(conv).toMatchObject({ dir: "adr", pad: 1, separator: "_", title: "# ADR {n}: {title}", template: "adr/template.md" });
  expect(conv.status).toEqual({ kind: "line", label: "Status:", accepted: "Accepted" });
  expect(renderAdr(conv, 3, "Use tmux", "Body.")).toEqual({ file: "adr/3_use-tmux.md", content: "# ADR 3: Use tmux\n\nStatus: Accepted\n\nBody.\n" });
});

test("frontmatter status", () => {
  const root = fixture({ "docs/adr/0001-x.md": "---\nstatus: accepted\n---\n# X\n\nBody\n" });
  const conv = detectAdr(root)!;
  expect(conv.status).toEqual({ kind: "frontmatter", key: "status", accepted: "accepted" });
  expect(conv.title).toBe("# {title}");
  expect(renderAdr(conv, 2, "Y", "Body").content).toBe("---\nstatus: accepted\n---\n# Y\n\nBody\n");
});

test("no ADR folder detects nothing, and the default starts one with a README", () => {
  const root = fixture({ "docs/guide.md": "# Guide\n" });
  expect(detectAdr(root)).toBeUndefined();
  const plan = planAdrs(root, defaultConvention(), [decision("First decision")]);
  expect(plan.files.map((f) => f.file)).toEqual(["docs/decisions/README.md", "docs/decisions/0001-first-decision.md"]);
});

// Trimmed from agent-skills' documentation-and-adrs skill, which this repo copies into .foreman/skills/adr.
const ADR_SKILL = [
  "# Documentation and ADRs",
  "",
  "```bash",
  "echo not a template",
  "```",
  "",
  "```markdown",
  "# ADR-001: Use PostgreSQL for primary database",
  "",
  "## Status",
  "Proposed | Accepted | Superseded by ADR-XXX | Deprecated",
  "",
  "## Date",
  "2025-01-15",
  "",
  "## Context",
  "We need a database.",
  "",
  "## Decision",
  "Use PostgreSQL.",
  "",
  "## Alternatives Considered",
  "",
  "### MongoDB",
  "- Rejected: relational data.",
  "",
  "## Consequences",
  "- Team needs PostgreSQL knowledge.",
  "```",
  "",
  "```markdown",
  "# Project Name",
  "```",
].join("\n");

describe("an adr skill", () => {
  const layout = skillLayout(ADR_SKILL)!;

  test("gives the title line, status style and sections from its template", () => {
    expect(layout).toEqual({
      title: "# ADR-{N}: {title}",
      status: { kind: "section", heading: "## Status", accepted: "Accepted" },
      sections: ["Status", "Date", "Context", "Decision", "Alternatives Considered", "Consequences"],
    });
    expect(skillLayout("# Rules\n\nWrite good ADRs.\n")).toBeUndefined();
  });

  test("shapes a new repo's convention, records and README", () => {
    const root = fixture({ "docs/guide.md": "# Guide\n" });
    const chosen = chooseConvention(root, defaultConvention(), layout)!;
    expect(chosen.conv).toEqual(defaultConvention("docs/decisions", layout));
    expect(chosen.conv).toMatchObject({ dir: "docs/decisions", pad: 4, title: "# ADR-{N}: {title}", status: { kind: "section", heading: "## Status", accepted: "Accepted" } });

    const body = "## Date\n\n2026-11-25\n\n## Context\n\nWhy.\n\n## Decision\n\nWhat.";
    const plan = planAdrs(root, chosen.conv, [decision("Workers own their folders", { body })], [], chosen.readme);
    expect(plan.files.map((f) => f.file)).toEqual(["docs/decisions/README.md", "docs/decisions/0001-workers-own-their-folders.md"]);
    expect(plan.files[1]!.content).toBe(`# ADR-0001: Workers own their folders\n\n## Status\n\nAccepted\n\n${body}\n`);
    expect(plan.files[0]!.content).toBe([
      "# Decisions, one per file",
      "",
      "- Each record is `NNNN-short-name.md`, and its title line is `# ADR-NNNN: <the decision>`.",
      "- Its sections, in order: Status, Date, Context, Decision, Alternatives Considered, Consequences.",
      "- A new record takes one above the highest number in this folder.",
      "- When a decision is reversed, its status becomes \"Superseded by ADR N.\" and the new decision is written as a new record.",
      "",
    ].join("\n"));
  });

  test("loses to an existing folder's convention", () => {
    const root = fixture({ "docs/decisions/0007-native-app.md": "# 7. A native Mac app\n\nBody.\n" });
    const chosen = chooseConvention(root, defaultConvention("docs/decisions", layout), layout)!;
    expect(chosen.conv).toMatchObject({ title: "# {n}. {title}", status: { kind: "none" } });
    expect(chosen.readme).toBe(DEFAULT_README);
    expect(planAdrs(root, chosen.conv, [decision("Next")]).files[0]!.content).toBe("# 8. Next\n\nBecause reasons. Rejected: the other way.\n");
  });

  test("changes nothing when it's missing", () => {
    const root = fixture({ "docs/guide.md": "# Guide\n" });
    expect(defaultConvention("docs/decisions", undefined)).toEqual(defaultConvention());
    expect(chooseConvention(root, defaultConvention(), undefined)).toEqual({ conv: defaultConvention(), readme: DEFAULT_README });
    expect(chooseConvention(root, undefined, skillLayout(ADR_SKILL))).toBeUndefined();
  });
});
