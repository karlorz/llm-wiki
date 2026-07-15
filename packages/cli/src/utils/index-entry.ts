import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { renderRootIndex, writeRootIndexProjection } from "./index-projection.js";

const TYPE_SECTION: Record<string, string> = {
  entity: "Entities",
  concept: "Concepts",
  comparison: "Comparisons",
  query: "Queries",
  meta: "Meta",
};

export interface IndexEntryInput {
  vault: string;
  target: string;
  title: string;
  type: string;
}

/**
 * @deprecated Prefer renderRootIndex + writeRootIndexProjection. Kept only for
 * byte-oriented callers that still need a pure text transform preview.
 */
export function renderIndexUpsert(
  text: string,
  input: Omit<IndexEntryInput, "vault">,
): Result<{ text: string; changed: boolean }> {
  const section = TYPE_SECTION[input.type];
  if (!section) return err("SCHEME_REJECTED", { type: input.type });

  const ref = input.target.replace(/\.md$/, "");
  if (text.includes(`[[${ref}]]`)) return ok({ text, changed: false });
  if (/[\r\n]/.test(input.title)) {
    return err("SCHEME_REJECTED", { message: "index title must be one line" });
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const header = `## ${section}`;
  const entry = `- [[${ref}]] — ${input.title}`;
  const heading = new RegExp(`^${header}[ \\t]*(?=\\r?$)`, "m").exec(text);

  if (heading?.index !== undefined) {
    const afterHeading = heading.index + heading[0].length;
    const nextHeading = /^##[ \t]+/m.exec(text.slice(afterHeading));
    const sectionEnd = nextHeading?.index === undefined
      ? text.length
      : afterHeading + nextHeading.index;
    const sectionText = text.slice(afterHeading, sectionEnd);
    const trailingWhitespace = /(?:\r?\n[ \t]*)*$/.exec(sectionText)?.[0] ?? "";
    const insertAt = sectionEnd - trailingWhitespace.length;
    const before = text.slice(0, insertAt);
    const leadingNewline = before.endsWith("\n") ? "" : newline;
    return ok({
      text: before + leadingNewline + entry + text.slice(insertAt),
      changed: true,
    });
  }

  const trailingWhitespace = /(?:\r?\n[ \t]*)*$/.exec(text)?.[0] ?? "";
  const insertAt = text.length - trailingWhitespace.length;
  const before = text.slice(0, insertAt);
  const separator = before.length === 0 ? "" : newline + newline;
  return ok({
    text: before + separator + header + newline + entry + text.slice(insertAt),
    changed: true,
  });
}

/**
 * Compatibility wrapper: rebuilds the entire root index projection after the
 * page tree already contains the target page when the vault is scannable.
 * Falls back to legacy incremental insertion only when scan/projection cannot
 * run (e.g. missing SCHEMA.md fixtures).
 */
export async function upsertIndexEntry(input: IndexEntryInput): Promise<Result<{ changed: boolean }>> {
  const path = join(input.vault, "index.md");
  let before = "";
  try {
    before = await readFile(path, "utf8");
  } catch {
    before = "";
  }
  const projection = await renderRootIndex({ vault: input.vault, currentText: before });
  if (projection.ok) {
    if (projection.data.text === before) return ok({ changed: false });
    const written = await writeRootIndexProjection(input.vault, projection.data);
    if (!written.ok) return written;
    return ok({ changed: written.data.changed });
  }
  // Legacy fixture path: incremental insert when projection is unavailable.
  const rendered = renderIndexUpsert(before, input);
  if (!rendered.ok) return rendered;
  if (!rendered.data.changed) return ok({ changed: false });
  const written = await writeRootIndexProjection(input.vault, {
    text: rendered.data.text,
    entries: [],
    duplicates_removed: 0,
    ghosts_removed: [],
  });
  if (!written.ok) return written;
  return ok({ changed: written.data.changed });
}
