import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";

export interface ClaimInput {
  vault: string;
  transcript: string; // relPath like raw/transcripts/2026-05-12-task-foo.md
  project?: string;   // override slug
  slug?: string;      // override work-item slug
}

export interface ClaimOutput {
  workItemPath: string;  // relative: projects/{slug}/work/{date}-{slug}/
  specPath: string;      // relative: projects/{slug}/work/{date}-{slug}/spec.md
  source: string;        // the transcript relPath written into source: field
  humanHint: string;
}

// Extract YYYY-MM-DD from filename
function extractDate(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? "";
}

// Extract slug from filename: strip date prefix and kind prefix
function extractSlugFromFilename(filename: string): string {
  return filename
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/^(task|bug|idea|note|observation)-/, "")
    .replace(/\.md$/, "");
}

// Extract project slug from "[[slug]]" format
function extractProjectSlug(projectField: string): string {
  return projectField.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/^"|"$/g, "");
}

export async function runClaim(input: ClaimInput): Promise<{ exitCode: number; result: Result<ClaimOutput> }> {
  // Validate vault
  if (!existsSync(input.vault) || !statSync(input.vault).isDirectory()) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { path: input.vault }) };
  }

  const absTranscript = join(input.vault, input.transcript);

  // Validate transcript exists
  if (!existsSync(absTranscript)) {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.transcript }) };
  }

  // Read and parse transcript frontmatter
  const content = await readFile(absTranscript, "utf8");
  const fm = extractFrontmatter(content);

  // Determine project slug
  let projectSlug = input.project;
  if (!projectSlug && fm.ok && typeof fm.data.project === "string") {
    projectSlug = extractProjectSlug(fm.data.project);
  }
  if (!projectSlug) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { message: "No project specified. Use --project or set project in transcript frontmatter." })
    };
  }

  // Verify project exists
  const projectDir = join(input.vault, "projects", projectSlug);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    return {
      exitCode: ExitCode.PROJECT_NOT_FOUND,
      result: err("PROJECT_NOT_FOUND", { project: projectSlug })
    };
  }

  // Determine date and work-item slug
  const filename = input.transcript.split("/").pop()!;
  const date = extractDate(filename);
  if (!date) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { message: `Cannot extract date from filename: ${filename}` })
    };
  }

  const workSlug = input.slug || extractSlugFromFilename(filename);
  const dirName = `${date}-${workSlug}`;
  const workDir = join(projectDir, "work", dirName);
  const relWorkDir = `projects/${projectSlug}/work/${dirName}`;
  const relSpecPath = `${relWorkDir}/spec.md`;

  // Check if work item already exists
  if (existsSync(workDir)) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        workItemPath: relWorkDir,
        specPath: relSpecPath,
        source: input.transcript,
        humanHint: `work item already exists: ${relWorkDir}`
      })
    };
  }

  // Create work directory
  await mkdir(workDir, { recursive: true });

  // Build spec.md content
  const kind = (fm.ok && typeof fm.data.kind === "string") ? fm.data.kind : "task";
  const specLines = [
    "---",
    `source: ${input.transcript}`,
    `status: planned`,
    `kind: ${kind}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    `# ${workSlug}`,
    "",
    `Claimed from ${input.transcript}`,
    "",
  ];

  await writeFile(join(workDir, "spec.md"), specLines.join("\n"), "utf8");

  appendLastOp(input.vault, {
    operation: "claim",
    summary: `claimed ${input.transcript} → ${relWorkDir}`,
    files: [relSpecPath],
    timestamp: new Date().toISOString(),
  });

  return {
    exitCode: ExitCode.OK,
    result: ok({
      workItemPath: relWorkDir,
      specPath: relSpecPath,
      source: input.transcript,
      humanHint: `claimed ${input.transcript} → ${relWorkDir}`
    })
  };
}
