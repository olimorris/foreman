export type Style = { heading: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string; red: (s: string) => string; yellow: (s: string) => string; green: (s: string) => string; cyan: (s: string) => string };

const ansi = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const same = (s: string) => s;

export const PLAIN: Style = { heading: same, dim: same, bold: same, red: same, yellow: same, green: same, cyan: same };
export const COLOUR: Style = { heading: ansi("1;33"), dim: ansi("2"), bold: ansi("1"), red: ansi("31"), yellow: ansi("33"), green: ansi("32"), cyan: ansi("36") };

export function styleFor(out: { isTTY?: boolean } = process.stdout, env: Record<string, string | undefined> = process.env): Style {
  return out.isTTY && !env.NO_COLOR ? COLOUR : PLAIN;
}
