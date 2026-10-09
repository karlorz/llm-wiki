import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runFleetContext } from "../../../cli/src/commands/fleet.js";
import { runMemoryRecall } from "../../../cli/src/commands/memory.js";
import { runQuery } from "../../../cli/src/commands/query.js";
import { runStatus } from "../../../cli/src/commands/status.js";
import { runCopyStatusCommand } from "../../../cli/src/commands/copy-status.js";
import { runSourcesPending, type SourceScope } from "../../../cli/src/commands/sources.js";
import { runSourceCompileStatus, runSourceReviews } from "../../../cli/src/commands/source-compile.js";
import { runLint, type LintSummaryInput } from "../../../cli/src/commands/lint.js";
import { runStale } from "../../../cli/src/commands/stale.js";
import type { Result } from "@skillwiki/shared";
import { extractFrontmatter } from "../../../cli/src/parsers/frontmatter.js";
import { resolveWithinVault } from "../allowlist.js";
import { MCP_INSTRUCTIONS } from "../mcp-instructions.js";
import { ReconcileGate } from "../reconcile.js";
import { sha256Bytes } from "../txn.js";
import { currentVersion, type GetObject } from "../versions.js";
import { CAPTURE_KINDS, normalizeCaptureProject, vaultHasProject } from "./writes.js";
import { identityToken } from "@skillwiki/shared";
import type { S3WriteHealth } from "../s3-write-probe.js";
import { DEFAULT_VAULT_ID } from "../vault-id.js";

export const MAX_READ_PAGE_BYTES = 256 * 1024;

export interface ReadContext extends S3WriteHealth {
  vaultDir: string;
  vaultId?: string;
  defaultVault?: string;
  allowedVaults?: readonly string[];
  hostId?: string;
  gate: ReconcileGate;
  getObject?: GetObject;
  s3Ok?: boolean;
  vaultReadiness?: ReadonlyArray<{ vault_id: string; reconcile_ready: boolean; last_error?: string }>;
}

export type WikiReadPageResult =
  | { ok: false; error: "TOOLS_NOT_READY"; message: string }
  | { ok: false; error: "PATH_DENIED"; path: string }
  | { ok: false; error: "FILE_NOT_FOUND"; path: string }
  | { ok: false; error: "USAGE"; message: string; path: string }
  | {
      ok: false;
      error: "PAGE_TOO_LARGE";
      path: string;
      message: string;
      sha256: string;
      byte_length: number;
      s3_verified: boolean;
    }
  | {
      ok: true;
      path: string;
      markdown: string;
      frontmatter: Record<string, unknown>;
      sha256: string;
      byte_length?: number;
      s3_verified: boolean;
    };

function notReady(): { ok: false; error: "TOOLS_NOT_READY"; message: string } {
  return { ok: false, error: "TOOLS_NOT_READY", message: "tools blocked until first S3 reconcile completes" };
}

function ensureReady(gate: ReconcileGate): { ok: false; error: "TOOLS_NOT_READY"; message: string } | null {
  return gate.ready ? null : notReady();
}

function flattenReadCommandResult(result: Result<unknown>) {
  if (!result.ok) {
    return { ok: false as const, error: result.error, detail: result };
  }
  return { ok: true as const, ...(result.data as Record<string, unknown>) };
}

export async function handleWikiQuery(
  ctx: ReadContext,
  input: { query: string; limit?: number; include_pending?: boolean; scope?: string; project?: string },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  if (!input.query.trim()) {
    return { ok: false as const, error: "USAGE", message: "query must not be empty" };
  }
  if (input.project !== undefined) {
    const project = normalizeCaptureProject(input.project);
    if (!project) {
      return { ok: false as const, error: "USAGE", message: "project must be a vault project slug" };
    }
    if (!vaultHasProject(ctx.vaultDir, project)) {
      return { ok: false as const, error: "USAGE", message: "unknown project" };
    }
  }
  if (input.scope !== undefined) {
    const scope = input.scope.trim();
    if (scope !== "typed" && scope !== "work" && scope !== "all") {
      return { ok: false as const, error: "USAGE", message: "scope must be typed, work, or all" };
    }
  }
  const result = await runQuery({
    vault: ctx.vaultDir,
    text: input.query,
    limit: input.limit,
    includePending: input.include_pending,
    scope: input.scope?.trim() as "typed" | "work" | "all" | undefined,
  });
  if (!result.result.ok) {
    return { ok: false as const, error: result.result.error, detail: result.result };
  }
  return { ok: true as const, ...result.result.data };
}

async function readLocalBytes(abs: string): Promise<Buffer | null> {
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

function utf8SafeTail(bytes: Buffer, tailBytes: number): Buffer {
  if (tailBytes >= bytes.byteLength) return bytes;
  let start = bytes.byteLength - tailBytes;
  while (start < bytes.byteLength && start > 0 && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start);
}

export async function handleWikiReadPage(
  ctx: ReadContext,
  input: { path: string; tail_bytes?: number },
): Promise<WikiReadPageResult> {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const abs = resolveWithinVault(ctx.vaultDir, input.path);
  if (!abs) return { ok: false, error: "PATH_DENIED", path: input.path };

  let s3Verified = false;
  let bytes: Buffer | null = null;
  let sha256: string | undefined;

  if (ctx.getObject) {
    try {
      const ver = await currentVersion({ vaultDir: ctx.vaultDir, getObject: ctx.getObject }, input.path);
      if (ver.absent) {
        return { ok: false, error: "FILE_NOT_FOUND", path: input.path };
      }
      bytes = ver.bytes ?? (await readLocalBytes(abs));
      sha256 = ver.sha256;
      s3Verified = true;
    } catch {
      // S3 unreachable: serve working copy bytes and set s3_verified: false
      bytes = await readLocalBytes(abs);
      s3Verified = false;
    }
  } else {
    bytes = await readLocalBytes(abs);
  }

  if (!bytes) {
    return { ok: false, error: "FILE_NOT_FOUND", path: input.path };
  }

  const fullSha = sha256 ?? sha256Bytes(bytes);
  const tail = input.tail_bytes;
  if (tail !== undefined) {
    if (!Number.isInteger(tail) || tail < 1 || tail > MAX_READ_PAGE_BYTES) {
      return {
        ok: false,
        error: "USAGE",
        message: `tail_bytes must be an integer from 1 to ${MAX_READ_PAGE_BYTES}`,
        path: input.path,
      };
    }
    const slice = utf8SafeTail(bytes, tail);
    const markdown = slice.toString("utf8");
    const fm = extractFrontmatter(markdown);
    return {
      ok: true,
      path: input.path,
      markdown,
      frontmatter: fm.ok ? fm.data : {},
      sha256: fullSha,
      byte_length: bytes.byteLength,
      s3_verified: s3Verified,
    };
  }

  if (bytes.byteLength > MAX_READ_PAGE_BYTES) {
    return {
      ok: false,
      error: "PAGE_TOO_LARGE",
      path: input.path,
      message: `page exceeds ${MAX_READ_PAGE_BYTES}-byte wiki_read_page limit; request a smaller page`,
      sha256: fullSha,
      byte_length: bytes.byteLength,
      s3_verified: s3Verified,
    };
  }

  const markdown = bytes.toString("utf8");
  const fm = extractFrontmatter(markdown);
  return {
    ok: true,
    path: input.path,
    markdown,
    frontmatter: fm.ok ? fm.data : {},
    sha256: fullSha,
    s3_verified: s3Verified,
  };
}

export async function handleWikiMemoryRecall(
  ctx: ReadContext,
  input: { project: string; topic: string; scope?: string },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const project = normalizeCaptureProject(input.project);
  if (!project) {
    return { ok: false as const, error: "USAGE", message: "project must be a vault project slug" };
  }
  if (!vaultHasProject(ctx.vaultDir, project)) {
    return { ok: false as const, error: "USAGE", message: "unknown project" };
  }
  if (input.scope !== undefined) {
    const scope = input.scope.trim();
    if (scope !== "project" && scope !== "global" && scope !== "all") {
      return { ok: false as const, error: "USAGE", message: "scope must be project, global, or all" };
    }
  }
  const result = await runMemoryRecall({
    vault: ctx.vaultDir,
    project,
    topic: input.topic,
    scope: input.scope?.trim() as "project" | "global" | "all" | undefined,
  });
  if (!result.result.ok) {
    return { ok: false as const, error: result.result.error, detail: result.result };
  }
  return { ok: true as const, ...result.result.data };
}

export type StatusFleetIdentity = {
  identity_status: "known" | "unknown" | "invalid";
  manifest_loaded: boolean;
  host_id?: string;
  source?: string;
};

async function statusFleetIdentity(ctx: ReadContext): Promise<StatusFleetIdentity> {
  const fleet = await runFleetContext({
    vault: ctx.vaultDir,
    hostId: ctx.hostId,
    env: {},
    home: "",
    cwd: ctx.vaultDir,
  });
  if (!fleet.result.ok) {
    return { identity_status: "unknown", manifest_loaded: false };
  }
  const data = fleet.result.data;
  return {
    identity_status: data.identity_status,
    manifest_loaded: data.manifest_loaded,
    ...(data.host_id ? { host_id: data.host_id } : {}),
    ...(data.source ? { source: data.source } : {}),
  };
}

export async function handleWikiStatus(
  ctx: ReadContext,
  input?: { host_id?: string },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;

  if (input?.host_id !== undefined) {
    const requested = input.host_id.trim();
    if (!requested) {
      return { ok: false as const, error: "USAGE", message: "host identity is required" };
    }
    if (!ctx.hostId || requested !== ctx.hostId) {
      return { ok: false as const, error: "USAGE", message: "unknown host-id" };
    }
  }

  if (!ctx.hostId) {
    return { ok: false as const, error: "USAGE", message: "host identity is required" };
  }

  const writerId = ctx.hostId;
  const fleet = await statusFleetIdentity(ctx);
  if (input?.host_id !== undefined && fleet.manifest_loaded && fleet.identity_status !== "known") {
    return { ok: false as const, error: "USAGE", message: "unknown host-id" };
  }
  const [result, copies] = await Promise.all([
    runStatus({
      vault: ctx.vaultDir,
      home: process.env.HOME ?? "",
      langEnvValue: process.env.WIKI_LANG,
    }),
    runCopyStatusCommand({
      vault: ctx.vaultDir,
      home: process.env.HOME ?? "",
      s3Ok: ctx.s3Ok ?? true,
      s3Writable: ctx.s3Writable === true,
      s3WritableError: ctx.s3WritableError,
    }),
  ]);
  const base = result.result.ok ? result.result.data : { humanHint: "status failed" };
  const copiesData = copies.result.ok ? copies.result.data : undefined;
  const humanHint = [base.humanHint, copiesData?.humanHint].filter(Boolean).join("\n\n");
  return {
    ok: true as const,
    vault_path: ctx.vaultDir,
    vault_id: ctx.vaultId ?? DEFAULT_VAULT_ID,
    reconcile_ready: ctx.gate.ready,
    s3_ok: ctx.s3Ok ?? true,
    s3_writable: ctx.s3Writable === true,
    healthy: ctx.gate.ready && (ctx.s3Ok ?? true) && ctx.s3Writable === true,
    ...(ctx.s3WritableCheckedAt ? { s3_writable_checked_at: ctx.s3WritableCheckedAt } : {}),
    ...(ctx.s3Writable !== true ? { s3_writable_error: ctx.s3WritableError ?? "S3_PROBE_PENDING" } : {}),
    ...base,
    ...(copiesData ? { copies: copiesData } : {}),
    humanHint,
    ...(writerId ? { writer_id: writerId, host_id: writerId } : {}),
    fleet,
    ...(ctx.vaultReadiness ? { vaults: ctx.vaultReadiness } : {}),
  };
}

export async function handleWikiContext(
  ctx: ReadContext,
  extra?: { tools?: string[]; project?: string },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;

  let requested: string | undefined;
  if (extra?.project !== undefined) {
    const project = extra.project.trim();
    if (!project || project.includes("/") || project.includes("\\") || project === "." || project === "..") {
      return { ok: false as const, error: "USAGE", message: "project must be a vault project slug" };
    }
    requested = project;
  }

  const projectsDir = join(ctx.vaultDir, "projects");

  let dirEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    dirEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    // missing projects dir or unreadable
  }

  // Filter project directories and sort alphabetically
  const projectSlugs = dirEntries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  const projects = await Promise.all(
    projectSlugs.map(async (slug) => {
      const workDir = join(projectsDir, slug, "work");
      let workEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
      try {
        workEntries = await readdir(workDir, { withFileTypes: true });
      } catch {
        // no work directory for this project
      }
      const candidateDirs = workEntries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a));

      const activeWork: string[] = [];
      for (const dir of candidateDirs) {
        try {
          const specPath = join(workDir, dir, "spec.md");
          const specContent = await readFile(specPath, "utf8");
          const fm = extractFrontmatter(specContent);
          if (!fm.ok) continue;
          const status = fm.data.status;
          if (status === "planned" || status === "in-progress") {
            activeWork.push(dir);
            if (activeWork.length === 5) break;
          }
        } catch {
          // missing, unreadable, or invalid spec/status fail-closed
        }
      }
      return { slug, active_work: activeWork };
    }),
  );

  if (requested && !projects.some((p) => p.slug === requested)) {
    return { ok: false as const, error: "USAGE", message: `unknown project: ${requested}` };
  }
  const filtered = requested ? projects.filter((p) => p.slug === requested) : projects;

  const instructionsBuffer = Buffer.from(MCP_INSTRUCTIONS, "utf8");

  return {
    ok: true as const,
    projects: filtered,
    writer_id: ctx.hostId ?? "unknown",
    vault_id: ctx.vaultId ?? DEFAULT_VAULT_ID,
    default_vault: ctx.defaultVault ?? ctx.vaultId ?? DEFAULT_VAULT_ID,
    allowed_vaults: [...(ctx.allowedVaults ?? [ctx.defaultVault ?? ctx.vaultId ?? DEFAULT_VAULT_ID])],
    reconcile_ready: ctx.gate.ready,
    tools: extra?.tools ?? [],
    cas_protocol: "Read canonical sha256 via wiki_read_page, pass base_sha256 in write; on FILE_CHANGED re-read and retry.",
    capture_kinds: CAPTURE_KINDS,
    compact_activation: {
      instructions_sha256: sha256Bytes(instructionsBuffer),
      instructions_bytes: instructionsBuffer.byteLength,
    },
  };
}

export async function handleWikiSourcesPending(
  ctx: ReadContext,
  input: { match?: string; scope?: SourceScope; limit?: number },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runSourcesPending({
    vault: ctx.vaultDir,
    match: input.match,
    scope: input.scope,
    limit: input.limit,
    includeIntegrated: false,
  });
  return flattenReadCommandResult(result.result);
}

export async function handleWikiCompileStatus(
  ctx: ReadContext,
  _input?: Record<string, unknown>,
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runSourceCompileStatus({
    vault: ctx.vaultDir,
  });
  return flattenReadCommandResult(result.result);
}

export async function handleWikiReviews(
  ctx: ReadContext,
  _input?: Record<string, unknown>,
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runSourceReviews({
    vault: ctx.vaultDir,
  });
  return flattenReadCommandResult(result.result);
}

export async function handleWikiLintSummary(
  ctx: ReadContext,
  input: Partial<Pick<LintSummaryInput, "only" | "days" | "lines" | "logThreshold" | "examplesLimit">>,
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runLint({
    vault: ctx.vaultDir,
    days: input.days ?? 90,
    lines: input.lines ?? 200,
    logThreshold: input.logThreshold ?? 500,
    fix: false,
    summary: true,
    only: input.only,
    examplesLimit: input.examplesLimit,
  });
  return flattenReadCommandResult(result.result);
}

export async function handleWikiStale(
  ctx: ReadContext,
  input: { days?: number; project?: string },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  let project: string | undefined;
  if (input.project !== undefined) {
    const normalized = normalizeCaptureProject(input.project);
    if (!normalized) {
      return { ok: false as const, error: "USAGE", message: "project must be a vault project slug" };
    }
    if (!vaultHasProject(ctx.vaultDir, normalized)) {
      return { ok: false as const, error: "USAGE", message: "unknown project" };
    }
    project = normalized;
  }
  const result = await runStale({
    vault: ctx.vaultDir,
    days: input.days ?? 90,
    archive: false,
    apply: false,
    project,
  });
  return flattenReadCommandResult(result.result);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface WikiProgressEntry {
  project: string;
  work_item: string;
  title: string;
  status: "planned" | "in-progress";
  priority?: "high" | "medium" | "low";
  date?: string;
  host?: string;
  agent_role?: string;
  agent_id?: string;
  path: string;
}

export interface WikiProgressKeyProject {
  project: string;
  active_count: number;
  highest_priority?: "high" | "medium" | "low";
  newest_date?: string;
  work_items: string[];
}

export interface WikiProgressResult {
  ok: true;
  recent_progress: WikiProgressEntry[];
  key_projects: WikiProgressKeyProject[];
  todos: WikiProgressEntry[];
}

const PRIORITY_ORDER: Record<string, number> = {
  high: 1,
  medium: 2,
  low: 3,
};

export async function handleWikiProgress(
  ctx: ReadContext,
  input: {
    project?: string;
    host?: string;
    agent_role?: string;
    limit?: number;
  },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;

  let limit = 10;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      return { ok: false as const, error: "USAGE", message: "limit must be an integer from 1 to 50" };
    }
    limit = input.limit;
  }

  let filterProject: string | undefined;
  if (input.project !== undefined) {
    const norm = normalizeCaptureProject(input.project);
    if (!norm) {
      return { ok: false as const, error: "USAGE", message: "project must be a vault project slug" };
    }
    if (!vaultHasProject(ctx.vaultDir, norm)) {
      return { ok: false as const, error: "USAGE", message: "unknown project" };
    }
    filterProject = norm;
  }

  let filterHost: string | undefined;
  if (input.host !== undefined) {
    const parsed = identityToken.safeParse(input.host);
    if (!parsed.success) {
      return { ok: false as const, error: "USAGE", message: `invalid host: ${parsed.error.issues[0]?.message}` };
    }
    filterHost = parsed.data;
  }

  let filterAgentRole: string | undefined;
  if (input.agent_role !== undefined) {
    const parsed = identityToken.safeParse(input.agent_role);
    if (!parsed.success) {
      return { ok: false as const, error: "USAGE", message: `invalid agent_role: ${parsed.error.issues[0]?.message}` };
    }
    filterAgentRole = parsed.data;
  }

  const projectsDir = join(ctx.vaultDir, "projects");
  let dirEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    dirEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    // missing projects dir or unreadable
  }

  let candidateProjects = dirEntries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  if (filterProject) {
    candidateProjects = candidateProjects.filter((p) => p === filterProject);
  }

  const activeEntries: WikiProgressEntry[] = [];

  for (const proj of candidateProjects) {
    const workDir = join(projectsDir, proj, "work");
    let workEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      workEntries = await readdir(workDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const workDirs = workEntries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);

    for (const workItem of workDirs) {
      const specPath = join(workDir, workItem, "spec.md");
      let content: string;
      try {
        content = await readFile(specPath, "utf8");
      } catch {
        continue;
      }

      const fm = extractFrontmatter(content);
      if (!fm.ok) continue;

      const data = fm.data;
      const status = data.status;
      if (status !== "planned" && status !== "in-progress") {
        continue;
      }

      const parsedHost = data.host === undefined ? undefined : identityToken.safeParse(data.host);
      const parsedAgentRole = data.agent_role === undefined ? undefined : identityToken.safeParse(data.agent_role);
      const parsedAgentId = data.agent_id === undefined ? undefined : identityToken.safeParse(data.agent_id);
      if (parsedHost && !parsedHost.success) continue;
      if (parsedAgentRole && !parsedAgentRole.success) continue;
      if (parsedAgentId && !parsedAgentId.success) continue;

      const host = parsedHost?.success ? parsedHost.data : undefined;
      const agentRole = parsedAgentRole?.success ? parsedAgentRole.data : undefined;
      const agentId = parsedAgentId?.success ? parsedAgentId.data : undefined;

      if (filterHost !== undefined && host !== filterHost) continue;
      if (filterAgentRole !== undefined && agentRole !== filterAgentRole) continue;

      // Title fallback to work_item
      const rawTitle = typeof data.title === "string" ? data.title.trim() : "";
      const title = rawTitle || workItem;

      // Priority
      let priority: "high" | "medium" | "low" | undefined;
      if (data.priority === "high" || data.priority === "medium" || data.priority === "low") {
        priority = data.priority;
      }

      // Date: updated then created if YYYY-MM-DD
      let date: string | undefined;
      const rawUpdated = typeof data.updated === "string" ? data.updated.trim() : "";
      const rawCreated = typeof data.created === "string" ? data.created.trim() : "";
      if (ISO_DATE_RE.test(rawUpdated)) {
        date = rawUpdated;
      } else if (ISO_DATE_RE.test(rawCreated)) {
        date = rawCreated;
      }

      const relPath = `projects/${proj}/work/${workItem}/spec.md`;

      activeEntries.push({
        project: proj,
        work_item: workItem,
        title,
        status,
        ...(priority !== undefined ? { priority } : {}),
        ...(date !== undefined ? { date } : {}),
        ...(host !== undefined ? { host } : {}),
        ...(agentRole !== undefined ? { agent_role: agentRole } : {}),
        ...(agentId !== undefined ? { agent_id: agentId } : {}),
        path: relPath,
      });
    }
  }

  // Recent sort: date descending then work_item descending
  const recentSorted = [...activeEntries].sort((a, b) => {
    const dateA = a.date ?? "";
    const dateB = b.date ?? "";
    if (dateA !== dateB) {
      return dateB.localeCompare(dateA);
    }
    return b.work_item.localeCompare(a.work_item);
  });

  // Todos sort: priority (high < medium < low < none) then date descending then work_item descending
  const todosSorted = [...activeEntries].sort((a, b) => {
    const rankA = a.priority ? PRIORITY_ORDER[a.priority] : 99;
    const rankB = b.priority ? PRIORITY_ORDER[b.priority] : 99;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    const dateA = a.date ?? "";
    const dateB = b.date ?? "";
    if (dateA !== dateB) {
      return dateB.localeCompare(dateA);
    }
    return b.work_item.localeCompare(a.work_item);
  });

  // Key projects aggregate filtered active entries
  const projectGroups = new Map<string, WikiProgressEntry[]>();
  for (const entry of activeEntries) {
    let group = projectGroups.get(entry.project);
    if (!group) {
      group = [];
      projectGroups.set(entry.project, group);
    }
    group.push(entry);
  }

  const keyProjectsList: WikiProgressKeyProject[] = [];
  for (const [proj, entries] of projectGroups.entries()) {
    // work_items up to 5 recent (sorted date descending then work_item descending)
    const sortedEntries = [...entries].sort((a, b) => {
      const dateA = a.date ?? "";
      const dateB = b.date ?? "";
      if (dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }
      return b.work_item.localeCompare(a.work_item);
    });

    const workItems = sortedEntries.slice(0, 5).map((e) => e.work_item);

    // highest priority
    let highestPriority: "high" | "medium" | "low" | undefined;
    for (const p of ["high", "medium", "low"] as const) {
      if (entries.some((e) => e.priority === p)) {
        highestPriority = p;
        break;
      }
    }

    // newest date
    let newestDate: string | undefined;
    for (const e of sortedEntries) {
      if (e.date) {
        newestDate = e.date;
        break;
      }
    }

    keyProjectsList.push({
      project: proj,
      active_count: entries.length,
      ...(highestPriority !== undefined ? { highest_priority: highestPriority } : {}),
      ...(newestDate !== undefined ? { newest_date: newestDate } : {}),
      work_items: workItems,
    });
  }

  // Sort key projects: active_count desc, newest_date desc, project asc
  keyProjectsList.sort((a, b) => {
    if (b.active_count !== a.active_count) {
      return b.active_count - a.active_count;
    }
    const dateA = a.newest_date ?? "";
    const dateB = b.newest_date ?? "";
    if (dateA !== dateB) {
      return dateB.localeCompare(dateA);
    }
    return a.project.localeCompare(b.project);
  });

  return {
    ok: true as const,
    recent_progress: recentSorted.slice(0, limit),
    key_projects: keyProjectsList.slice(0, limit),
    todos: todosSorted.slice(0, limit),
  };
}
