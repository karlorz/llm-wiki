import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import {
  ok, err, ExitCode,
  TypedKnowledgeSchema, RawSourceSchema, WorkItemSchema, CompoundSchema, MetaSchema,
  detectSchema, type SchemaName, type Result
} from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface ValidateInput {
  file: string;
  apply?: boolean;
  vault?: string;
}
export interface ValidateOutput {
  schema: SchemaName | null;
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  index_updated: boolean;
  log_updated: boolean;
  humanHint: string;
}

const TYPE_TO_SECTION: Record<string, string> = {
  entity: "Entities",
  concept: "Concepts",
  comparison: "Comparisons",
  query: "Queries",
  summary: "Summaries",
  meta: "Meta",
};

const SCHEMAS = {
  "typed-knowledge": TypedKnowledgeSchema,
  "raw": RawSourceSchema,
  "work-item": WorkItemSchema,
  "compound": CompoundSchema,
  "meta": MetaSchema
} as const;

export async function runValidate(input: ValidateInput): Promise<{ exitCode: number; result: Result<ValidateOutput> }> {
  let text: string;
  try {
    text = await readFile(input.file, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) };
  }
  const fm = extractFrontmatter(text);
  if (!fm.ok) {
    if (fm.error === "MISSING_CLOSING_DELIMITER") {
      return { exitCode: ExitCode.MISSING_CLOSING_DELIMITER, result: fm };
    }
    return { exitCode: ExitCode.INVALID_FRONTMATTER, result: fm };
  }
  const det = detectSchema(fm.data);
  if (!det.schema) {
    return { exitCode: ExitCode.SCHEMA_NOT_DETECTED, result: ok({ schema: null, valid: false, errors: [], index_updated: false, log_updated: false, humanHint: "schema not detected" }) };
  }
  const parsed = SCHEMAS[det.schema].safeParse(fm.data);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message }));
    return {
      exitCode: ExitCode.INVALID_FRONTMATTER,
      result: ok({ schema: det.schema, valid: false, errors, index_updated: false, log_updated: false, humanHint: `INVALID (${det.schema})\n${errors.map(e => `  ${e.path}: ${e.message}`).join("\n")}` })
    };
  }

  // Validation succeeded — apply vault updates if requested
  if (input.apply && !input.vault) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { reason: "--vault is required when --apply is set" }) };
  }

  let indexUpdated = false;
  let logUpdated = false;
  let applyHint = "";

  if (input.apply && input.vault) {
    const absFile = resolve(input.file);
    const absVault = resolve(input.vault);
    const relPath = relative(absVault, absFile).split(sep).join("/");

    if (relPath.startsWith("..")) {
      return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { reason: `file ${input.file} is not inside vault ${input.vault}` }) };
    }

    const pageType = typeof parsed.data.type === "string" ? parsed.data.type : "";
    const title = typeof parsed.data.title === "string" ? parsed.data.title : relPath.replace(/\.md$/, "");

    // Add to index.md for typed-knowledge and meta pages only
    if (det.schema === "typed-knowledge" || det.schema === "meta") {
      indexUpdated = await addToIndex(input.vault, relPath, title, pageType);
    }

    // Append to log.md for all valid pages
    logUpdated = await appendToLog(input.vault, relPath);

    if (indexUpdated) applyHint += `\n  index: added [[${relPath.replace(/\.md$/, "")}]]`;
    if (logUpdated) applyHint += "\n  log: appended entry";
  }

  return { exitCode: ExitCode.OK, result: ok({
    schema: det.schema, valid: true, errors: [],
    index_updated: indexUpdated, log_updated: logUpdated,
    humanHint: `VALID (${det.schema})${applyHint}`
  }) };
}

async function addToIndex(vault: string, relPath: string, title: string, pageType: string): Promise<boolean> {
  const section = TYPE_TO_SECTION[pageType];
  if (!section) return false;

  const indexPath = join(vault, "index.md");
  let text: string;
  try { text = await readFile(indexPath, "utf8"); } catch { return false; }

  const ref = relPath.replace(/\.md$/, "");
  if (text.includes(`[[${ref}]]`)) return false;

  const entry = `- [[${ref}]] — ${title}`;
  const lines = text.split("\n");
  const sectionLine = `## ${section}`;
  const sectionIdx = lines.findIndex(l => l.trim() === sectionLine);

  if (sectionIdx === -1) {
    // Section doesn't exist — append at end of file
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", sectionLine, entry);
  } else {
    // Find end of this section's entries (next ## header or end of file)
    let endIdx = sectionIdx + 1;
    while (endIdx < lines.length) {
      if (lines[endIdx].startsWith("## ")) break;
      endIdx++;
    }
    // Skip back over trailing blank lines within the section
    let insertAt = endIdx;
    while (insertAt > sectionIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    lines.splice(insertAt, 0, entry);
  }

  try {
    await writeFile(indexPath, lines.join("\n"), "utf8");
  } catch {
    return false;
  }
  return true;
}

async function appendToLog(vault: string, relPath: string): Promise<boolean> {
  const logPath = join(vault, "log.md");
  let text: string;
  try { text = await readFile(logPath, "utf8"); } catch { return false; }

  const today = new Date().toISOString().slice(0, 10);
  const entry = `\n## [${today}] validate | added: ${relPath}`;

  try {
    await writeFile(logPath, text.trimEnd() + entry, "utf8");
  } catch {
    return false;
  }
  return true;
}
