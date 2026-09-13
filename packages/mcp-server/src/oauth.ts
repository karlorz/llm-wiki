import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthStore } from "./oauth-store.js";

export interface OAuthWriterMapping {
  client_id?: string;
  writer_id: string;
}

export interface OAuthConfig {
  enabled: boolean;
  passwordHash?: string;
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
    let params: Record<string, string> = {};
    if (req.method === "GET") {
      for (const [key, value] of url.searchParams.entries()) {
        params[key] = value;
      }
    } else {
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const parsed = new URLSearchParams(rawBody);
        for (const [key, value] of parsed.entries()) {
          params[key] = value;
        }
      } else if (contentType.includes("application/json") && rawBody.trim().length > 0) {
        try {
          params = JSON.parse(rawBody) as Record<string, string>;
        } catch {
          // ignore
        }
      }
    }

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

    if (!oauthCfg.passwordHash || !password || !verifyPassword(password, oauthCfg.passwordHash)) {
      jsonResponse(res, 401, { error: "access_denied", error_description: "Invalid operator password" });
      return true;
    }

    const writerId = resolveWriterId(client_id, oauthCfg.writers);
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

    if (redirect_uri) {
      const redirectUrl = new URL(redirect_uri);
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
    let params: Record<string, string> = {};
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const parsed = new URLSearchParams(rawBody);
      for (const [key, value] of parsed.entries()) {
        params[key] = value;
      }
    } else if (contentType.includes("application/json") && rawBody.trim().length > 0) {
      try {
        params = JSON.parse(rawBody) as Record<string, string>;
      } catch {
        // ignore
      }
    }

    const { grant_type, client_id, code, code_verifier, refresh_token } = params;

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

      const accessToken = randomBytes(32).toString("base64url");
      const refreshTokenValue = randomBytes(32).toString("base64url");
      const accessHash = sha256Hex(accessToken);
      const refreshHash = sha256Hex(refreshTokenValue);

      const expiresIn = 3600; // 1 hour
      await store.saveAccessToken({
        tokenHash: accessHash,
        clientId: authCode.clientId,
        writerId: authCode.writerId,
        expiresAt: Date.now() + expiresIn * 1000,
        scope: "offline_access",
      });

      await store.saveRefreshToken({
        tokenHash: refreshHash,
        clientId: authCode.clientId,
        writerId: authCode.writerId,
        expiresAt: Date.now() + 30 * 86400 * 1000, // 30 days
        scope: "offline_access",
      });

      jsonResponse(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: refreshTokenValue,
        scope: "offline_access",
      });
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

      // Rotate refresh token
      const newAccessToken = randomBytes(32).toString("base64url");
      const newRefreshToken = randomBytes(32).toString("base64url");
      const accessHash = sha256Hex(newAccessToken);
      const newRefreshHash = sha256Hex(newRefreshToken);

      const expiresIn = 3600;
      await store.saveAccessToken({
        tokenHash: accessHash,
        clientId: existing.clientId,
        writerId: existing.writerId,
        expiresAt: Date.now() + expiresIn * 1000,
        scope: existing.scope,
      });

      await store.saveRefreshToken({
        tokenHash: newRefreshHash,
        clientId: existing.clientId,
        writerId: existing.writerId,
        expiresAt: Date.now() + 30 * 86400 * 1000,
        scope: existing.scope,
      });

      jsonResponse(res, 200, {
        access_token: newAccessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: newRefreshToken,
        scope: existing.scope,
      });
      return true;
    }

    jsonResponse(res, 400, { error: "unsupported_grant_type" });
    return true;
  }

  return false;
}
