import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";

export interface IndexLinkFormatInput { vault: string }
export interface IndexLinkFormatEntry { line: number; text: string }
export interface IndexLinkFormatOutput { markdown_links: IndexLinkFormatEntry[]; humanHint: string }

const MD_LINK_RE = /\[[^\[\]]+\]\([^)]+\.md\)/;

export async function runIndexLinkFormat(input: IndexLinkFormatInput): Promise<{ exitCode: number; result: Result<IndexLinkFormatOutput> }> {
  let text = "";
  try { text = await readFile(join(input.vault, "index.md"), "utf8"); } catch { /* no index */ }

  const markdown_links: IndexLinkFormatEntry[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (MD_LINK_RE.test(line)) markdown_links.push({ line: i + 1, text: line.trim() });
  }

  const humanHint = markdown_links.length === 0
    ? "all index links use wikilink format"
    : `markdown links found: ${markdown_links.length}\n${markdown_links.map(l => `  line ${l.line}: ${l.text}`).join("\n")}`;
  return { exitCode: ExitCode.OK, result: ok({ markdown_links, humanHint }) };
}
