import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAllowedGeneratedPath,
  validateGeneratedChanges,
  type RunManifest,
} from "../src/allowlist.js";

function writeVaultFile(vault: string, relPath: string, body: string, mode?: number): void {
  const fullPath = join(vault, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
  if (mode !== undefined) chmodSync(fullPath, mode);
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runDate: "2026-06-11",
    changedFiles: [
      "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      "queries/2026-06-11-agent-memory-trends-digest.md",
      "raw/transcripts/2026-06-11-task-local-agent-memory.md",
      "meta/latest-session-brief.md",
      ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
    ],
    outputs: {
      evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
      taskCapturePaths: ["raw/transcripts/2026-06-11-task-local-agent-memory.md"],
      taskCaptureRenderer: "typescript",
      sessionBriefPath: "meta/latest-session-brief.md",
      runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
    },
    webSources: Array.from({ length: 3 }, (_, index) => `https://example.com/source-${index}`),
    ...overrides,
  };
}

describe("agent-memory-trends generated-output allowlist", () => {
  it("allows only expected generated files for the run date", () => {
    expect(isAllowedGeneratedPath("raw/articles/2026-06-11-agent-memory-trends-evidence.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("raw/articles/2026-06-11-agent-memory-trends-evidence-2026-06-11T14-35-51+08-00.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("queries/2026-06-11-agent-memory-trends-digest.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("raw/transcripts/2026-06-11-task-memory.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("raw/transcripts/2026-06-11-bug-memory.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("raw/transcripts/2026-06-11-idea-memory.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("meta/latest-session-brief.md", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath(".skillwiki/agent-memory-trends/2026-06-11-input.json", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath(".skillwiki/agent-memory-trends/2026-06-11-run.json", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath(".skillwiki/agent-memory-trends/latest-run.json", "2026-06-11")).toBe(true);
    expect(isAllowedGeneratedPath("raw/transcripts/2026-06-10-task-memory.md", "2026-06-11")).toBe(false);
    expect(isAllowedGeneratedPath("raw/articles/existing.md", "2026-06-11")).toBe(false);
    expect(isAllowedGeneratedPath("projects/llm-wiki/work/spec.md", "2026-06-11")).toBe(false);
  });

  it("accepts run-specific evidence paths when same-day evidence already exists", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const evidencePath = "raw/articles/2026-06-11-agent-memory-trends-evidence-2026-06-11T14-35-51+08-00.md";
    const runManifest = manifest({
      changedFiles: [
        evidencePath,
        "queries/2026-06-11-agent-memory-trends-digest.md",
        ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        ".skillwiki/agent-memory-trends/latest-run.json",
      ],
      outputs: {
        evidencePath,
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        taskCapturePaths: [],
        taskCaptureRenderer: "typescript",
        runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
      },
    });
    for (const path of runManifest.changedFiles) writeVaultFile(vault, path, `generated file ${path}\n`);

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: ["raw/articles/2026-06-11-agent-memory-trends-evidence.md"],
      maxFileBytes: 128 * 1024,
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a manifest whose declared outputs match the actual diff", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest();
    for (const path of runManifest.changedFiles) {
      writeVaultFile(vault, path, `generated file ${path}\n`);
    }

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: [],
      maxFileBytes: 128 * 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated changes to validate");
    expect(result.data.typedPagesToValidate).toEqual([
      "queries/2026-06-11-agent-memory-trends-digest.md",
      "meta/latest-session-brief.md",
    ]);
    expect(result.data.rawPagesToValidate).toEqual([
      "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      "raw/transcripts/2026-06-11-task-local-agent-memory.md",
    ]);
    expect(result.data.digestPathForAudit).toBe("queries/2026-06-11-agent-memory-trends-digest.md");
  });

  it("accepts quiet successful runs that publish only agent-memory-trends run state", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest({
      changedFiles: [
        ".skillwiki/agent-memory-trends/2026-06-11-input.json",
        ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        ".skillwiki/agent-memory-trends/latest-run.json",
      ],
      outputs: {
        runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
      },
      webSources: [],
    });
    for (const path of runManifest.changedFiles) writeVaultFile(vault, path, `generated file ${path}\n`);

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: [],
      maxFileBytes: 128 * 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected quiet run-state-only changes to validate");
    expect(result.data.typedPagesToValidate).toEqual([]);
    expect(result.data.rawPagesToValidate).toEqual([]);
    expect(result.data.digestPathForAudit).toBeUndefined();
  });

  it("does not apply the generated-file byte cap to existing session-brief support files", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest({
      changedFiles: [
        "queries/2026-06-11-agent-memory-trends-digest.md",
        ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        ".skillwiki/agent-memory-trends/latest-run.json",
        "log.md",
      ],
      outputs: {
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
        sessionBriefSupportPaths: ["log.md"],
      },
    });
    writeVaultFile(vault, "queries/2026-06-11-agent-memory-trends-digest.md", "d\n");
    writeVaultFile(vault, ".skillwiki/agent-memory-trends/2026-06-11-run.json", "{}\n");
    writeVaultFile(vault, ".skillwiki/agent-memory-trends/latest-run.json", "{}\n");
    writeVaultFile(vault, "log.md", `${"vault log entry\n".repeat(20)}`);

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: [],
      maxFileBytes: 4,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects undeclared paths, too many tasks, too many web sources, and existing raw rewrites", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest({
      changedFiles: [
        "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        "queries/2026-06-11-agent-memory-trends-digest.md",
        "raw/transcripts/2026-06-11-task-1.md",
        "raw/transcripts/2026-06-11-task-2.md",
        "raw/transcripts/2026-06-11-task-3.md",
        "raw/transcripts/2026-06-11-task-4.md",
        "raw/articles/existing.md",
      ],
      outputs: {
        evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        taskCapturePaths: [
          "raw/transcripts/2026-06-11-task-1.md",
          "raw/transcripts/2026-06-11-task-2.md",
          "raw/transcripts/2026-06-11-task-3.md",
          "raw/transcripts/2026-06-11-task-4.md",
        ],
        taskCaptureRenderer: "typescript",
      },
      webSources: Array.from({ length: 16 }, (_, index) => `https://example.com/source-${index}`),
    });
    for (const path of runManifest.changedFiles) writeVaultFile(vault, path, "generated\n");

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: ["raw/articles/existing.md"],
      maxFileBytes: 128 * 1024,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid generated changes");
    expect(String(result.detail)).toContain("raw/articles/existing.md");
    expect(String(result.detail)).toContain("0-3 task captures");
    expect(String(result.detail)).toContain("max 15 web sources");
  });

  it("rejects symlinks, executable files, oversized files, and secret-like content", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest({
      changedFiles: [
        "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        "queries/2026-06-11-agent-memory-trends-digest.md",
        "raw/transcripts/2026-06-11-task-secret.md",
      ],
      outputs: {
        evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        taskCapturePaths: ["raw/transcripts/2026-06-11-task-secret.md"],
        taskCaptureRenderer: "typescript",
      },
    });
    writeVaultFile(vault, "raw/articles/2026-06-11-agent-memory-trends-evidence.md", "evidence\n");
    writeVaultFile(vault, "queries/2026-06-11-agent-memory-trends-digest.md", "digest\n", 0o755);
    writeVaultFile(vault, "raw/transcripts/2026-06-11-task-secret.md", "OPENAI_API_KEY=sk-test-secret\n");
    symlinkSync(
      join(vault, "raw/articles/2026-06-11-agent-memory-trends-evidence.md"),
      join(vault, ".skillwiki-link")
    );
    runManifest.changedFiles.push(".skillwiki-link");

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: [],
      maxFileBytes: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid generated changes");
    expect(String(result.detail)).toContain("symlink");
    expect(String(result.detail)).toContain("executable");
    expect(String(result.detail)).toContain("oversized");
    expect(String(result.detail)).toContain("secret");
  });

  it("rejects task captures that were not marked as TypeScript-rendered", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest({
      outputs: {
        evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        taskCapturePaths: ["raw/transcripts/2026-06-11-task-local-agent-memory.md"],
        sessionBriefPath: "meta/latest-session-brief.md",
        runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
      },
    });
    for (const path of runManifest.changedFiles) writeVaultFile(vault, path, `generated file ${path}\n`);

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: [],
      maxFileBytes: 128 * 1024,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected non-TypeScript captures to be rejected");
    expect(String(result.detail)).toContain("task captures must be rendered by TypeScript");
  });

  it("includes path categories in generated-output rejection diagnostics", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
    const runManifest = manifest({
      changedFiles: [
        ".skillwiki/session-brief.json",
        "concepts/unrelated.md",
        "queries/2026-06-11-agent-memory-trends-digest.md",
        "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        ".skillwiki/agent-memory-trends/latest-run.json",
      ],
      outputs: {
        evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
      },
    });
    for (const path of runManifest.changedFiles) writeVaultFile(vault, path, `generated file ${path}\n`);

    const result = validateGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      changedFiles: runManifest.changedFiles,
      manifest: runManifest,
      existingRawPaths: ["raw/articles/2026-06-11-agent-memory-trends-evidence.md"],
      maxFileBytes: 128 * 1024,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected categorized diagnostics");
    const detail = String(result.detail);
    expect(detail).toContain(".skillwiki/session-brief.json [session-brief-cache] is changed but not declared in manifest outputs");
    expect(detail).toContain("concepts/unrelated.md [typed-knowledge] is not in generated-output allowlist");
    expect(detail).toContain("raw/articles/2026-06-11-agent-memory-trends-evidence.md [evidence] rewrites an existing raw file");
  });
});
