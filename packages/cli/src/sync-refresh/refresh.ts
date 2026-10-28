import { admitWikiMirrorPath, ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { readCliPackageJson } from "../utils/package-info.js";
import { resolveMcpAuthEnv } from "../utils/mcp-auth-env.js";
import { withMcpClient } from "../utils/mcp-client.js";
import { acquireWikiFetchPullLock } from "../utils/wiki-fetch-lock.js";
import { githubPlaneState } from "./github-state.js";
import { loadMirrorHashState, priorMirrorHash, saveMirrorHashState } from "./hash-state.js";
import { assertFrozenMirror, materializeAdmittedPage, sha256Buffer } from "./materialize.js";

export type CentralPlaneState = "verified" | "unverified" | "missing" | "denied" | "hash_mismatch" | "too_large" | "error";
export type LocalPlaneState = "delivered" | "idempotent" | "conflict" | "denied" | "skipped" | "lock_contended" | "absent";

export interface RefreshPathReport {
  path: string;
  family?: "maintained" | "raw";
  central: { state: CentralPlaneState; sha256?: string; s3_verified?: boolean; vault_id?: string; error?: string };
  local: { state: LocalPlaneState; sha256?: string; reason?: string };
  github: { state: ReturnType<typeof githubPlaneState>; observation: "cached_origin_ref"; live_backup_confirmed: false };
  snapshot_request?: { ok: boolean; state: string; request_id?: string; error?: string };
}

export interface RefreshOutput {
  vault: string;
  vault_id: string;
  pages: RefreshPathReport[];
  snapshot_request?: { ok: boolean; state: string; request_id?: string; error?: string };
  humanHint: string;
}

export interface ReadPageFn {
  (path: string): Promise<{
    ok: boolean;
    path?: string;
    markdown?: string;
    sha256?: string;
    s3_verified?: boolean;
    vault_id?: string;
    error?: string;
    message?: string;
  }>;
}

export function structuredFromTool(value: unknown): Record<string, unknown> {
  const result = value as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  if (!result || typeof result !== "object") return {};
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

export async function defaultReadPage(input: {
  url: string;
  token: string;
  vaultId?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<ReadPageFn> {
  const version = readCliPackageJson().version;
  return async (path: string) => {
    return withMcpClient(
      { url: input.url, token: input.token, clientName: "skillwiki-sync-refresh", version, fetchFn: input.fetchFn, timeoutMs: input.timeoutMs ?? 30_000 },
      async (client, signal) => {
        const result = await client.callTool({ name: "wiki_read_page", arguments: { path, vault: input.vaultId ?? "central" } }, undefined, { signal });
        const sc = structuredFromTool(result);
        return {
          ok: sc.ok === true,
          path: typeof sc.path === "string" ? sc.path : undefined,
          markdown: typeof sc.markdown === "string" ? sc.markdown : undefined,
          sha256: typeof sc.sha256 === "string" ? sc.sha256 : undefined,
          s3_verified: sc.s3_verified === true,
          vault_id: typeof sc.vault_id === "string" ? sc.vault_id : undefined,
          error: typeof sc.error === "string" ? sc.error : undefined,
          message: typeof sc.message === "string" ? sc.message : undefined,
        };
      },
    );
  };
}

export async function requestSnapshotViaMcp(input: {
  url: string;
  token: string;
  vaultId?: string;
  fetchFn?: typeof fetch;
}): Promise<{ ok: boolean; state: string; request_id?: string; error?: string }> {
  const version = readCliPackageJson().version;
  try {
    return await withMcpClient(
      { url: input.url, token: input.token, clientName: "skillwiki-sync-snapshot-request", version, fetchFn: input.fetchFn, timeoutMs: 15_000 },
      async (client, signal) => {
        const result = await client.callTool({ name: "wiki_snapshot_request", arguments: { vault: input.vaultId ?? "central" } }, undefined, { signal });
        const sc = structuredFromTool(result);
        return {
          ok: sc.ok === true && (!sc.vault_id || sc.vault_id === (input.vaultId ?? "central")) && sc.state === "queued",
          state: typeof sc.state === "string" ? sc.state : sc.ok === true ? "queued" : "failed",
          request_id: typeof sc.request_id === "string" ? sc.request_id : undefined,
          error: typeof sc.error === "string" ? sc.error : undefined,
        };
      },
    );
  } catch (error) {
    return { ok: false, state: "failed", error: error instanceof Error ? error.message : "SNAPSHOT_REQUEST_FAILED" };
  }
}

export async function snapshotStatusViaMcp(input: {
  url: string;
  token: string;
  vaultId?: string;
  requestId?: string;
  fetchFn?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const version = readCliPackageJson().version;
  return withMcpClient(
    { url: input.url, token: input.token, clientName: "skillwiki-sync-snapshot-status", version, fetchFn: input.fetchFn, timeoutMs: 15_000 },
    async (client, signal) => {
      const args: Record<string, unknown> = { vault: input.vaultId ?? "central" };
      if (input.requestId) args.request_id = input.requestId;
      const result = await client.callTool({ name: "wiki_snapshot_status", arguments: args }, undefined, { signal });
      const sc = structuredFromTool(result);
      if (sc.vault_id && sc.vault_id !== (input.vaultId ?? "central")) return { ok: false, state: "failed", error: "WRONG_VAULT" };
      return sc;
    },
  );
}

export async function refreshAdmittedPages(input: {
  vault: string;
  home: string;
  paths: readonly string[];
  expectedVaultId?: string;
  readPage: ReadPageFn;
  lock?: () => Promise<(() => Promise<void>) | null>;
}): Promise<RefreshPathReport[]> {
  const expectedVaultId = input.expectedVaultId ?? "central";
  const reports: RefreshPathReport[] = [];
  const lock = input.lock ?? (() => acquireWikiFetchPullLock(input.home));
  try { assertFrozenMirror(input.vault); } catch (error) {
    return input.paths.map(path => ({ path, central: { state: "error" as const, error: "MIRROR_PREFLIGHT_FAILED" }, local: { state: "denied" as const, reason: String(error) }, github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" as const } }));
  }
  for (const rawPath of input.paths) {
    const admitted = admitWikiMirrorPath(rawPath);
    if (!admitted.ok) {
      reports.push({
        path: rawPath,
        central: { state: "denied", error: admitted.reason },
        local: { state: "denied", reason: admitted.reason },
        github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" },
      });
      continue;
    }
    let page: Awaited<ReturnType<ReadPageFn>>;
    try {
      page = await input.readPage(admitted.path);
    } catch (error) {
      reports.push({
        path: admitted.path,
        family: admitted.family,
        central: { state: "error", error: error instanceof Error ? error.message : "READ_FAILED" },
        local: { state: "skipped", reason: "central_read_failed" },
        github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" },
      });
      continue;
    }
    if (!page.ok) {
      const centralState: CentralPlaneState =
        page.error === "FILE_NOT_FOUND" ? "missing" : page.error === "PATH_DENIED" ? "denied" : page.error === "PAGE_TOO_LARGE" ? "too_large" : "error";
      reports.push({
        path: admitted.path,
        family: admitted.family,
        central: { state: centralState, error: page.error ?? page.message, sha256: page.sha256, s3_verified: page.s3_verified },
        local: { state: "skipped", reason: page.error ?? "central_not_ok" },
        github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" },
      });
      continue;
    }
    if (page.path !== admitted.path) {
      reports.push({ path: admitted.path, central: { state: "denied", error: "PATH_MISMATCH" }, local: { state: "denied", reason: "PATH_MISMATCH" }, github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" } });
      continue;
    }
    if (page.vault_id && page.vault_id !== expectedVaultId) {
      reports.push({
        path: admitted.path,
        family: admitted.family,
        central: { state: "denied", vault_id: page.vault_id, error: "WRONG_VAULT" },
        local: { state: "denied", reason: "WRONG_VAULT" },
        github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" },
      });
      continue;
    }
    if (page.s3_verified !== true || typeof page.markdown !== "string" || typeof page.sha256 !== "string") {
      reports.push({
        path: admitted.path,
        family: admitted.family,
        central: { state: "unverified", sha256: page.sha256, s3_verified: page.s3_verified === true, vault_id: page.vault_id },
        local: { state: "skipped", reason: "s3_unverified" },
        github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" },
      });
      continue;
    }
    const body = Buffer.from(page.markdown, "utf8");
    const computed = sha256Buffer(body);
    if (computed !== page.sha256.toLowerCase()) {
      reports.push({
        path: admitted.path,
        family: admitted.family,
        central: { state: "hash_mismatch", sha256: page.sha256, s3_verified: true, vault_id: page.vault_id },
        local: { state: "skipped", reason: "HASH_MISMATCH" },
        github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: githubPlaneState(input.vault, admitted.path, page.sha256) },
      });
      continue;
    }
    // Remote latency never occupies the shared local commit mutex.
    const report: RefreshPathReport = {
      path: admitted.path, family: admitted.family,
      central: { state: "verified", sha256: computed, s3_verified: true, vault_id: page.vault_id ?? expectedVaultId },
      local: { state: "skipped" },
      github: { observation: "cached_origin_ref", live_backup_confirmed: false, state: "unknown" },
    };
    let release: (() => Promise<void>) | null;
    try { release = await lock(); }
    catch (error) {
      report.local.reason = error instanceof Error ? error.message : "LOCK_FAILED";
      reports.push(report);
      continue;
    }
    if (!release) {
      report.local = { state: "lock_contended", reason: "wiki-fetch pull lock held" };
      reports.push(report);
      continue;
    }
    try {
      const state = await loadMirrorHashState(input.home, input.vault, expectedVaultId);
      const materialized = await materializeAdmittedPage({
        vault: input.vault, rel: admitted.path, body,
        priorHash: priorMirrorHash(state, admitted.path, expectedVaultId),
      });
      if (["created", "replaced", "idempotent"].includes(materialized.decision) && state.hashes[admitted.path] !== computed) {
        state.hashes[admitted.path] = computed;
        try { await saveMirrorHashState(input.home, state); }
        catch { materialized.reason = "STATE_PERSIST_FAILED"; }
      }
      const localState: LocalPlaneState =
        materialized.decision === "created" || materialized.decision === "replaced"
          ? "delivered"
          : materialized.decision === "idempotent"
            ? "idempotent"
            : materialized.decision === "conflict"
              ? "conflict"
              : "denied";
      report.local = { state: localState, sha256: materialized.localSha256, reason: materialized.reason };
    } catch (error) {
      report.local = { state: "denied", reason: error instanceof Error ? error.message : "COMMIT_FAILED" };
    } finally {
      try { await release(); }
      catch { report.local.reason = "LOCK_RELEASE_FAILED"; }
    }
    report.github.state = githubPlaneState(input.vault, admitted.path, computed);
    reports.push(report);
  }
  return reports;
}

function hintFor(pages: RefreshPathReport[], snapshot?: RefreshOutput["snapshot_request"]): string {
  const lines = pages.map((page) => {
    return `${page.path}: central=${page.central.state} local=${page.local.state} github_cached_origin=${page.github.state}`;
  });
  if (snapshot) {
    lines.push(`snapshot_request: ${snapshot.state}${snapshot.ok ? "" : ` (${snapshot.error ?? "failed"})`}`);
    lines.push("GitHub promotion is independent of snapshot-request queue acceptance.");
  }
  return lines.join("\n");
}

export async function runSyncRefresh(input: {
  vault: string;
  home: string;
  paths: readonly string[];
  requestSnapshot?: boolean;
  expectedVaultId?: string;
  readPage?: ReadPageFn;
  fetchFn?: typeof fetch;
}): Promise<{ exitCode: number; result: Result<RefreshOutput> }> {
  if (input.paths.length < 1) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "sync refresh requires one or more vault-relative paths" }) };
  }
  const auth = await resolveMcpAuthEnv({ home: input.home });
  if (!auth.url || !auth.token) {
    return {
      exitCode: ExitCode.INVALID_CONFIG_VALUE,
      result: err("INVALID_CONFIG_VALUE", { message: "SKILLWIKI_MCP_URL and SKILLWIKI_MCP_TOKEN are required; clip-outbox credentials are not used" }),
    };
  }
  const readPage = input.readPage ?? (await defaultReadPage({ url: auth.url, token: auth.token, fetchFn: input.fetchFn, vaultId: input.expectedVaultId ?? "central" }));
  const pages = await refreshAdmittedPages({
    vault: input.vault,
    home: input.home,
    paths: input.paths,
    expectedVaultId: input.expectedVaultId ?? "central",
    readPage,
  });
  let snapshot: RefreshOutput["snapshot_request"];
  if (input.requestSnapshot) {
    snapshot = await requestSnapshotViaMcp({ url: auth.url, token: auth.token, fetchFn: input.fetchFn, vaultId: input.expectedVaultId ?? "central" });
  }
  const output: RefreshOutput = {
    vault: input.vault,
    vault_id: input.expectedVaultId ?? "central",
    pages,
    ...(snapshot ? { snapshot_request: snapshot } : {}),
    humanHint: hintFor(pages, snapshot),
  };
  const failed = pages.some(page => page.central.state !== "verified" || ["STATE_PERSIST_FAILED", "LOCK_RELEASE_FAILED"].includes(page.local.reason ?? "") || !["delivered", "idempotent"].includes(page.local.state)) || (snapshot !== undefined && !snapshot.ok);
  return { exitCode: failed ? ExitCode.PREFLIGHT_FAILED : ExitCode.OK, result: ok(output) };
}
