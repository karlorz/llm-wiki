import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Extract a git tree (ref) into destDir via a temporary `git archive`.
 *
 * Windows bsdtar cannot reliably restore Unicode (e.g. CJK) paths from a Git
 * tar stream under a non-UTF-8 active code page (#30), but it restores the
 * same archive as zip correctly. Its zip reader also requires a seekable
 * input (the central directory sits at the end), so on Windows git writes
 * the zip straight to disk via --output instead of streaming it through
 * Node. POSIX tar handles Unicode paths fine and GNU tar cannot read zip,
 * so the streaming tar path stays everywhere else.
 */
export function extractGitTree(vault: string, ref: string, destDir: string): void {
  if (process.platform === "win32") {
    const zipPath = `${destDir}.zip`;
    execFileSync("git", ["archive", "--format=zip", `--output=${zipPath}`, ref], {
      cwd: vault,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      execFileSync("tar", ["-xf", zipPath], {
        cwd: destDir,
        stdio: ["pipe", "pipe", "pipe"],
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
