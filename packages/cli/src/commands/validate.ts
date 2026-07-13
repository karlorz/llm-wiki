import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import {
  ok, err, ExitCode,
  TypedKnowledgeSchema, RawSourceSchema, WorkItemSchema, CompoundSchema, MetaSchema,
  detectSchema, type SchemaName, type Result
} from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { scanSensitiveContent, type SensitiveFinding } from "../utils/sensitive-content.js";
import { runLogAppend } from "./log-append.js";
import { upsertIndexEntry } from "../utils/index-entry.js";
import { acquireOwnedSyncLock, releaseOwnedSyncLock } from "../utils/sync-lock.js";
import { prepareTypedPage } from "../utils/typed-page.js";

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
  sensitive_findings?: SensitiveFinding[];
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
  const sensitiveFindings = scanSensitiveContent(text, { file: input.file });
  if (sensitiveFindings.length > 0) {
    const errors = sensitiveFindings.map(f => ({
      path: "sensitive_content",
      message: `${f.kind} at line ${f.line}: ${f.preview}`,
    }));
    return {
      exitCode: ExitCode.SENSITIVE_CONTENT_DETECTED,
      result: ok({
        schema: det.schema,
        valid: false,
        errors,
        index_updated: false,
        log_updated: false,
        humanHint: `SENSITIVE CONTENT (${sensitiveFindings.length})\n${errors.map(e => `  ${e.message}`).join("\n")}`,
        sensitive_findings: sensitiveFindings,
      }),
    };
  }
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

    const operationId = createHash("sha256")
      .update("skillwiki-validate-apply-v1\0")
      .update(relPath)
      .update("\0")
      .update(text)
      .digest("hex");

    // Add to index.md for typed-knowledge and meta pages only
    if (det.schema === "typed-knowledge" || det.schema === "meta") {
      const prepared = prepareTypedPage(text, relPath);
      if (!prepared.ok) {
        return { exitCode: ExitCode.INVALID_FRONTMATTER, result: prepared };
      }
      const lock = acquireOwnedSyncLock(input.vault, {
        summary: `validate --apply ${relPath}`,
        ttlMinutes: 1,
      });
      if (!lock.ok) {
        return { exitCode: ExitCode.SYNC_LOCK_HELD, result: lock };
      }

      let index: Result<{ changed: boolean }> | undefined;
      let released: Result<{ released: boolean }> | undefined;
      try {
        index = await upsertIndexEntry({
          vault: input.vault,
          target: relPath,
          title: prepared.data.title,
          type: prepared.data.type,
        });
      } catch (error: unknown) {
        index = err("WRITE_FAILED", { stage: "index", message: String(error) });
      } finally {
        released = releaseOwnedSyncLock(lock.data);
      }
      if (released === undefined || !released.ok) {
        return {
          exitCode: ExitCode.WRITE_FAILED,
          result: err("WRITE_FAILED", { stage: "unlock", detail: released?.detail }),
        };
      }
      if (index === undefined || !index.ok) {
        return {
          exitCode: ExitCode.WRITE_FAILED,
          result: index ?? err("WRITE_FAILED", { stage: "index" }),
        };
      }
      indexUpdated = index.data.changed;
    }

    // Append to log.md for all valid pages
    const logged = await runLogAppend({
      vault: input.vault,
      content: `## [${new Date().toISOString().slice(0, 10)}] validate | added: ${relPath}`,
      operationId,
      strictLock: true,
    });
    if (!logged.result.ok) {
      return { exitCode: logged.exitCode, result: logged.result };
    }
    if (logged.exitCode !== ExitCode.OK) {
      return {
        exitCode: logged.exitCode,
        result: err("WRITE_FAILED", { message: "log append returned inconsistent success state" }),
      };
    }
    logUpdated = logged.result.data.appended;

    if (indexUpdated) applyHint += `\n  index: added [[${relPath.replace(/\.md$/, "")}]]`;
    if (logUpdated) applyHint += "\n  log: appended entry";
  }

  return { exitCode: ExitCode.OK, result: ok({
    schema: det.schema, valid: true, errors: [],
    index_updated: indexUpdated, log_updated: logUpdated,
    humanHint: `VALID (${det.schema})${applyHint}`
  }) };
}
