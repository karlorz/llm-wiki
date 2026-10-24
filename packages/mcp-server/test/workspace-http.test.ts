import { authorizeWorkspaceClient, callWorkspaceTool, refreshWorkspaceClient } from "../src/workspace-client.js";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpHttpServer } from "../src/server.js";
import { WorkspaceStore, workspaceSecret } from "../src/workspace-store.js";
import { WorkspaceWeb } from "../src/workspace-web.js";
import { WorkspaceGitHub } from "../src/workspace-github.js";
import { WorkspaceProvisioner, LocalWorkspaceStorage } from "../src/workspace-storage.js";
import { InMemoryOAuthStore } from "../src/oauth-store.js";
import { ReconcileGate } from "../src/reconcile.js";
import { buildVaultRegistry } from "../src/vault-registry.js";
const issuer = "https://wiki.example.test";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "workspace-http-")), legacy = join(root, "legacy"); await mkdir(legacy);
  await writeFile(join(legacy, "SCHEMA.md"), "LEGACY PRIVATE CONTENT");
  const registry = buildVaultRegistry([{ vaultId: "central", isDefault: true, localRoot: legacy, rcloneRemote: "local", rclonePath: "legacy" }]);
  const store = new WorkspaceStore(join(root, "control"));
  const storage = new LocalWorkspaceStorage(join(root, "native")); const provisioner = new WorkspaceProvisioner(store, storage, registry);
  const ownerCookie = store.login({ id: "11", login: "alice" }); store.allowCreation("11", true);
  const strangerCookie = store.login({ id: "22", login: "bob" }); store.allowCreation("22", true);
  const w = store.create("11", "Alpha", "alpha", workspaceSecret()); await provisioner.run("11", w.operation);
  const beta = store.create("22", "Beta", "beta", workspaceSecret()); await provisioner.run("22", beta.operation);
  const oauth = new InMemoryOAuthStore(); await oauth.saveClient({ clientId: "client", clientName: '<unsafe client>', redirectUris: ["http://127.0.0.1:57891/callback"] });
  const github = new WorkspaceGitHub(issuer, { clientId: "test-app", clientSecret: "test-secret" }, (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "transient-provider-token", token_type: "bearer" }));
    if (String(url).endsWith("/user")) { expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer transient-provider-token"); return new Response(JSON.stringify({ id: 33, login: "charlie" })); }
    return new Response(JSON.stringify({ id: 33, login: "charlie", type: "User" }));
  }) as typeof fetch);
  const web = new WorkspaceWeb({ issuer, store, provisioner, github, creationAllowlist: [], grantLifetimeMs: 86400_000, invitationLifetimeMs: 86400_000 });
  const gate = new ReconcileGate(async () => {}); await gate.runFirst();
  const legacyHash = createHash("sha256").update("legacy-token").digest("hex");
  const server = await startMcpHttpServer({ bind: "127.0.0.1", port: 0, vaultDir: legacy, gate, putObject: async () => {}, tokenMap: new Map([[legacyHash, "legacy-host"]]), oauth: { enabled: true, issuer, store: oauth }, workspaceWeb: web });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); });
  const request = (path: string, options: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method: options.method ?? "GET", headers: { Host: "wiki.example.test", ...Object.fromEntries(new Headers(options.headers).entries()) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => {
        const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    }); request.on("error", reject); if (options.body) request.write(options.body); request.end();
  });
  const post = (path: string, cookie: string, values: Record<string, string>, origin = issuer) => request(path, { method: "POST", headers: { Cookie: `__Host-sw_session=${cookie}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: store.session(cookie)!.csrf, ...values }).toString() });
  const verifier = workspaceSecret();
  const authorization = new URLSearchParams({ client_id: "client", redirect_uri: "http://127.0.0.1:57891/callback", response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: "wiki:read wiki:write offline_access", resource: issuer + "/mcp", state: "client-state" });
  const consent = async (actions = "wiki:read wiki:write offline_access") => {
    const approved = await post("/workspace/authorize", ownerCookie, { ...Object.fromEntries(authorization), scope: actions, workspace: w.id });
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get("location")!); expect(location.searchParams.get("state")).toBe("client-state");
    const response = await request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: "client", redirect_uri: authorization.get("redirect_uri")!, resource: issuer + "/mcp" }).toString() });
    expect(response.status).toBe(200); return await response.json() as { access_token: string; refresh_token: string };
  };
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { root, legacy, registry, store, storage, provisioner, web, request, post, call, consent, w, beta, ownerCookie, strangerCookie, authorization };
}
describe("workspace HTTP integration", () => {
  it("provisions isolated minimum schema and leaves legacy bytes untouched", async () => {
    const { store, root, legacy, w, beta } = await setup();
    expect(store.operation("11", w.operation).state).toBe("active");
    expect((await readdir(join(root, "native", w.vaultId))).sort()).toEqual(["SCHEMA.md", "index.md", "log.md"]);
    expect(w.vaultId).not.toBe(beta.vaultId); expect(await readFile(join(legacy, "SCHEMA.md"), "utf8")).toBe("LEGACY PRIVATE CONTENT");
  });
  it("advertises workspace OAuth and completes explicit consent, PKCE, token and MCP read", async () => {
    const { request, consent, call, w } = await setup();
    const metadata = await (await request("/.well-known/oauth-authorization-server")).json() as any;
    expect(metadata.authorization_endpoint).toBe(issuer + "/workspace/authorize");
    const token = await consent(); const read = await call(token.access_token, "wiki_read_page", { path: "SCHEMA.md" });
    expect(read.status).toBe(200); expect(read.body.result.structuredContent.ok).toBe(true); expect(read.body.result.structuredContent.markdown).toContain("Workspace wiki");
    const status = await call(token.access_token, "wiki_status"); expect(status.body.result.structuredContent.vaults.map((v: any) => v.vault_id)).toEqual([w.vaultId]);
  });
  it("terminal SDK route authorizes, writes, reads and refreshes against the real local HTTP server", async () => {
    const { request, post, ownerCookie, strangerCookie, w, beta, root, consent, call } = await setup();
    const profilePath = join(root, "terminal.json");
    const adapter = ((url: string | URL | Request, options?: RequestInit) => {
      const selected = new URL(String(url)); return request(selected.pathname + selected.search, options);
    }) as typeof fetch;
    let browserFlow: Promise<void> | undefined;
    const profile = await authorizeWorkspaceClient(issuer + "/mcp", profilePath, raw => {
      browserFlow = (async () => {
        const authorization = new URL(raw);
        const approval = await post("/workspace/authorize", ownerCookie, { ...Object.fromEntries(authorization.searchParams), workspace: w.id });
        expect(approval.status).toBe(303); expect((await fetch(approval.headers.get("location")!)).status).toBe(200);
      })();
    }, { write: true, request: adapter, timeoutMs: 5000 });
    await browserFlow;
    expect(profile.workspaceId).toBe(w.id);
    const path = "projects/demo/work/2026-10-24-isolation/spec.md";
    const content = "---\ntitle: Local isolation proof\nstatus: planned\n---\n# private-alpha-proof\n";
    const written = await callWorkspaceTool(profilePath, "wiki_workitem_write", { path, content }, adapter);
    expect(written.result.structuredContent).toMatchObject({ ok: true, vault_id: w.vaultId });
    const read = await callWorkspaceTool(profilePath, "wiki_read_page", { path }, adapter);
    expect(read.result.structuredContent).toMatchObject({ ok: true, markdown: expect.stringContaining("# private-alpha-proof") });
    // A separate workspace has no copy, and cross-workspace addressing is denied.
    const ownerToken = await consent();
    expect((await call(ownerToken.access_token, "wiki_read_page", { vault: beta.vaultId, path })).body.result.structuredContent.ok).toBe(false);
    await expect(readFile(join(root, "native", beta.vaultId, path))).rejects.toMatchObject({ code: "ENOENT" });
    const ownQuery = await callWorkspaceTool(profilePath, "wiki_query", { query: "private-alpha-proof", scope: "work" }, adapter);
    expect(ownQuery.result.structuredContent).toMatchObject({ ok: true, results: expect.arrayContaining([expect.objectContaining({ path })]) });
    const deniedQuery = await call(ownerToken.access_token, "wiki_query", { vault: beta.vaultId, query: "private-alpha-proof", scope: "work" });
    expect(deniedQuery.body.result.structuredContent.ok).toBe(false);
    const next = await refreshWorkspaceClient(profilePath, adapter); expect(next.accessToken).not.toBe(profile.accessToken); expect(next.workspaceId).toBe(w.id);
  });
  it("members consent for themselves, see only their grants, and cannot revoke another member", async () => {
    const { store, post, request, call, consent, ownerCookie, strangerCookie, authorization, w } = await setup();
    await consent(); const ownerGrant = store.view("11", w.id).grants[0];
    store.invite("11", w.id, { id: "22", login: "bob" }, "viewer", Date.now() + 10000); store.accept("22", store.snapshot().invitations[0].id);
    const requestConsent = (scope: string) => post("/workspace/authorize", strangerCookie, { ...Object.fromEntries(authorization), scope, workspace: w.id });
    expect((await requestConsent("wiki:write")).status).toBe(400);
    const readPage = await (await request("/workspace/authorize?" + new URLSearchParams({ ...Object.fromEntries(authorization), scope: "wiki:read" }), { headers: { Cookie: `__Host-sw_session=${strangerCookie}` } })).text();
    expect(readPage).toContain("Authorizing for yourself"); expect(readPage).toContain("viewer");
    expect((await requestConsent("wiki:read")).status).toBe(303);
    const memberGrant = store.view("22", w.id).grants[0]; expect(memberGrant.user).toBe("22");
    const listing = await (await request(`/admin/workspaces/${w.id}/connections`, { headers: { Cookie: `__Host-sw_session=${strangerCookie}` } })).text();
    expect(listing).toContain("Your connections"); expect(listing).not.toContain(ownerGrant.id); expect(listing).toContain(memberGrant.id);
    expect((await post(`/admin/workspaces/${w.id}/revoke`, strangerCookie, { grant: ownerGrant.id, confirm: "1" })).status).toBe(403);
    expect((await post(`/admin/workspaces/${w.id}/revoke`, strangerCookie, { grant: memberGrant.id, confirm: "1" })).status).toBe(303);
    expect(store.view("22", w.id).grants[0].revoked).toBe(true);
    store.changeRole("11", w.id, "22", "editor"); expect((await requestConsent("wiki:read wiki:write")).status).toBe(303);
    const editorGrant = store.view("22", w.id).grants.find(g => !g.revoked)!;
    expect((await post(`/admin/workspaces/${w.id}/revoke`, ownerCookie, { grant: editorGrant.id, confirm: "1" })).status).toBe(303);
  });
  it("cannot target another workspace or legacy central; legacy tokens still work", async () => {
    const { consent, call, beta } = await setup(); const token = await consent();
    for (const vault of ["central", beta.vaultId]) { const r = await call(token.access_token, "wiki_read_page", { vault, path: "SCHEMA.md" }); expect(r.body.result.structuredContent.ok).toBe(false); expect(JSON.stringify(r.body)).not.toContain("LEGACY PRIVATE CONTENT"); }
    const legacy = await call("legacy-token", "wiki_read_page", { path: "SCHEMA.md" }); expect(legacy.body.result.structuredContent.markdown).toBe("LEGACY PRIVATE CONTENT");
    expect((await call("sw_invalid", "wiki_status")).status).toBe(401);
  });
  it("rejects writes through read-only grants before touching storage", async () => {
    const { consent, call, root, w } = await setup(); const token = await consent("wiki:read");
    const out = await call(token.access_token, "wiki_log_append", { content: "must not write" });
    expect(out.body.result.structuredContent).toMatchObject({ ok: false, error: "VAULT_UNAUTHORIZED" });
    expect(await readFile(join(root, "native", w.vaultId, "log.md"), "utf8")).toBe("# Vault Log\n");
  });
  it("enforces membership reduction on requests/refresh and does not revive promoted grants", async () => {
    const { store, consent, call, w, request } = await setup(); const token = await consent();
    store.invite("11", w.id, { id: "22", login: "bob" }, "owner", Date.now() + 10000); store.accept("22", store.snapshot().invitations[0].id);
    store.changeRole("22", w.id, "11", "viewer");
    expect((await call(token.access_token, "wiki_log_append", { content: "denied" })).body.result.structuredContent.ok).toBe(false);
    store.changeRole("22", w.id, "11", "owner"); expect((await call(token.access_token, "wiki_log_append", { content: "still denied" })).body.result.structuredContent.ok).toBe(false);
    store.changeRole("22", w.id, "11", "remove"); expect((await call(token.access_token, "wiki_read_page", { path: "SCHEMA.md" })).status).toBe(401);
    const refreshed = await request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: "client", resource: issuer + "/mcp" }).toString() }); expect(refreshed.status).toBe(400);
  });
  it("binds token exchange to resource/client/PKCE/callback and revokes replayed refresh families", async () => {
    const { store, request, post, ownerCookie, authorization, w } = await setup();
    const verifier = workspaceSecret(); authorization.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    const approval = await post("/workspace/authorize", ownerCookie, { ...Object.fromEntries(authorization), workspace: w.id });
    const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;
    const values = { grant_type: "authorization_code", code, client_id: "client", code_verifier: verifier, redirect_uri: authorization.get("redirect_uri")!, resource: issuer + "/mcp" };
    const token = async (input: Record<string, string>) => request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(input).toString() });
    for (const altered of [{ resource: "https://other.example/mcp" }, { client_id: "wrong" }, { code_verifier: workspaceSecret() }, { redirect_uri: "http://127.0.0.1/other" }]) expect((await token({ ...values, ...altered })).status).toBe(400);
    const good = await token(values); expect(good.status).toBe(200); const first = await good.json() as any;
    expect((await token(values)).status).toBe(400);
    const refresh = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "client", resource: issuer + "/mcp" };
    const rotated = await token(refresh); expect(rotated.status).toBe(200); const next = await rotated.json() as any;
    expect((await token(refresh)).status).toBe(400); expect(store.resolveAccess(next.access_token)).toBeNull();
  });
  it("rejects CSRF, foreign origin, wrong identity and unregistered redirect", async () => {
    const { post, ownerCookie, strangerCookie, w, request, authorization } = await setup();
    expect((await post(`/admin/workspaces/${w.id}/archive`, ownerCookie, { confirm: "Alpha" }, "https://evil.example")).status).toBe(400);
    expect((await post(`/admin/workspaces/${w.id}/archive`, ownerCookie, { confirm: "Alpha", csrf: "wrong" })).status).toBe(400);
    expect((await request(`/admin/workspaces/${w.id}`, { headers: { Cookie: `__Host-sw_session=${strangerCookie}` } })).status).toBe(403);
    authorization.set("redirect_uri", "https://evil.example/callback"); expect((await request("/workspace/authorize?" + authorization, { headers: { Cookie: `__Host-sw_session=${ownerCookie}` } })).status).toBe(400);
  });
  it("preserves native form origins without accepting opaque or cross-site logout requests", async () => {
    const { request, post, ownerCookie, store, authorization } = await setup();
    for (const path of ["/admin", "/workspace/authorize?" + authorization]) {
      const response = await request(path, { headers: { Cookie: `__Host-sw_session=${ownerCookie}` } });
      // Chromium sends Origin:null for native POST forms under no-referrer.
      // Same-origin retains form origins without leaking referrers off-site.
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
    }
    expect((await post("/admin/logout", ownerCookie, {}, "null")).status).toBe(400);
    const crossSite = await request("/admin/logout", { method: "POST", headers: { Cookie: `__Host-sw_session=${ownerCookie}`, Origin: issuer, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: store.session(ownerCookie)!.csrf }).toString() });
    expect(crossSite.status).toBe(400);
    expect(store.session(ownerCookie)).not.toBeNull();
    expect((await post("/admin/logout", ownerCookie, {})).status).toBe(303);
    expect(store.session(ownerCookie)).toBeNull();
    expect(await (await request("/admin", { headers: { Cookie: `__Host-sw_session=${ownerCookie}` } })).text()).toContain("Sign in with GitHub");
  });
  it("binds GitHub callback, rotates session and stores neither provider token nor secret", async () => {
    const { request, root, store } = await setup();
    const start = await request("/auth/github/start"); expect(start.status).toBe(303);
    const url = new URL(start.headers.get("location")!); expect(url.hostname).toBe("github.com"); expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const loginCookie = start.headers.get("set-cookie")!.split(";")[0];
    const callback = `/auth/github/callback?code=provider-code&state=${url.searchParams.get("state")}`;
    expect((await request(callback, { headers: { Cookie: "__Host-sw_login=wrong" } })).status).toBe(400);
    const finish = await request(callback, { headers: { Cookie: loginCookie } }); expect(finish.status).toBe(303); expect(finish.headers.get("set-cookie")).toContain("HttpOnly");
    expect(store.visible("33")).toEqual([]); expect(store.snapshot().grants).toEqual([]);
    expect((await request(callback, { headers: { Cookie: loginCookie } })).status).toBe(400);
    const persisted = await readFile(join(root, "control", "workspaces.json"), "utf8"); expect(persisted).not.toContain("transient-provider-token"); expect(persisted).not.toContain("test-secret");
  });
  it("confirms exact GitHub identity before invite and retains CLI-only migration boundary", async () => {
    const { post, ownerCookie, request, w, store } = await setup();
    const lookup = await post(`/admin/workspaces/${w.id}/lookup`, ownerCookie, { login: "charlie", role: "viewer" }); const html = await lookup.text();
    expect(html).toContain("Confirm invitation"); expect(html).toContain("33"); expect(store.snapshot().invitations).toHaveLength(0);
    const settings = await (await request(`/admin/workspaces/${w.id}/settings`, { headers: { Cookie: `__Host-sw_session=${ownerCookie}` } })).text();
    expect(settings).not.toContain("Migration"); expect(settings).not.toContain("type=\"password\"");
  });
});
