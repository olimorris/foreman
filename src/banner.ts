const ART = [
  "    ______",
  "   / ____/___  ________  ____ ___  ____ _____",
  "  / /_  / __ \\/ ___/ _ \\/ __ `__ \\/ __ `/ __ \\",
  " / __/ / /_/ / /  /  __/ / / / / / /_/ / / / /",
  "/_/    \\____/_/   \\___/_/ /_/ /_/\\__,_/_/ /_/",
].join("\n");

// Only a person at a terminal sees it, so the orchestrator and scripts that read Foreman's output never have to skip it.
export function banner(out: { isTTY?: boolean } = process.stdout, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!out.isTTY) return undefined;
  return env.NO_COLOR ? `${ART}\n` : `\x1b[33m${ART}\x1b[0m\n`;
}

export function printBanner(): void {
  const art = banner();
  if (art) console.log(art);
}
