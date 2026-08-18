import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import {
  probeGithubReachability,
  probeS3Reachability,
  probeSnapshotterSsh,
  resolveWikiS3Remote,
  type ExecProbe,
} from "../../utils/remote-health.js";
import {
  loadFleetManifestAndHost,
  snapshotterAliasForLocalHost,
  type FleetManifestAndHost,
} from "../../commands/fleet.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

function checkVaultGitRemote(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "vault_git_remote", "Vault git remote", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("warn", "vault_git_remote", "Vault git remote", "Vault is not a git repository — sync features unavailable");
  }
  try {
    const remote = execSync("git remote", { cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!remote) {
      return check("warn", "vault_git_remote", "Vault git remote", "No remote configured — push/pull unavailable");
    }
    let branch = "(no commits yet)";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch { /* empty repo — no HEAD yet */ }
    return check("pass", "vault_git_remote", "Vault git remote", `Remote: ${remote.split("\n")[0]}, branch: ${branch}`);
  } catch {
    return check("warn", "vault_git_remote", "Vault git remote", "Could not read git remote info");
  }
}

async function checkFleetIdentity(input: {
  vaultPath?: string;
  home: string;
  cwd?: string;
  envValue?: string;
  fleetLoad?: FleetManifestAndHost | null;
}): Promise<CheckResult> {
  if (!input.vaultPath) {
    return check("pass", "fleet_identity", "Fleet identity", "No vault path — check skipped");
  }

  const load =
    input.fleetLoad !== undefined
      ? input.fleetLoad
      : await loadFleetManifestAndHost({
          vault: input.vaultPath,
          env: { ...process.env, WIKI_PATH: input.envValue ?? input.vaultPath },
          home: input.home,
          cwd: input.cwd ?? process.cwd(),
          osHostname: process.env.HOSTNAME,
          user: process.env.USER,
        });

  if (!load) {
    return check("pass", "fleet_identity", "Fleet identity", "Fleet manifest unavailable — check skipped");
  }
  if (load.identityStatus === "known") {
    return check("pass", "fleet_identity", "Fleet identity", `Resolved ${load.hostId ?? "unknown"} via ${load.source ?? "unknown"}`);
  }

  const detail = load.warnings.length > 0 ? load.warnings.join("; ") : "Fleet identity is unresolved";
  return check("warn", "fleet_identity", "Fleet identity", detail);
}

function checkSyncLastPush(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "sync_last_push", "Vault sync recency", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "sync_last_push", "Vault sync recency", "No git repo — sync check skipped");
  }
  let timestamp: number | undefined;
  // Try origin/HEAD first (last pushed commit)
  try {
    const out = execSync("git log -1 --format=%ct origin/HEAD", {
      cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    timestamp = parseInt(out, 10);
  } catch {
    // Fallback to last local commit
    try {
      const out = execSync("git log -1 --format=%ct HEAD", {
        cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      timestamp = parseInt(out, 10);
    } catch {
      // No commits at all
    }
  }
  if (timestamp === undefined || isNaN(timestamp)) {
    return check("warn", "sync_last_push", "Vault sync recency", "No commits found — consider running `skillwiki sync status`");
  }
  const daysSince = Math.floor((Date.now() / 1000 - timestamp) / 86400);
  const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10);
  if (daysSince > 7) {
    return check("warn", "sync_last_push", "Vault sync recency", `Last push was ${daysSince} days ago — consider running \`skillwiki sync status\``);
  }
  return check("pass", "sync_last_push", "Vault sync recency", `Last push: ${dateStr} (${daysSince} day(s) ago)`);
}

function hasOriginMain(resolvedPath: string): boolean {
  try {
    execSync("git rev-parse --verify --quiet origin/main", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function checkVaultGitDirty(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_git_dirty", "Vault git dirty state", "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "vault_git_dirty", "Vault git dirty state", "No git repo — check skipped");
  }
  try {
    const lines = execSync("git status --porcelain", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      return check("warn", "vault_git_dirty", "Vault git dirty state", `${lines.length} dirty file(s) in vault worktree`);
    }
    return check("pass", "vault_git_dirty", "Vault git dirty state", "Clean worktree");
  } catch {
    return check("warn", "vault_git_dirty", "Vault git dirty state", "Could not read git status");
  }
}

function gitRefHash(resolvedPath: string, ref: string): string | undefined {
  try {
    const out = execSync(`git rev-parse --verify ${ref}`, {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function remoteMainHash(resolvedPath: string): string | undefined {
  try {
    const out = execSync("git ls-remote origin refs/heads/main", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    const hash = out.split(/\s+/)[0];
    return /^[0-9a-f]{40}$/i.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

function checkStaleRemoteMain(resolvedPath: string | undefined): CheckResult | undefined {
  if (resolvedPath === undefined) return undefined;
  if (!existsSync(join(resolvedPath, ".git"))) return undefined;
  const localOrigin = gitRefHash(resolvedPath, "origin/main");
  if (!localOrigin) return undefined;
  const remoteMain = remoteMainHash(resolvedPath);
  if (!remoteMain || remoteMain === localOrigin) return undefined;
  return check("warn", "vault_git_behind", "Vault commits behind",
    `Remote main differs from local origin/main (${remoteMain.slice(0, 8)} != ${localOrigin.slice(0, 8)}) — run git fetch before trusting behind count`);
}

function checkVaultGitComparison(
  resolvedPath: string | undefined,
  id: string,
  label: string,
  range: string,
  nonZeroSuffix: string,
  zeroDetail: string,
): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", id, label, "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", id, label, "No git repo — check skipped");
  }
  if (!hasOriginMain(resolvedPath)) {
    return check("pass", id, label, "origin/main unavailable — check skipped");
  }
  try {
    const count = parseInt(execSync(`git rev-list --count ${range}`, {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim(), 10);
    if (count > 0) {
      return check("warn", id, label, `${count} commit(s) ${nonZeroSuffix}`);
    }
    return check("pass", id, label, zeroDetail);
  } catch {
    return check("warn", id, label, "Could not compare HEAD with origin/main");
  }
}

function checkVaultGitAhead(resolvedPath: string | undefined): CheckResult {
  return checkVaultGitComparison(
    resolvedPath,
    "vault_git_ahead",
    "Vault commits ahead",
    "origin/main..HEAD",
    "ahead of origin/main",
    "0 commits ahead of origin/main",
  );
}

function checkVaultGitBehind(resolvedPath: string | undefined): CheckResult {
  const staleRemote = checkStaleRemoteMain(resolvedPath);
  if (staleRemote) return staleRemote;
  return checkVaultGitComparison(
    resolvedPath,
    "vault_git_behind",
    "Vault commits behind",
    "HEAD..origin/main",
    "behind origin/main",
    "0 commits behind origin/main",
  );
}

function pullLogPaths(home: string): string[] {
  const paths = platform() === "darwin"
    ? [
      join(home, "Library", "Logs", "wiki-pull.log"),
      join(home, ".local", "state", "vault-sync", "log", "wiki-pull.log"),
    ]
    : [
      join(home, ".local", "state", "vault-sync", "log", "wiki-pull.log"),
      join(home, "Library", "Logs", "wiki-pull.log"),
    ];
  return [...new Set(paths)];
}

function isRecentLogLine(line: string, nowMs: number): boolean {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
  if (!match) return true;
  const ts = Date.parse(match[1]);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts <= 24 * 60 * 60 * 1000;
}

function checkVaultGitPullFailures(home: string): CheckResult {
  const path = pullLogPaths(home).find(p => existsSync(p));
  if (!path) {
    return check("pass", "vault_git_pull_failures", "Vault pull failures", "No wiki-pull.log found — check skipped");
  }
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    const now = Date.now();
    const failures = lines.filter(line =>
      isRecentLogLine(line, now) &&
      /(pre-push pull failed|FAIL .*pull|FAIL .*rebase|cannot pull with rebase|unstaged changes)/i.test(line)
    );
    if (failures.length > 0) {
      const sample = failures.slice(-2).map(line => line.slice(0, 100)).join(" | ");
      return check("warn", "vault_git_pull_failures", "Vault pull failures", `${failures.length} recent pull failure(s): ${sample}`);
    }
    return check("pass", "vault_git_pull_failures", "Vault pull failures", "No recent pull failures logged");
  } catch {
    return check("warn", "vault_git_pull_failures", "Vault pull failures", `Could not read ${path}`);
  }
}

function checkVaultLocalGit(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("warn", "vault_local_git", "Vault local git", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("warn", "vault_local_git", "Vault local git", "Not a git repository - sync features unavailable");
  }
  try {
    execSync("git rev-parse --git-dir", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    });
    return check("pass", "vault_local_git", "Vault local git", "Git metadata readable");
  } catch {
    return check("error", "vault_local_git", "Vault local git", "Git metadata unreadable — local vault may be corrupt");
  }
}

function checkVaultGithubRemote(
  resolvedPath: string | undefined,
  exec?: ExecProbe,
): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_github_remote", "Vault GitHub remote", "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "vault_github_remote", "Vault GitHub remote", "No git repo — check skipped");
  }
  const state = probeGithubReachability(resolvedPath, exec);
  if (state === "ok") {
    return check("pass", "vault_github_remote", "Vault GitHub remote", "git ls-remote origin main succeeded");
  }
  if (state === "unreachable") {
    return check("warn", "vault_github_remote", "Vault GitHub remote", "GitHub unreachable (ls-remote failed) — local vault still usable");
  }
  return check("pass", "vault_github_remote", "Vault GitHub remote", "No origin remote — network probe skipped");
}

function checkVaultS3Remote(home: string, exec?: ExecProbe, env?: NodeJS.ProcessEnv): CheckResult {
  const remote = resolveWikiS3Remote({ home, env });
  if (!remote) {
    return check("pass", "vault_s3_remote", "Vault S3 remote", "S3 remote not configured — check skipped");
  }
  const state = probeS3Reachability(remote, exec);
  if (state === "ok") {
    return check("pass", "vault_s3_remote", "Vault S3 remote", `rclone lsf ${remote} succeeded`);
  }
  if (state === "unreachable") {
    return check("warn", "vault_s3_remote", "Vault S3 remote", `S3 remote unreachable (${remote}) — local/GitHub work may continue`);
  }
  return check("pass", "vault_s3_remote", "Vault S3 remote", "S3 remote not configured — check skipped");
}

function checkVaultSnapshotterReachable(
  fleetLoad: FleetManifestAndHost | null,
  checkSnapshotter: boolean | undefined,
  exec?: ExecProbe,
): CheckResult {
  if (!checkSnapshotter) {
    return check("pass", "vault_snapshotter_reachable", "Vault snapshotter host", "Snapshotter SSH probe not requested — check skipped");
  }
  const alias = snapshotterAliasForLocalHost(fleetLoad);
  if (!alias) {
    return check("pass", "vault_snapshotter_reachable", "Vault snapshotter host", "No declared SSH alias from this host — check skipped");
  }
  const state = probeSnapshotterSsh(alias, exec);
  if (state === "ok") {
    return check("pass", "vault_snapshotter_reachable", "Vault snapshotter host", `SSH reachable via ${alias}`);
  }
  return check("warn", "vault_snapshotter_reachable", "Vault snapshotter host", `Snapshotter unreachable via ${alias} — not a local vault corruption signal`);
}

function checkVaultPromotionLag(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_promotion_lag", "Vault promotion lag", "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "vault_promotion_lag", "Vault promotion lag", "No git repo — check skipped");
  }
  try {
    const out = execSync("git log -1 --format=%ct origin/main", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
    const ts = parseInt(out, 10);
    if (!Number.isFinite(ts) || ts <= 0) {
      return check("pass", "vault_promotion_lag", "Vault promotion lag", "origin/main timestamp unavailable — check skipped");
    }
    const ageHours = Math.floor((Date.now() / 1000 - ts) / 3600);
    if (ageHours > 48) {
      return check("warn", "vault_promotion_lag", "Vault promotion lag", `Local origin/main snapshot is ${ageHours}h old — verify snapshotter/GitHub when online`);
    }
    return check("pass", "vault_promotion_lag", "Vault promotion lag", `origin/main age ${ageHours}h`);
  } catch {
    return check("pass", "vault_promotion_lag", "Vault promotion lag", "Could not read origin/main — check skipped");
  }
}

export const gitFleetProbe: DoctorProbe = {
  id: "git_fleet",
  async run(ctx: DoctorContext): Promise<CheckResult[]> {
    return [
      checkVaultGitRemote(ctx.gitCheckPath),
      await checkFleetIdentity({
        vaultPath: ctx.resolvedPath,
        home: ctx.input.home,
        cwd: ctx.input.cwd,
        envValue: ctx.input.envValue,
        fleetLoad: ctx.fleetLoad,
      }),
      checkSyncLastPush(ctx.gitCheckPath),
      checkVaultGitDirty(ctx.gitCheckPath),
      checkVaultGitAhead(ctx.gitCheckPath),
      checkVaultGitBehind(ctx.gitCheckPath),
      checkVaultGitPullFailures(ctx.input.home),
      checkVaultLocalGit(ctx.gitCheckPath),
      checkVaultGithubRemote(ctx.gitCheckPath, ctx.input.execProbe),
      checkVaultS3Remote(ctx.input.home, ctx.input.execProbe, ctx.input.env ?? process.env),
      checkVaultSnapshotterReachable(ctx.fleetLoad, ctx.input.checkSnapshotter, ctx.input.execProbe),
      checkVaultPromotionLag(ctx.gitCheckPath),
    ];
  },
};
