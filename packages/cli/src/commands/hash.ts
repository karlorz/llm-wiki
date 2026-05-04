import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface HashInput { file: string }
export interface HashOutput { path: string; sha256: string; byte_count: number; humanHint: string }

export async function runHash(input: HashInput): Promise<{ exitCode: number; result: Result<HashOutput> }> {
  let text: string;
  try {
    text = await readFile(input.file, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) };
  }
  const split = splitFrontmatter(text);
  if (!split.ok) return { exitCode: ExitCode.MISSING_CLOSING_DELIMITER, result: split };
  const bodyBytes = Buffer.from(split.data.body, "utf8");
  const sha256 = createHash("sha256").update(bodyBytes).digest("hex");
  return {
    exitCode: ExitCode.OK,
    result: ok({ path: input.file, sha256, byte_count: bodyBytes.byteLength, humanHint: sha256 })
  };
}
