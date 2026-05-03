import type { Result } from "@skillwiki/shared";

export function printJson<T>(r: Result<T>): void {
  process.stdout.write(JSON.stringify(r) + "\n");
}

export function printHuman<T>(r: Result<T>): void {
  if (r.ok) {
    if (typeof r.data === "object" && r.data !== null && "humanHint" in r.data) {
      process.stdout.write(`${(r.data as { humanHint: string }).humanHint}\n`);
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
