import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearerToken, resolveWriter, unauthorizedHeaders } from "../src/auth.js";
import { hashPassword } from "../src/oauth.js";
import { FileOAuthStore, InMemoryOAuthStore } from "../src/oauth-store.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

describe("OAuth Writer Resolution (auth.ts)", () => {
  it("resolves host-id first when token is in tokenMap", async () => {
    const token = "host-secret-token";
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const tokenMap = new Map([[hash, "host-machine-1"]]);
    const store = new InMemoryOAuthStore();
    // Even if store has something, host-id takes priority
    const res = await resolveWriter(`Bearer ${token}`, { tokenMap, oauthStore: store });
    expect(res).toEqual({ writerId: "host-machine-1" });
  });

  it("resolves writer from OAuth store when token not in tokenMap", async () => {
    const tokenMap = new Map<string, string>();
    const store = new InMemoryOAuthStore();
    const token = "oauth-access-token-123";
    await store.saveAccessToken({
      tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
      clientId: "client-chatgpt",
      writerId: "chatgpt-web",
      expiresAt: Date.now() + 3600_000,
      scope: "offline_access",
    });

    const res = await resolveWriter(`Bearer ${token}`, { tokenMap, oauthStore: store });
    expect(res).toEqual({ writerId: "chatgpt-web" });
  });

  it("returns null if token is unknown or expired", async () => {
    const tokenMap = new Map<string, string>();
    const store = new InMemoryOAuthStore();
    const expiredToken = "expired-token";
    await store.saveAccessToken({
      tokenHash: createHash("sha256").update(expiredToken, "utf8").digest("hex"),
      clientId: "client-chatgpt",
      writerId: "chatgpt-web",
      expiresAt: Date.now() - 1000, // expired
      scope: "offline_access",
    });

    const res1 = await resolveWriter(`Bearer ${expiredToken}`, { tokenMap, oauthStore: store });
    expect(res1).toBeNull();

    const res2 = await resolveWriter(`Bearer nonexistent`, { tokenMap, oauthStore: store });
    expect(res2).toBeNull();
  });
});

describe("OAuth Token Store (oauth-store.ts)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oauth-store-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists clients, auth codes, access tokens, and refresh tokens to file with mode 0600", async () => {
    const store = new FileOAuthStore(tmpDir);
    await store.saveClient({ clientId: "c1", redirectUris: ["http://localhost/cb"] });
    expect(await store.getClient("c1")).toEqual({ clientId: "c1", redirectUris: ["http://localhost/cb"] });

    // Save auth code (hashed)
    const codeHash = createHash("sha256").update("code-secret", "utf8").digest("hex");
    await store.saveAuthCode({
      codeHash,
      clientId: "c1",
      redirectUri: "http://localhost/cb",
      codeChallenge: "challenge-123",
      codeChallengeMethod: "S256",
      writerId: "writer-test",
      expiresAt: Date.now() + 60_000,
    });
    const codeEntry = await store.consumeAuthCode(codeHash);
    expect(codeEntry?.clientId).toBe("c1");
    // Consuming second time returns null (single use)
    expect(await store.consumeAuthCode(codeHash)).toBeNull();

    // Refresh token rotation
    const refreshHash1 = createHash("sha256").update("refresh-1", "utf8").digest("hex");
    await store.saveRefreshToken({
      tokenHash: refreshHash1,
      clientId: "c1",
      writerId: "writer-test",
      expiresAt: Date.now() + 86400_000,
      scope: "offline_access",
    });
    const consumed = await store.consumeRefreshToken(refreshHash1);
    expect(consumed?.writerId).toBe("writer-test");
    // Replay returns null
    expect(await store.consumeRefreshToken(refreshHash1)).toBeNull();
  });
});

describe("OAuth HTTP Server Integration (oauth.ts + server.ts)", () => {
  let vaultDir: string;
  let auditFile: string;
  let tmpDir: string;

  beforeEach(async () => {
    vaultDir = await makeTempVault();
    tmpDir = await mkdtemp(join(tmpdir(), "oauth-server-test-"));
    auditFile = join(tmpDir, "audit.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("when OAuth is disabled, 401 returns WWW-Authenticate: Bearer without realm or resource_metadata", async () => {
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir,
      tokenMap: new Map(),
      gate,
      putObject: async () => undefined,
      oauth: { enabled: false },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");

      // OAuth routes should 404
      const resMeta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
      expect(resMeta.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("when OAuth is enabled, 401 on /mcp includes resource_metadata and realm in WWW-Authenticate", async () => {
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir,
      tokenMap: new Map(),
      gate,
      putObject: async () => undefined,
      oauth: {
        enabled: true,
        passwordHash: hashPassword("operator-secret"),
        writers: [{ client_id: "*", writer_id: "chatgpt-web" }],
        store: new InMemoryOAuthStore(),
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
      const authHeader = res.headers.get("www-authenticate");
      expect(authHeader).toContain("Bearer");
      expect(authHeader).toContain('resource_metadata="http://127.0.0.1:' + port + '/.well-known/oauth-protected-resource"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("full OAuth flow: metadata, DCR, authorize with password + PKCE, token exchange, tools/call, and audit", async () => {
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const store = new InMemoryOAuthStore();
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir,
      tokenMap: new Map(),
      gate,
      putObject: async () => undefined,
      auditFile,
      oauth: {
        enabled: true,
        passwordHash: hashPassword("mypassword"),
        writers: [{ client_id: "*", writer_id: "chatgpt-web" }],
        store,
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. GET /.well-known/oauth-protected-resource
      const prmRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
      expect(prmRes.status).toBe(200);
      const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[]; bearer_methods_supported: string[] };
      expect(prm.resource).toBe(`${baseUrl}/mcp`);
      expect(prm.authorization_servers).toEqual([baseUrl]);
      expect(prm.bearer_methods_supported).toEqual(["header"]);

      // 2. GET /.well-known/oauth-authorization-server
      const asRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
      expect(asRes.status).toBe(200);
      const asMeta = (await asRes.json()) as Record<string, unknown>;
      expect(asMeta.issuer).toBe(baseUrl);
      expect(asMeta.authorization_endpoint).toBe(`${baseUrl}/authorize`);
      expect(asMeta.token_endpoint).toBe(`${baseUrl}/token`);
      expect(asMeta.registration_endpoint).toBe(`${baseUrl}/register`);
      expect(asMeta.code_challenge_methods_supported).toEqual(["S256"]);
      expect(asMeta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
      expect(asMeta.response_types_supported).toEqual(["code"]);
      expect(asMeta.scopes_supported).toEqual(["offline_access"]);

      // 3. Dynamic client registration POST /register
      const regRes = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: ["https://chatgpt.com/api/aip/g-123/oauth/callback"],
        }),
      });
      expect(regRes.status).toBe(201);
      const regBody = (await regRes.json()) as { client_id: string };
      expect(regBody.client_id).toBeDefined();
      const clientId = regBody.client_id;

      // 4. PKCE setup
      const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_long_verifier_string_at_least_43_chars";
      const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");

      // 5. Authorize with wrong password -> 401
      const failAuthRes = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          password: "wrong",
          client_id: clientId,
          redirect_uri: "https://chatgpt.com/api/aip/g-123/oauth/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          response_type: "code",
          scope: "offline_access",
        }).toString(),
        redirect: "manual",
      });
      expect([401, 403]).toContain(failAuthRes.status);

      // 6. Authorize with correct password -> 302 or JSON code
      const authRes = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          password: "mypassword",
          client_id: clientId,
          redirect_uri: "https://chatgpt.com/api/aip/g-123/oauth/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          response_type: "code",
          scope: "offline_access",
        }).toString(),
        redirect: "manual",
      });
      let code: string | null = null;
      if (authRes.status === 302) {
        const loc = authRes.headers.get("location");
        expect(loc).toBeDefined();
        const locUrl = new URL(loc!);
        code = locUrl.searchParams.get("code");
      } else if (authRes.status === 200) {
        const jsonBody = (await authRes.json()) as { code: string };
        code = jsonBody.code;
      }
      expect(code).toBeTruthy();

      // 7. Token exchange with wrong code_verifier -> fails 400
      const failTokenRes = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code!,
          redirect_uri: "https://chatgpt.com/api/aip/g-123/oauth/callback",
          code_verifier: "wrong_verifier_123456789012345678901234567890",
        }).toString(),
      });
      expect(failTokenRes.status).toBe(400);

      // 8. Re-authorize to get fresh code (since first code was consumed or failed)
      const authRes2 = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          password: "mypassword",
          client_id: clientId,
          redirect_uri: "https://chatgpt.com/api/aip/g-123/oauth/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          response_type: "code",
          scope: "offline_access",
        }).toString(),
        redirect: "manual",
      });
      const loc2 = authRes2.headers.get("location");
      const code2 = loc2 ? new URL(loc2).searchParams.get("code") : ((await authRes2.json()) as { code: string }).code;

      // 9. Token exchange with correct code_verifier -> success
      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code2!,
          redirect_uri: "https://chatgpt.com/api/aip/g-123/oauth/callback",
          code_verifier: codeVerifier,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token?: string;
        scope?: string;
      };
      expect(tokenBody.access_token).toBeDefined();
      expect(tokenBody.token_type.toLowerCase()).toBe("bearer");
      expect(tokenBody.refresh_token).toBeDefined();

      const accessToken = tokenBody.access_token;
      const refreshToken = tokenBody.refresh_token!;

      // 10. Call /mcp initialize with Bearer accessToken
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "vitest", version: "0" },
          },
        }),
      });
      expect(initRes.status).toBe(200);

      // 11. Call wiki_context -> writer_id is chatgpt-web
      const ctxRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "wiki_context",
            arguments: {},
          },
        }),
      });
      expect(ctxRes.status).toBe(200);
      const ctxData = (await ctxRes.json()) as { result?: { structuredContent?: { writer_id?: string } } };
      expect(ctxData.result?.structuredContent?.writer_id).toBe("chatgpt-web");

      // 12. Call wiki_capture -> audits as chatgpt-web in host_id
      const captureRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "wiki_capture",
            arguments: {
              kind: "note",
              project: "llm-wiki",
              title: "Test OAuth Note",
              content: "Testing oauth writer audit\n",
            },
          },
        }),
      });
      expect(captureRes.status).toBe(200);

      const auditContent = await readFile(auditFile, "utf8");
      const lines = auditContent.trim().split("\n").map((l) => JSON.parse(l) as { host_id: string; tool: string });
      const captureAudit = lines.find((l) => l.tool === "wiki_capture");
      expect(captureAudit).toBeDefined();
      expect(captureAudit?.host_id).toBe("chatgpt-web");

      // 13. Refresh token rotation: POST /token grant_type=refresh_token
      const refreshRes = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }).toString(),
      });
      expect(refreshRes.status).toBe(200);
      const refreshBody = (await refreshRes.json()) as {
        access_token: string;
        refresh_token: string;
      };
      expect(refreshBody.access_token).toBeDefined();
      expect(refreshBody.refresh_token).toBeDefined();
      expect(refreshBody.refresh_token).not.toBe(refreshToken);

      // 14. Replay of old refresh token fails
      const replayRes = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }).toString(),
      });
      expect(replayRes.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
