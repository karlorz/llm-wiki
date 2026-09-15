/**
 * VaultCopyStatus — one interface for the three vault copies plus live drift.
 *
 * live:     S3/MCP (HTTP MCP writes)
 * github:   sg01 wiki-snapshot HEAD
 * local_git: leaf clone (wiki-fetch), including why pull skipped
 *
 * Callers must not collapse these planes. humanHint always names all four.
 */

export type PlaneState = "ok" | "stale" | "unknown" | "blocked";

export interface PlaneRecord {
  state: PlaneState;
  oid?: string;
  behind?: number;
  age_hours?: number;
  reachable?: boolean;
  blocked_reason?: string;
  dirty?: number;
  untracked?: number;
  ledger_untracked?: number;
  content_untracked?: number;
  detail?: string;
}

export interface CopyStatus {
  live: PlaneRecord;
  github: PlaneRecord;
  local_git: PlaneRecord;
  live_drift: LiveDriftRecord;
  humanHint: string;
}

export type LiveDriftState = "clean" | "drifted" | "unknown";

export interface LiveDriftRecord {
  state: LiveDriftState;
  content?: number;
  ledger?: number;
  detail?: string;
}

export interface LiveDriftProbe {
  content?: number;
  ledger?: number;
  unknown?: boolean;
  detail?: string;
}

export interface LiveProbe {
  reachable?: boolean;
  unknown?: boolean;
  detail?: string;
}

export interface GithubProbe {
  oid?: string;
  ageHours?: number;
  unknown?: boolean;
  detail?: string;
}

export interface LocalGitProbe {
  head?: string;
  behind?: number;
  blockedReason?: string;
  dirty?: number;
  untracked?: number;
  ledger_untracked?: number;
  content_untracked?: number;
  unknown?: boolean;
  detail?: string;
}

export interface CopyStatusDeps {
  probeLive(): Promise<LiveProbe> | LiveProbe;
  probeGithub(): Promise<GithubProbe> | GithubProbe;
  probeLocalGit(): Promise<LocalGitProbe> | LocalGitProbe;
  probeLiveDrift?(): Promise<LiveDriftProbe> | LiveDriftProbe;
}

function liveRecord(p: LiveProbe): PlaneRecord {
  if (p.unknown || p.reachable === undefined) {
    return { state: "unknown", reachable: p.reachable, detail: p.detail ?? "S3/MCP unmeasured" };
  }
  if (p.reachable) {
    return { state: "ok", reachable: true, detail: p.detail ?? "S3 reachable" };
  }
  return { state: "unknown", reachable: false, detail: p.detail ?? "S3 unreachable" };
}

function githubRecord(p: GithubProbe): PlaneRecord {
  if (p.unknown || !p.oid) {
    return { state: "unknown", age_hours: p.ageHours, detail: p.detail ?? "GitHub HEAD unmeasured" };
  }
  const rec: PlaneRecord = { state: "ok", oid: p.oid, detail: p.detail ?? "ls-remote origin main" };
  if (p.ageHours !== undefined) rec.age_hours = p.ageHours;
  return rec;
}

function withDirty(rec: PlaneRecord, p: LocalGitProbe): PlaneRecord {
  if (p.dirty !== undefined) rec.dirty = p.dirty;
  if (p.untracked !== undefined) rec.untracked = p.untracked;
  if (p.ledger_untracked !== undefined) rec.ledger_untracked = p.ledger_untracked;
  if (p.content_untracked !== undefined) rec.content_untracked = p.content_untracked;
  return rec;
}

function localRecord(p: LocalGitProbe, githubOid?: string): PlaneRecord {
  if (p.blockedReason) {
    return withDirty(
      {
        state: "blocked",
        oid: p.head,
        behind: p.behind,
        blocked_reason: p.blockedReason,
        detail: p.detail ?? p.blockedReason,
      },
      p,
    );
  }
  if (p.head && githubOid && p.head === githubOid && (p.behind === undefined || p.behind === 0)) {
    return withDirty(
      {
        state: "ok",
        oid: p.head,
        behind: p.behind,
        detail: p.detail ?? "HEAD matches GitHub",
      },
      p,
    );
  }
  if (p.behind !== undefined && p.behind > 0) {
    return withDirty(
      {
        state: "stale",
        oid: p.head,
        behind: p.behind,
        detail: p.detail ?? `behind origin/main by ${p.behind}`,
      },
      p,
    );
  }
  if (p.head && githubOid && p.head !== githubOid) {
    return withDirty(
      {
        state: "stale",
        oid: p.head,
        behind: p.behind,
        detail: p.detail ?? "HEAD differs from GitHub",
      },
      p,
    );
  }
  if (p.head) {
    return withDirty(
      {
        state: "ok",
        oid: p.head,
        behind: p.behind,
        detail: p.detail ?? "HEAD present",
      },
      p,
    );
  }
  return withDirty({ state: "unknown", detail: p.detail ?? "leaf clone unmeasured" }, p);
}

function liveDriftRecord(p: LiveDriftProbe | undefined): LiveDriftRecord {
  if (!p || p.unknown || (p.content === undefined && p.ledger === undefined)) {
    return { state: "unknown", detail: p?.detail ?? "live drift unmeasured" };
  }
  const content = p.content ?? 0;
  const ledger = p.ledger ?? 0;
  const rec: LiveDriftRecord = {
    state: content > 0 || ledger > 0 ? "drifted" : "clean",
  };
  if (p.content !== undefined) rec.content = content;
  if (p.ledger !== undefined) rec.ledger = ledger;
  if (p.detail) rec.detail = p.detail;
  return rec;
}

function formatLiveDrift(rec: LiveDriftRecord): string {
  const parts = [`live_drift: ${rec.state}`];
  if (rec.content !== undefined) parts.push(`content=${rec.content}`);
  if (rec.ledger !== undefined) parts.push(`ledger=${rec.ledger}`);
  if (rec.detail) parts.push(rec.detail);
  return parts.join(" ");
}

function formatPlane(name: string, rec: PlaneRecord): string {
  const parts = [`${name}: ${rec.state}`];
  if (rec.oid) parts.push(`oid=${rec.oid.slice(0, 12)}`);
  if (rec.behind !== undefined) parts.push(`behind=${rec.behind}`);
  if (rec.age_hours !== undefined) parts.push(`age_hours=${rec.age_hours}`);
  if (rec.ledger_untracked !== undefined) parts.push(`ledger_untracked=${rec.ledger_untracked}`);
  if (rec.content_untracked !== undefined) parts.push(`content_untracked=${rec.content_untracked}`);
  if (rec.ledger_untracked === undefined && rec.dirty !== undefined) parts.push(`dirty=${rec.dirty}`);
  if (rec.ledger_untracked === undefined && rec.untracked !== undefined) parts.push(`untracked=${rec.untracked}`);
  if (rec.blocked_reason) parts.push(rec.blocked_reason);
  if (rec.detail && rec.detail !== rec.blocked_reason) parts.push(rec.detail);
  return parts.join(" ");
}

export function composeCopyStatus(input: {
  live: LiveProbe;
  github: GithubProbe;
  local: LocalGitProbe;
  liveDrift?: LiveDriftProbe;
}): CopyStatus {
  const live = liveRecord(input.live);
  const github = githubRecord(input.github);
  const local_git = localRecord(input.local, input.github.oid);
  const live_drift = liveDriftRecord(input.liveDrift);
  const humanHint = [
    formatPlane("live", live),
    formatPlane("github", github),
    formatPlane("local_git", local_git),
    formatLiveDrift(live_drift),
  ].join("\n");
  return { live, github, local_git, live_drift, humanHint };
}

export async function runCopyStatus(deps: CopyStatusDeps): Promise<CopyStatus> {
  const [live, github, local, liveDrift] = await Promise.all([
    deps.probeLive(),
    deps.probeGithub(),
    deps.probeLocalGit(),
    deps.probeLiveDrift?.(),
  ]);
  return composeCopyStatus({ live, github, local, liveDrift });
}
