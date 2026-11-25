export const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export const clip = (s: string, width: number) => (s.length > width ? s.slice(0, width - 3).trimEnd() + "..." : s);
