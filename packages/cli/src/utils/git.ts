import { execFileSync } from "node:child_process";

/** Run git and return trimmed stdout on success, or empty string on failure. */
export function git(cwd: string, args: string[], opts?: { timeoutMs?: number }): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    }).trim();
  } catch {
    return "";
  }
}

/** Run git and throw on failure, returning trimmed stdout. */
export function gitStrict(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
