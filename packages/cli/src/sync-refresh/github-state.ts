import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type GithubPlaneState = "unknown" | "absent_from_origin" | "matches_origin" | "differs_from_origin";

function gitShow(vault: string, spec: string): Buffer | null {
  try {
    return execFileSync("git", ["show", spec], {
      cwd: vault,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function originRef(vault: string): string | null {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: vault, stdio: ["pipe", "pipe", "pipe"] });
    return "origin/main";
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/HEAD"], { cwd: vault, stdio: ["pipe", "pipe", "pipe"] });
      return "origin/HEAD";
    } catch {
      return null;
    }
  }
}

export function githubPlaneState(vault: string, rel: string, incomingSha256: string): GithubPlaneState {
  if (!existsSync(join(vault, ".git"))) return "unknown";
  const ref = originRef(vault);
  if (!ref) return "unknown";
  const bytes = gitShow(vault, `${ref}:${rel}`);
  if (!bytes) return "absent_from_origin";
  const sha = createHash("sha256").update(bytes).digest("hex");
  return sha === incomingSha256 ? "matches_origin" : "differs_from_origin";
}

export function gitHeadBytes(vault: string, rel: string): Buffer | null {
  if (!existsSync(join(vault, ".git"))) return null;
  return gitShow(vault, `HEAD:${rel}`);
}
