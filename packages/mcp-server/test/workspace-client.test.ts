import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { authorizeWorkspaceClient, refreshWorkspaceClient, discoverWorkspaceService, callWorkspaceTool } from "../src/workspace-client.js";
function provider(options: { mismatch?: boolean; swapped?: boolean } = {}) {
  let authorization: URL | undefined; let generation = 0; const requests: string[] = [];
  const request = (async (raw: string | URL | Request, init: RequestInit = {}) => {
    const url = String(raw); requests.push(url);
    if (url.endsWith("oauth-protected-resource")) return new Response(JSON.stringify({ resource: options.mismatch ? "https://other.example/mcp" : "https://wiki.example/mcp", authorization_servers: ["https://wiki.example"] }));
    if (url.endsWith("oauth-authorization-server")) return new Response(JSON.stringify({ issuer: "https://wiki.example", authorization_endpoint: "https://wiki.example/workspace/authorize", token_endpoint: "https://wiki.example/token", registration_endpoint: "https://wiki.example/register", code_challenge_methods_supported: ["S256"] }));
    if (url.endsWith("register")) return new Response(JSON.stringify({ client_id: "terminal-client" }));
    if (url.endsWith("token")) {
      const params = new URLSearchParams(String(init.body)); expect(params.get("client_id")).toBe("terminal-client"); expect(params.get("resource")).toBe("https://wiki.example/mcp");
      if (params.get("grant_type") === "authorization_code") expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(authorization!.searchParams.get("code_challenge"));
      else expect(params.get("refresh_token")).toBe(`swr_refresh-${generation}`);
      generation++; return new Response(JSON.stringify({ access_token: `sw_access-${generation}`, refresh_token: `swr_refresh-${generation}`, expires_in: 3600, token_type: "Bearer" }));
    }
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer sw_access-${generation}`);
    if (init.method === "GET") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init.body));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: body.params.name === "wiki_status" ? { ok: true, identity_kind: "workspace", workspace_id: options.swapped && generation > 1 ? "wrong" : "workspace-one", vault_id: "v-one", writer_id: "workspace-grant" } : { ok: true, path: body.params.arguments.path } } }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const show = (raw: string) => {
    authorization = new URL(raw); expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!); callback.searchParams.set("code", "swc_code");
    void fetch(callback).then(r => { expect(r.status).toBe(200); });
  };
  return { request, show, requests };
}
describe("terminal workspace setup", () => {
  it("uses selected endpoint, PKCE and private credentials; calls tools and rotates refresh", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "workspace-client-")), "profile.json"), mock = provider();
    const first = await authorizeWorkspaceClient("https://wiki.example/mcp", path, mock.show, { request: mock.request });
    expect(first.workspaceId).toBe("workspace-one");
    // Windows uses inherited ACLs rather than POSIX mode bits.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const call = await callWorkspaceTool(path, "wiki_read_page", { path: "index.md" }, mock.request); expect(call.result.structuredContent).toMatchObject({ path: "index.md" });
    const next = await refreshWorkspaceClient(path, mock.request); expect(next.accessToken).not.toBe(first.accessToken); expect(next.resource).toBe(first.resource); expect(next.workspaceId).toBe(first.workspaceId);
    expect(JSON.parse(readFileSync(path, "utf8")).refreshToken).toBe(next.refreshToken);
    await expect(authorizeWorkspaceClient("https://other.example/mcp", path, mock.show, { request: mock.request })).rejects.toThrow("PROFILE_EXISTS");
    await expect(callWorkspaceTool(path, "wiki_read_page", { vault: "central", path: "index.md" }, mock.request)).rejects.toThrow("BINDING_CHANGED");
  });
  it("stops on discovery mismatch without registration or token requests", async () => { const mock = provider({ mismatch: true }); await expect(discoverWorkspaceService("https://wiki.example/mcp", mock.request)).rejects.toThrow("DISCOVERY_MISMATCH"); expect(mock.requests).toHaveLength(1); });
  it("rejects credentials in URLs and insecure non-loopback endpoints", async () => { const mock = provider(); for (const url of ["http://wiki.example/mcp", "https://user:password@wiki.example/mcp", "https://wiki.example/mcp?token=x"]) await expect(discoverWorkspaceService(url, mock.request)).rejects.toThrow("INVALID_MCP_URL"); expect(mock.requests).toHaveLength(0); });
  it("preserves saved binding when refresh returns another workspace", async () => { const path = join(mkdtempSync(join(tmpdir(), "workspace-client-")), "profile.json"), mock = provider({ swapped: true }); await authorizeWorkspaceClient("https://wiki.example/mcp", path, mock.show, { request: mock.request }); const before = readFileSync(path, "utf8"); await expect(refreshWorkspaceClient(path, mock.request)).rejects.toThrow("BINDING_CHANGED"); expect(readFileSync(path, "utf8")).toBe(before); });
  it("times out without writing a profile", async () => { const path = join(mkdtempSync(join(tmpdir(), "workspace-client-")), "profile.json"), mock = provider(); await expect(authorizeWorkspaceClient("https://wiki.example/mcp", path, () => {}, { request: mock.request, timeoutMs: 20 })).rejects.toThrow("LOGIN_TIMEOUT"); });
});
