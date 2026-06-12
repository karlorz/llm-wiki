import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishGeneratedChanges, type PublisherCommand } from "../src/publish.js";

function writeVaultFile(vault: string, relPath: string, body: string): void {
  const fullPath = join(vault, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
}

function seedGeneratedVault(): { vault: string; manifestPath: string; changedFiles: string[] } {
  const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-publish-"));
  const changedFiles = [
    ".skillwiki/session-brief.json",
    ".skillwiki/session-brief.md",
    "index.md",
    "log.md",
    "meta/latest-session-brief.md",
    "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
    "queries/2026-06-11-agent-memory-trends-digest.md",
    "raw/transcripts/2026-06-11-task-local-agent-memory.md",
    ".skillwiki/agent-memory-trends/2026-06-11-run.json",
  ];
  writeVaultFile(vault, "raw/articles/2026-06-11-agent-memory-trends-evidence.md", "evidence\n");
  writeVaultFile(vault, "index.md", "# Index\n\n## Meta\n- [[meta/latest-session-brief]] - Latest Session Brief\n");
  writeVaultFile(vault, "log.md", "# Log\n\n## [2026-06-11] session-brief | refreshed: meta/latest-session-brief.md\n");
  writeVaultFile(vault, ".skillwiki/session-brief.md", "# Session Brief\n\nUpdated capsule.\n");
  writeVaultFile(vault, ".skillwiki/session-brief.json", '{"brief":"Updated capsule."}\n');
  writeVaultFile(
    vault,
    "meta/latest-session-brief.md",
    [
      "---",
      "title: Latest Session Brief",
      "created: 2026-06-11",
      "updated: 2026-06-11",
      "type: meta",
      "tags: [generated, session-brief]",
      "confidence: high",
      "generated_by: skillwiki session-brief",
      "generated_at: 2026-06-11T00:10:00Z",
      "generated_kind: session-brief",
      "---",
      "",
      "# Session Brief",
      "",
      "Updated capsule.",
      "",
    ].join("\n")
  );
  writeVaultFile(
    vault,
    "queries/2026-06-11-agent-memory-trends-digest.md",
    "digest cites raw/articles/2026-06-11-agent-memory-trends-evidence.md\n"
  );
  writeVaultFile(vault, "raw/transcripts/2026-06-11-task-local-agent-memory.md", "task\n");
  const manifestPath = ".skillwiki/agent-memory-trends/2026-06-11-run.json";
  writeVaultFile(
    vault,
    manifestPath,
    JSON.stringify(
      {
        run_date: "2026-06-11",
        changed_files: changedFiles,
        outputs: {
          evidence_path: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
          digest_path: "queries/2026-06-11-agent-memory-trends-digest.md",
          task_capture_paths: ["raw/transcripts/2026-06-11-task-local-agent-memory.md"],
          task_capture_renderer: "typescript",
          run_state_path: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
        },
        web_sources: ["https://example.com/source"],
      },
      null,
      2
    ) + "\n"
  );
  return { vault, manifestPath, changedFiles };
}

describe("agent-memory-trends publisher gate", () => {
  it("fetches, validates generated outputs, validates/lints/audits, commits, pulls, and pushes without force", async () => {
    const { vault, manifestPath, changedFiles } = seedGeneratedVault();
    const expectedChangedFiles = [...changedFiles, ".skillwiki/agent-memory-trends/latest-run.json"].sort((left, right) => left.localeCompare(right));
    const commands: PublisherCommand[] = [];

    const result = await publishGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      manifestPath,
      acquireLock: async () => ({ ok: true, data: { release: async () => undefined } }),
      git: async (args) => {
        commands.push({ tool: "git", args });
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "status") {
          return {
            exitCode: 0,
            stdout: changedFiles
              .map((path) => path.startsWith("raw/transcripts/") ? `?? ${path}` : ` M ${path}`)
              .join("\n") + "\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      skillwiki: async (args) => {
        commands.push({ tool: "skillwiki", args });
        if (args[0] === "lint") return { exitCode: 0, stdout: '{"summary":{"error":0}}\n', stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      existingRawPaths: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected publish success");
    expect(result.data.baseCommit).toBe("abc123");
    expect(result.data.changedFiles).toEqual(expectedChangedFiles);
    expect(commands).toEqual([
      { tool: "git", args: ["fetch", "origin", "main"] },
      { tool: "git", args: ["rev-parse", "HEAD"] },
      { tool: "git", args: ["status", "--porcelain", "--untracked-files=all"] },
      { tool: "skillwiki", args: ["validate", join(vault, "raw/articles/2026-06-11-agent-memory-trends-evidence.md")] },
      { tool: "skillwiki", args: ["validate", join(vault, "raw/transcripts/2026-06-11-task-local-agent-memory.md")] },
      { tool: "skillwiki", args: ["validate", join(vault, "queries/2026-06-11-agent-memory-trends-digest.md")] },
      { tool: "skillwiki", args: ["validate", join(vault, "meta/latest-session-brief.md")] },
      { tool: "skillwiki", args: ["lint", vault, "--summary"] },
      { tool: "skillwiki", args: ["audit", join(vault, "queries/2026-06-11-agent-memory-trends-digest.md")] },
      { tool: "git", args: ["add", "--", ...expectedChangedFiles] },
      { tool: "git", args: ["commit", "-m", "research(agent-memory): daily digest 2026-06-11"] },
      { tool: "git", args: ["pull", "--rebase", "origin", "main"] },
      { tool: "git", args: ["push", "origin", "HEAD:main"] },
    ]);
    expect(commands.some((command) => command.args.includes("--force") || command.args.includes("--force-with-lease"))).toBe(false);
  });

  it("blocks unrelated dirty files before committing generated output", async () => {
    const { vault, manifestPath } = seedGeneratedVault();
    const result = await publishGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      manifestPath,
      acquireLock: async () => ({ ok: true, data: { release: async () => undefined } }),
      git: async (args) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: " M concepts/unrelated.md\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      skillwiki: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      existingRawPaths: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected allowlist failure");
    expect(result.error).toBe("VALIDATION_FAILED");
    expect(String(result.detail)).toContain("concepts/unrelated.md is not in generated-output allowlist");
  });

  it("rejects generated failure manifests before committing", async () => {
    const { vault, manifestPath, changedFiles } = seedGeneratedVault();
    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    manifest.status = "failure";
    manifest.failure_class = "allowlist";
    writeVaultFile(vault, manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const commands: PublisherCommand[] = [];

    const result = await publishGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      manifestPath,
      acquireLock: async () => ({ ok: true, data: { release: async () => undefined } }),
      git: async (args) => {
        commands.push({ tool: "git", args });
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "status") {
          return {
            exitCode: 0,
            stdout: changedFiles.map((path) => ` M ${path}`).join("\n") + "\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      skillwiki: async (args) => {
        commands.push({ tool: "skillwiki", args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      existingRawPaths: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed manifest to be rejected");
    expect(result.error).toBe("VALIDATION_FAILED");
    expect(String(result.detail)).toContain("run manifest status failure");
    expect(commands.some((command) => command.tool === "git" && command.args[0] === "commit")).toBe(false);
  });

  it("detects untracked generated files before validating and committing", async () => {
    const { vault, manifestPath, changedFiles } = seedGeneratedVault();
    const inputPath = ".skillwiki/agent-memory-trends/2026-06-11-input.json";
    const statusFiles = [inputPath, ...changedFiles];
    const expectedChangedFiles = [...statusFiles, ".skillwiki/agent-memory-trends/latest-run.json"].sort((left, right) => left.localeCompare(right));
    writeVaultFile(vault, inputPath, '{"selected_candidates":[]}\n');
    const commands: PublisherCommand[] = [];

    const result = await publishGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      manifestPath,
      acquireLock: async () => ({ ok: true, data: { release: async () => undefined } }),
      git: async (args) => {
        commands.push({ tool: "git", args });
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "status") {
          return {
            exitCode: 0,
            stdout: statusFiles.map((path) => `?? ${path}`).join("\n") + "\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      skillwiki: async (args) => {
        commands.push({ tool: "skillwiki", args });
        if (args[0] === "lint") return { exitCode: 0, stdout: '{"summary":{"error":0}}\n', stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      existingRawPaths: [],
    });

    expect(result.ok).toBe(true);
    expect(commands).toContainEqual({ tool: "git", args: ["status", "--porcelain", "--untracked-files=all"] });
    expect(commands).toContainEqual({ tool: "git", args: ["add", "--", ...expectedChangedFiles] });
    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    expect(manifest.changed_files).toContain(inputPath);
    expect(manifest.changed_files).toContain(".skillwiki/agent-memory-trends/latest-run.json");
  });

  it("materializes latest-run JSON before validating and committing generated files", async () => {
    const { vault, manifestPath, changedFiles } = seedGeneratedVault();
    const commands: PublisherCommand[] = [];

    const result = await publishGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      manifestPath,
      acquireLock: async () => ({ ok: true, data: { release: async () => undefined } }),
      git: async (args) => {
        commands.push({ tool: "git", args });
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "status") {
          return {
            exitCode: 0,
            stdout: changedFiles.map((path) => `?? ${path}`).join("\n") + "\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      skillwiki: async (args) => {
        commands.push({ tool: "skillwiki", args });
        if (args[0] === "lint") return { exitCode: 0, stdout: '{"summary":{"error":0}}\n', stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      existingRawPaths: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected publish success");
    const latestRunPath = ".skillwiki/agent-memory-trends/latest-run.json";
    expect(result.data.changedFiles).toContain(latestRunPath);
    expect(commands).toContainEqual({ tool: "git", args: ["add", "--", ...[...changedFiles, latestRunPath].sort((left, right) => left.localeCompare(right))] });
    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    const latest = JSON.parse(readFileSync(join(vault, latestRunPath), "utf8"));
    expect(manifest.changed_files).toContain(latestRunPath);
    expect(manifest.outputs.latest_run_path).toBe(latestRunPath);
    expect(manifest.outputs.session_brief_path).toBe("meta/latest-session-brief.md");
    expect(manifest.outputs.session_brief_cache_paths).toEqual([
      ".skillwiki/session-brief.json",
      ".skillwiki/session-brief.md",
    ]);
    expect(manifest.outputs.session_brief_support_paths).toEqual(["index.md", "log.md"]);
    expect(latest).toEqual(manifest);
  });

  it("continues when whole-vault lint reports pre-existing errors", async () => {
    const { vault, manifestPath, changedFiles } = seedGeneratedVault();
    let released = false;

    const result = await publishGeneratedChanges({
      vault,
      runDate: "2026-06-11",
      manifestPath,
      acquireLock: async () => ({ ok: true, data: { release: async () => { released = true; } } }),
      git: async (args) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        if (args[0] === "status") {
          return {
            exitCode: 0,
            stdout: changedFiles.map((path) => `?? ${path}`).join("\n") + "\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      skillwiki: async (args) => {
        if (args[0] === "lint") return { exitCode: 1, stdout: '{"summary":{"error":1}}\n', stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      existingRawPaths: [],
    });

    expect(result.ok).toBe(true);
    expect(released).toBe(true);
  });
});
