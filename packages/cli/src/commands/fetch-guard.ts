import { ok, err, ExitCode, isBlockedHost, type Result } from "@skillwiki/shared";

const REDACT_PARAMS = new Set(["api_key", "token", "key", "auth", "password", "secret", "access_token"]);
const PATH_TOKEN_RE = /[A-Fa-f0-9]{32,}|[A-Za-z0-9_\-]{40,}/g;

export interface FetchGuardInput { url: string }
export interface FetchGuardOutput { allowed: boolean; reason?: string; sanitized_url: string; humanHint: string }

export interface GuardRun { exitCode: number; result: Result<FetchGuardOutput> }

export function runFetchGuard(input: FetchGuardInput): Promise<GuardRun> {
  return Promise.resolve(runFetchGuardSync(input));
}

export function runFetchGuardSync(input: FetchGuardInput): GuardRun {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    return { exitCode: ExitCode.MALFORMED_URL, result: err("MALFORMED_URL", { url: input.url }) };
  }

  const sanitized = sanitizeUrl(u);

  if (u.protocol !== "https:") {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { sanitized_url: sanitized, scheme: u.protocol })
    };
  }

  if (isBlockedHost(u.hostname)) {
    return {
      exitCode: ExitCode.HOST_BLOCKED,
      result: err("HOST_BLOCKED", { sanitized_url: sanitized, host: u.hostname })
    };
  }

  return { exitCode: ExitCode.OK, result: ok({ allowed: true, sanitized_url: sanitized, humanHint: `ALLOWED: ${sanitized}` }) };
}

export function sanitizeUrl(u: URL): string {
  const clone = new URL(u.toString());
  if (clone.username || clone.password) {
    clone.username = "";
    clone.password = "";
  }
  for (const k of Array.from(clone.searchParams.keys())) {
    if (REDACT_PARAMS.has(k.toLowerCase())) clone.searchParams.set(k, "REDACTED");
  }
  let s = clone.toString();
  s = s.replace(PATH_TOKEN_RE, "REDACTED");
  return s;
}
