import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runFleetContext } from "../../../cli/src/commands/fleet.js";
import { runMemoryRecall } from "../../../cli/src/commands/memory.js";
import { runQuery } from "../../../cli/src/commands/query.js";
import { runStatus } from "../../../cli/src/commands/status.js";
import { runCopyStatusCommand } from "../../../cli/src/commands/copy-status.js";
import { extractFrontmatter } from "../../../cli/src/parsers/frontmatter.js";
import { resolveWithinVault } from "../allowlist.js";
import { MCP_INSTRUCTIONS } from "../mcp-instructions.js";
import { ReconcileGate } from "../reconcile.js";
import { sha256Bytes } from "../txn.js";
import { currentVersion, type GetObject } from "../versions.js";
import { CAPTURE_KINDS, normalizeCaptureProject, vaultHasProject } from "./writes.js";

export const MAX_READ_PAGE_BYTES = 256 * 1024;

export interface ReadContext {
  vaultDir: string;
  hostId?: string;
  gate: ReconcileGate;
  getObject?: GetObject;
  s3Ok?: boolean;
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
  ctx: ReadContext & { s3Ok?: boolean },
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
    }),
  ]);
  const base = result.result.ok ? result.result.data : { humanHint: "status failed" };
  const copiesData = copies.result.ok ? copies.result.data : undefined;
  const humanHint = [base.humanHint, copiesData?.humanHint].filter(Boolean).join("\n\n");
  return {
    ok: true as const,
    vault_path: ctx.vaultDir,
    reconcile_ready: ctx.gate.ready,
    s3_ok: ctx.s3Ok ?? true,
    ...base,
    ...(copiesData ? { copies: copiesData } : {}),
    humanHint,
    ...(writerId ? { writer_id: writerId, host_id: writerId } : {}),
    fleet,
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
