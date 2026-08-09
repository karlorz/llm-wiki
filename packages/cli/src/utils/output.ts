import type { Result } from "@skillwiki/shared";

export interface HumanOutputOptions {
  detailHints?: readonly string[];
}

export function printJson<T>(r: Result<T>): void {
  process.stdout.write(JSON.stringify(r) + "\n");
}

export function printHuman<T>(r: Result<T>, opts: HumanOutputOptions = {}): void {
  if (r.ok) {
    if (typeof r.data === "object" && r.data !== null && "humanHint" in r.data) {
      const humanHint = (r.data as { humanHint: string }).humanHint;
      if (!opts.detailHints?.length) {
        process.stdout.write(`${humanHint}\n`);
      } else {
        const existingLines = new Set(humanHint.split("\n"));
        const detailLines = opts.detailHints.filter((line) => !existingLines.has(line));
        process.stdout.write(`${[humanHint, ...detailLines].join("\n")}\n`);
      }
    } else {
      process.stdout.write(`OK\n${formatData(r.data)}\n`);
    }
  } else {
    process.stdout.write(`ERR ${r.error}\n${r.detail !== undefined ? formatData(r.detail) + "\n" : ""}`);
  }
}

function formatData(d: unknown): string {
  if (d == null) return "";
  if (typeof d === "string") return d;
  return JSON.stringify(d, null, 2);
}
