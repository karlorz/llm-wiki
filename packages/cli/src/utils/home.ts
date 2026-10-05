import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolveSkillwikiHome(
  home?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const candidate of [home, env.HOME, env.USERPROFILE]) {
    if (candidate?.trim()) return resolve(candidate);
  }
  try {
    const fallback = homedir();
    if (fallback?.trim()) return resolve(fallback);
  } catch {
    throw new Error("Could not resolve SkillWiki home directory");
  }
  throw new Error("Could not resolve SkillWiki home directory");
}
