import { readFile } from "node:fs/promises";
import {
  ok, err, ExitCode,
  TypedKnowledgeSchema, RawSourceSchema, WorkItemSchema, CompoundSchema, MetaSchema,
  detectSchema, type SchemaName, type Result
} from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface ValidateInput { file: string }
export interface ValidateOutput {
  schema: SchemaName | null;
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  humanHint: string;
}

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
    return { exitCode: ExitCode.SCHEMA_NOT_DETECTED, result: ok({ schema: null, valid: false, errors: [], humanHint: "schema not detected" }) };
  }
  const parsed = SCHEMAS[det.schema].safeParse(fm.data);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message }));
    return {
      exitCode: ExitCode.INVALID_FRONTMATTER,
      result: ok({ schema: det.schema, valid: false, errors, humanHint: `INVALID (${det.schema})\n${errors.map(e => `  ${e.path}: ${e.message}`).join("\n")}` })
    };
  }
  return { exitCode: ExitCode.OK, result: ok({ schema: det.schema, valid: true, errors: [], humanHint: `VALID (${det.schema})` }) };
}
