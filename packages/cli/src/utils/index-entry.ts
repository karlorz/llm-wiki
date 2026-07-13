import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { atomicWriteText } from "./atomic-write.js";

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

/** Render a minimal, line-ending-preserving insertion for one typed index entry. */
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

/** Atomically insert a typed-page index link, preserving an existing link as a no-op. */
export async function upsertIndexEntry(input: IndexEntryInput): Promise<Result<{ changed: boolean }>> {
  const path = join(input.vault, "index.md");
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch (error: unknown) {
    return err("FILE_NOT_FOUND", { path, message: String(error) });
  }

  const rendered = renderIndexUpsert(current, input);
  if (!rendered.ok) return rendered;
  if (!rendered.data.changed) return ok({ changed: false });

  const written = await atomicWriteText(path, rendered.data.text);
  return written.ok ? ok({ changed: written.data.changed }) : written;
}
