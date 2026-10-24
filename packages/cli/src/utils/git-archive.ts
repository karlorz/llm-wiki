import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Extract a git tree (ref) into destDir via a temporary `git archive`.
 *
 * Windows tar may reject Unicode filenames under the active code page even
 * in ZIP archives (#30). Windows PowerShell's .NET ZIP reader preserves them.
 * Git writes the ZIP straight to disk; paths are passed as environment data,
 * never interpolated into PowerShell source. POSIX retains its streaming tar.
 */
export function extractGitTree(vault: string, ref: string, destDir: string): void {
  if (process.platform === "win32") {
    const zipPath = `${destDir}.zip`;
    execFileSync("git", ["archive", "--format=zip", `--output=${zipPath}`, ref], {
      cwd: vault,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Expand-Archive -LiteralPath $env:SKILLWIKI_ARCHIVE_SOURCE -DestinationPath $env:SKILLWIKI_ARCHIVE_DEST -Force -ErrorAction Stop"], {
        cwd: destDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SKILLWIKI_ARCHIVE_SOURCE: zipPath, SKILLWIKI_ARCHIVE_DEST: destDir },
      });
    } finally {
      try {
        rmSync(zipPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    return;
  }
  const archive = execFileSync("git", ["archive", "--format=tar", ref], {
    cwd: vault,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-"], {
    cwd: destDir,
    input: archive,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
