import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { loadClipOutboxConfig, CLIP_NOT_CONFIGURED } from "../utils/clip-outbox-config.js";

export async function runClipOutboxStatus(home: string): Promise<{
  exitCode: number;
  result: Result<{ enabled: boolean; humanHint: string; queue?: Array<{ captureId: string; state: string; reason?: string; attempts?: number }> }>;
}> {
  const resolved = await loadClipOutboxConfig(home);
  if (!resolved.ok) {
    return {
      exitCode: ExitCode.INVALID_CONFIG_VALUE,
      result: err("INVALID_CONFIG_VALUE", { message: resolved.message }),
    };
  }
  if (!resolved.enabled) {
    return {
      exitCode: ExitCode.OK,
      result: ok({ enabled: false, humanHint: CLIP_NOT_CONFIGURED }),
    };
  }
  const { readJournal } = await import("../clip-outbox/journal.js");
  let queue;
  try {
    queue = (await readJournal(resolved.config.stateRoot)).map(({ captureId, state, reason, attempts }) => ({ captureId, state, reason, attempts }));
  } catch {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: "clip journal unreadable; retain it for attended recovery" }) };
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({
      enabled: true,
      queue,
      humanHint: [`clip-outbox enabled root=${resolved.config.root} mode=${resolved.config.mode}`, ...queue.map((e) => `${e.captureId}: ${e.state}${e.reason ? ` (${e.reason})` : ""}; attempts=${e.attempts ?? 0}`)].join("\n"),
    }),
  };
}

export async function runClipOutboxInstall(input: { home: string; load?: boolean; loadMirror?: boolean; conditionalCreateProven?: boolean }) {
  try {
    const { migrateClipOutbox } = await import("../clip-outbox/migrate.js");
    return { exitCode: ExitCode.OK, result: ok(await migrateClipOutbox(input)) };
  } catch (e) {
    // Deliberately omit SDK/network errors and provider values from CLI output.
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: e instanceof Error ? e.message : "clip migration failed" }) };
  }
}

export async function runClipOutboxWatch(home: string) {
  const resolved = await loadClipOutboxConfig(home);
  if (!resolved.ok || !resolved.enabled) return { exitCode: ExitCode.INVALID_CONFIG_VALUE, result: err("INVALID_CONFIG_VALUE", { message: resolved.ok ? CLIP_NOT_CONFIGURED : resolved.message }) };
  if (process.platform !== "darwin") return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: "clip-outbox watch requires macOS FSEvents" }) };
  let client: import("@aws-sdk/client-s3").S3Client | undefined;
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const { loadClipCredentials, validateRuntime } = await import("../clip-outbox/runtime.js");
    const { createS3CreateOnlyPut, parseDestination } = await import("../clip-outbox/upload.js");
    const { postReadyHint } = await import("../clip-outbox/ready.js");
    const { startClipWorker } = await import("../clip-outbox/watcher.js");
    const cfg = resolved.config;
    const credentials = await loadClipCredentials(home, cfg);
    await validateRuntime(home, cfg, credentials.s3.endpoint);
    const destination = parseDestination(cfg.destination);
    client = new S3Client({ endpoint: credentials.s3.endpoint, region: credentials.s3.region, credentials: credentials.s3, forcePathStyle: true, maxAttempts: 1 });
    let finish!: () => void;
    const done = new Promise<void>((r) => { finish = r; });
    let failed = false;
    const worker = await startClipWorker(cfg, {
      put: createS3CreateOnlyPut({ client, bucket: destination.bucket, prefix: destination.prefix }),
      ready: (hint) => postReadyHint({ url: cfg.readyUrl, token: credentials.readyToken, hint }),
      validate: () => validateRuntime(home, cfg, credentials.s3.endpoint),
      onError: () => { failed = true; finish(); },
    });
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
    try { await done; } finally {
      process.removeListener("SIGTERM", finish);
      process.removeListener("SIGINT", finish);
      await worker.stop();
    }
    return failed
      ? { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: "clip worker stopped; inspect configuration and retained journal" }) }
      : { exitCode: ExitCode.OK, result: ok({ humanHint: "Clip worker stopped; snapshots and journal retained." }) };
  } catch {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: "clip worker startup failed; check configuration, protected credential references, conditional-create evidence and worker lock" }) };
  } finally { client?.destroy(); }
}

export async function runClipOutboxMirrorWatch(home: string) {
  const resolved = await loadClipOutboxConfig(home);
  if (!resolved.ok || !resolved.enabled) return { exitCode: ExitCode.INVALID_CONFIG_VALUE, result: err("INVALID_CONFIG_VALUE", { message: resolved.ok ? CLIP_NOT_CONFIGURED : resolved.message }) };
  let client: import("@aws-sdk/client-s3").S3Client | undefined;
  const abort = new AbortController();
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const { loadClipCredentials, validateRuntime } = await import("../clip-outbox/runtime.js");
    const { createS3GetObject, eventsUrlFromMcp, parseDestinationForMirror, startMirrorListener } = await import("../clip-outbox/mirror.js");
    const { resolveMcpAuthEnv } = await import("../utils/mcp-auth-env.js");
    const cfg = resolved.config;
    const credentials = await loadClipCredentials(home, cfg);
    await validateRuntime(home, cfg, credentials.s3.endpoint);
    const auth = await resolveMcpAuthEnv({ home });
    if (!auth.url || !auth.token) throw new Error("MCP bearer required for inbound SSE");
    const destination = parseDestinationForMirror(cfg.destination);
    client = new S3Client({ endpoint: credentials.s3.endpoint, region: credentials.s3.region, credentials: credentials.s3, forcePathStyle: true, maxAttempts: 1 });
    const done = new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    process.once("SIGTERM", () => abort.abort());
    process.once("SIGINT", () => abort.abort());
    await Promise.race([
      startMirrorListener({
        home,
        config: cfg,
        eventsUrl: eventsUrlFromMcp(auth.url),
        mcpToken: auth.token,
        getObject: createS3GetObject({ client, bucket: destination.bucket, prefix: destination.prefix, maxBytes: cfg.maxBundleBytes }),
        signal: abort.signal,
      }),
      done,
    ]);
    return { exitCode: ExitCode.OK, result: ok({ humanHint: "Inbound SSE listener stopped." }) };
  } catch {
    return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err("PREFLIGHT_FAILED", { message: "inbound SSE listener startup failed; check MCP bearer, clip credentials, frozen mirror and wiki-push isolation" }) };
  } finally {
    abort.abort();
    client?.destroy();
  }
}
