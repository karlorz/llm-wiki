import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthStore } from "./oauth-store.js";

export interface OAuthWriterMapping {
  client_id?: string;
  writer_id: string;
  allowed_vaults?: string[];
}

export const REVIEW_WRITER_ID = "chatgpt-review";

export interface OAuthConfig {
  enabled: boolean;
  passwordHash?: string;
  reviewPasswordHash?: string;
  issuer?: string;
  stateDir?: string;
  writers?: OAuthWriterMapping[];
  store?: OAuthStore;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = scryptSync(password, salt, 32, { N, r, p }).toString("base64url");
  return `scrypt$${N}$${r}$${p}$${salt}$urlsafe$${hash}`;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  try {
    const parts = encodedHash.split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[5] !== "urlsafe") {
      return false;
    }
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = parts[4];
    const expected = Buffer.from(parts[6], "base64url");
    const computed = scryptSync(password, salt, expected.length, { N, r, p });
    return timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifyPkce(codeVerifier: string, codeChallenge: string, codeChallengeMethod = "S256"): boolean {
  if (codeChallengeMethod !== "S256") return false;
  const computed = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  return computed === codeChallenge;
}

export function resolveWriterVaults(
  writerId: string,
  mappings: OAuthWriterMapping[] | undefined,
): string[] | undefined {
  if (!mappings || mappings.length === 0) return undefined;
  const direct = mappings.find((m) => m.writer_id === writerId && Array.isArray(m.allowed_vaults));
  if (direct) return direct.allowed_vaults;
  return undefined;
}

export function resolveWriterId(clientId: string | undefined, mappings: OAuthWriterMapping[] | undefined): string {
  if (!mappings || mappings.length === 0) {
    return "chatgpt-web";
  }
  if (clientId) {
    const direct = mappings.find((m) => m.client_id === clientId);
    if (direct) return direct.writer_id;
  }
  const wildcard = mappings.find((m) => !m.client_id || m.client_id === "*");
  if (wildcard) return wildcard.writer_id;
  return mappings[0].writer_id;
}

export function isSafeReviewWriterGrant(mappings: OAuthWriterMapping[] | undefined): boolean {
  if (!mappings || mappings.length === 0) return false;
  const review = mappings.find((m) => m.writer_id === REVIEW_WRITER_ID);
  if (!review) return false;
  const vaults = review.allowed_vaults;
  if (!Array.isArray(vaults) || vaults.length === 0) return false;
  return !vaults.includes("central");
}

export function getIssuer(req: IncomingMessage, configuredIssuer?: string): string {
  if (configuredIssuer && configuredIssuer.trim().length > 0) {
    return configuredIssuer.replace(/\/+$/, "");
  }
  const host = req.headers.host ?? "127.0.0.1";
  return `http://${host}`;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

function htmlResponse(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

const AUTHORIZE_HIDDEN_KEYS = [
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "state",
  "scope",
  "resource",
] as const;

export function consentClientLabel(clientName?: string | null): string {
  const trimmed = clientName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "this client";
}

export function isLoopbackRedirectUri(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function denyOperatorPassword(res: ServerResponse, wantsHtml: boolean, params: Record<string, string>, clientName?: string | null, status = 401): void {
  if (wantsHtml) {
    htmlResponse(res, status, authorizeLoginHtml(params, "Invalid operator password", clientName));
    return;
  }
  jsonResponse(res, status, { error: "access_denied", error_description: "Invalid operator password" });
}

function authorizeLoginHtml(params: Record<string, string>, error?: string, clientName?: string | null): string {
  const hiddens = AUTHORIZE_HIDDEN_KEYS.filter((key) => params[key])
    .map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(params[key])}">`)
    .join("\n");
  const err = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  const clientLabel = escapeHtml(consentClientLabel(clientName));
  const loopbackNote = isLoopbackRedirectUri(params.redirect_uri)
    ? `<p>This client uses a loopback callback. Approve only if this browser is on the same machine as the waiting MCP client. Remote SSH sessions should use a host-id bearer instead of this login.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkillWiki operator login</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0 auto;
    max-width: 32rem;
    padding: 2.5rem 1.25rem;
    line-height: 1.5;
    color: #1c1917;
    background: #fafaf9;
  }
  h1 { font-size: 1.5rem; font-weight: 650; margin: 0 0 0.75rem; }
  p { margin: 0.75rem 0; }
  form {
    margin: 1.5rem 0;
    padding: 1.25rem;
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 0.75rem;
  }
  label { display: block; font-weight: 600; }
  input[type="password"] {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.4rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid #d6d3d1;
    border-radius: 0.4rem;
    font: inherit;
  }
  button {
    margin-top: 1rem;
    padding: 0.5rem 1.1rem;
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: #1c1917;
    border: 0;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  p[role="alert"] {
    color: #991b1b;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 0.4rem;
    padding: 0.6rem 0.75rem;
  }
  footer { margin-top: 2rem; font-size: 0.9rem; color: #57534e; }
  footer a { color: inherit; }
</style>
</head>
<body>
<h1>SkillWiki</h1>
<p>Enter the operator password to allow ${clientLabel} to access this vault.</p>
${loopbackNote}
${err}
<form method="post" action="/authorize">
${hiddens}
<p><label>Operator password <input type="password" name="password" required autocomplete="current-password"></label></p>
<p><button type="submit">Allow</button></p>
</form>
<footer><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body>
</html>`;
}

function parseBodyParams(
  method: string | undefined,
  contentType: string,
  rawBody: string,
  searchParams: URLSearchParams,
): Record<string, string> {
  if (method === "GET") {
    const params: Record<string, string> = {};
    for (const [key, value] of searchParams.entries()) {
      params[key] = value;
    }
    return params;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(rawBody).entries()) {
      params[key] = value;
    }
    return params;
  }
  if (contentType.includes("application/json") && rawBody.trim().length > 0) {
    try {
      return JSON.parse(rawBody) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return {};
}

async function issueTokenPair(
  store: OAuthStore,
  clientId: string,
  writerId: string,
  scope?: string,
): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}> {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshTokenValue = randomBytes(32).toString("base64url");
  const expiresIn = 3600;
  await store.saveAccessToken({
    tokenHash: sha256Hex(accessToken),
    clientId,
    writerId,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  });
  await store.saveRefreshToken({
    tokenHash: sha256Hex(refreshTokenValue),
    clientId,
    writerId,
    expiresAt: Date.now() + 30 * 86400 * 1000,
    scope,
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshTokenValue,
    scope,
  };
}

export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  oauthCfg: OAuthConfig,
  store: OAuthStore,
): Promise<boolean> {
  const issuer = getIssuer(req, oauthCfg.issuer);
  const url = new URL(req.url ?? "/", issuer);
  const path = url.pathname;

  // 1. GET /.well-known/oauth-protected-resource (RFC 9728)
  if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
    jsonResponse(res, 200, {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
    return true;
  }

  // 2. GET /.well-known/oauth-authorization-server (RFC 8414)
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    jsonResponse(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      scopes_supported: ["offline_access"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
    return true;
  }

  // 3. POST /register (RFC 7591 Dynamic Client Registration)
  if (req.method === "POST" && path === "/register") {
    let clientName: string | undefined;
    let redirectUris: string[] = [];
    try {
      if (rawBody.trim().length > 0) {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        if (typeof parsed.client_name === "string") clientName = parsed.client_name;
        if (Array.isArray(parsed.redirect_uris)) {
          redirectUris = parsed.redirect_uris.filter((u): u is string => typeof u === "string");
        }
      }
    } catch {
      jsonResponse(res, 400, { error: "invalid_request", error_description: "Malformed JSON" });
      return true;
    }

    const clientId = randomBytes(16).toString("hex");
    await store.saveClient({
      clientId,
      clientName,
      redirectUris,
    });

    jsonResponse(res, 201, {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    });
    return true;
  }

  // 4. GET | POST /authorize
  if ((req.method === "GET" || req.method === "POST") && path === "/authorize") {
    const params = parseBodyParams(req.method, req.headers["content-type"] ?? "", rawBody, url.searchParams);
    const {
      password,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method = "S256",
      response_type,
    } = params;

    if (!client_id || !code_challenge || response_type !== "code") {
      jsonResponse(res, 400, { error: "invalid_request", error_description: "Missing required authorize parameters" });
      return true;
    }

    const wantsHtml =
      req.method === "GET" || (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
    const registeredClient = await store.getClient(client_id);
    const clientName = registeredClient?.clientName;
    if (!password && req.method === "GET") {
      htmlResponse(res, 200, authorizeLoginHtml(params, undefined, clientName));
      return true;
    }

    if (!password) {
      denyOperatorPassword(res, wantsHtml, params, clientName);
      return true;
    }

    const productionOk = Boolean(oauthCfg.passwordHash) && verifyPassword(password, oauthCfg.passwordHash!);
    const reviewOk =
      !productionOk && Boolean(oauthCfg.reviewPasswordHash) && verifyPassword(password, oauthCfg.reviewPasswordHash!);
    if (!productionOk && !reviewOk) {
      denyOperatorPassword(res, wantsHtml, params, clientName);
      return true;
    }

    let writerId: string;
    if (productionOk) {
      writerId = resolveWriterId(client_id, oauthCfg.writers);
    } else {
      if (!isSafeReviewWriterGrant(oauthCfg.writers)) {
        denyOperatorPassword(res, wantsHtml, params, clientName, 403);
        return true;
      }
      writerId = REVIEW_WRITER_ID;
    }

    let redirectUrl: URL | undefined;
    if (redirect_uri) {
      try {
        redirectUrl = new URL(redirect_uri);
      } catch {
        jsonResponse(res, 400, { error: "invalid_request", error_description: "Invalid redirect_uri" });
        return true;
      }
    }
    const code = randomBytes(24).toString("base64url");
    const codeHash = sha256Hex(code);

    await store.saveAuthCode({
      codeHash,
      clientId: client_id,
      redirectUri: redirect_uri ?? "",
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      writerId,
      expiresAt: Date.now() + 5 * 60_000, // 5 minutes
    });

    if (redirectUrl) {
      redirectUrl.searchParams.set("code", code);
      if (params.state) {
        redirectUrl.searchParams.set("state", params.state);
      }
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return true;
    }

    jsonResponse(res, 200, { code, state: params.state });
    return true;
  }

  // 5. POST /token
  if (req.method === "POST" && path === "/token") {
    const params = parseBodyParams(req.method, req.headers["content-type"] ?? "", rawBody, url.searchParams);
    const { grant_type, code, code_verifier, refresh_token } = params;

    if (grant_type === "authorization_code") {
      if (!code || !code_verifier) {
        jsonResponse(res, 400, { error: "invalid_request", error_description: "Missing code or code_verifier" });
        return true;
      }

      const codeHash = sha256Hex(code);
      const authCode = await store.consumeAuthCode(codeHash);
      if (!authCode) {
        jsonResponse(res, 400, { error: "invalid_grant", error_description: "Invalid or expired authorization code" });
        return true;
      }

      if (!verifyPkce(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
        jsonResponse(res, 400, { error: "invalid_grant", error_description: "Code verifier does not match challenge" });
        return true;
      }

      if (authCode.redirectUri !== (params.redirect_uri ?? "")) {
        jsonResponse(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return true;
      }

      jsonResponse(res, 200, await issueTokenPair(store, authCode.clientId, authCode.writerId, "offline_access"));
      return true;
    }

    if (grant_type === "refresh_token") {
      if (!refresh_token) {
        jsonResponse(res, 400, { error: "invalid_request", error_description: "Missing refresh_token" });
        return true;
      }

      const refreshHash = sha256Hex(refresh_token);
      const existing = await store.consumeRefreshToken(refreshHash);
      if (!existing) {
        jsonResponse(res, 400, { error: "invalid_grant", error_description: "Invalid or expired refresh token" });
        return true;
      }

      jsonResponse(res, 200, await issueTokenPair(store, existing.clientId, existing.writerId, existing.scope));
      return true;
    }

    jsonResponse(res, 400, { error: "unsupported_grant_type" });
    return true;
  }

  return false;
}
