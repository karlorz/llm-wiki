import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";

const ALLOWED_KINDS = new Set(["note", "bug", "task", "idea", "session-log"]);

export interface ObserveInput {
  vault: string;
  text: string;
  project?: string;
  kind?: string;
}

export interface ObserveOutput {
  path: string;
  sha256: string;
  humanHint: string;
}

function slugify(text: string): string {
  const words = text
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return words || "untitled";
}

export async function runObserve(
  input: ObserveInput
): Promise<{ exitCode: number; result: Result<ObserveOutput> }> {
  const kind = input.kind || "task";

  if (!ALLOWED_KINDS.has(kind)) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", {
        message: `Invalid kind "${kind}". Allowed: ${[...ALLOWED_KINDS].join(", ")}`
      })
    };
  }

  if (!input.text || input.text.trim().length === 0) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { message: "Text must not be empty" })
    };
  }

  if (!existsSync(input.vault) || !statSync(input.vault).isDirectory()) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("VAULT_PATH_INVALID", { path: input.vault })
    };
  }

  const transcriptsDir = join(input.vault, "raw", "transcripts");

  try {
    await mkdir(transcriptsDir, { recursive: true });
  } catch {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("VAULT_PATH_INVALID", { path: transcriptsDir })
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(input.text);
  const fileName = `${today}-observation-${slug}.md`;
  const filePath = join(transcriptsDir, fileName);

  const body = `\n${input.text.trim()}\n`;

  const sha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");

  const frontmatterLines = [
    "---",
    "source_url:",
    `ingested: ${today}`,
    `sha256: ${sha256}`,
    `kind: ${kind}`,
  ];

  if (input.project) {
    frontmatterLines.push(`project: "[[${input.project}]]"`);
  }

  frontmatterLines.push("---");

  const content = frontmatterLines.join("\n") + body;

  try {
    await writeFile(filePath, content, "utf8");
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { path: filePath, message: String(e) })
    };
  }

  appendLastOp(input.vault, {
    operation: "observe",
    summary: `created observation: ${slug}`,
    files: [`raw/transcripts/${fileName}`],
    timestamp: new Date().toISOString(),
  });

  const relPath = `raw/transcripts/${fileName}`;
  const humanHint = `created ${relPath} (${sha256.slice(0, 12)}...)`;

  return {
    exitCode: ExitCode.OK,
    result: ok({ path: relPath, sha256, humanHint })
  };
}
