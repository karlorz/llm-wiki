import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { workspaceJson as requestJson, workspaceResponseBytes } from "./workspace-http.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { WorkspaceError, workspaceSecret } from "./workspace-store.js";

const profileSchema = z.object({ version: z.literal(1), resource: z.string().url(), clientId: z.string(), workspaceId: z.string(), vaultId: z.string(), writerId: z.string(), accessToken: z.string().startsWith("sw_"), refreshToken: z.string().startsWith("swr_").optional(), expiresAt: z.number() }).strict();
export type WorkspaceClientProfile = z.infer<typeof profileSchema>;
function resourceUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/mcp" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new WorkspaceError("INVALID_MCP_URL");
  return url;
}
export async function discoverWorkspaceService(resource: string, request: typeof fetch = fetch) {
  const url = resourceUrl(resource);
  const prm = await requestJson(`${url.origin}/.well-known/oauth-protected-resource`, {}, request);
  if (prm.resource !== url.href || !Array.isArray(prm.authorization_servers) || prm.authorization_servers.length !== 1 || prm.authorization_servers[0] !== url.origin) throw new WorkspaceError("DISCOVERY_MISMATCH");
  const metadata = await requestJson(`${url.origin}/.well-known/oauth-authorization-server`, {}, request);
  if (metadata.issuer !== url.origin || metadata.authorization_endpoint !== `${url.origin}/workspace/authorize` || metadata.token_endpoint !== `${url.origin}/token` || metadata.registration_endpoint !== `${url.origin}/register` || !metadata.code_challenge_methods_supported?.includes("S256")) throw new WorkspaceError("DISCOVERY_MISMATCH");
  return { resource: url.href, issuer: url.origin, authorization: String(metadata.authorization_endpoint), token: String(metadata.token_endpoint), registration: String(metadata.registration_endpoint) };
}
function saveProfile(path: string, profile: WorkspaceClientProfile, create: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, create ? "wx" : "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(profile, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
async function rpcTool(resource: string, accessToken: string, name: string, args: Record<string, unknown>, request: typeof fetch) {
  const client = new Client({ name: "skillwiki-workspace-terminal", version: "1" });
  const transport = new StreamableHTTPClientTransport(resourceUrl(resource), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: async (url, init) => {
      // No redirect may forward credentials to a different endpoint. The finite
      // RPC budget is separate from the smaller identity/discovery document cap.
      const response = await request(url, { ...init, redirect: "error", signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15_000)]) });
      const bytes = await workspaceResponseBytes(response, 4 * 1024 * 1024);
      return new Response(bytes.length ? bytes : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally { await client.close(); }
}
async function identify(resource: string, accessToken: string, request: typeof fetch) {
  const response = await rpcTool(resource, accessToken, "wiki_status", {}, request);
  const parsed = z.object({ ok: z.literal(true), identity_kind: z.literal("workspace"), workspace_id: z.string(), vault_id: z.string(), writer_id: z.string() }).safeParse(response.structuredContent);
  if (!parsed.success) throw new WorkspaceError("WORKSPACE_HANDSHAKE_FAILED");
  const result = parsed.data;
  return { workspaceId: result.workspace_id, vaultId: result.vault_id, writerId: result.writer_id };
}
export async function authorizeWorkspaceClient(resource: string, profilePath: string, showUrl: (url: string) => void, options: { write?: boolean; request?: typeof fetch; timeoutMs?: number } = {}): Promise<WorkspaceClientProfile> {
  if (existsSync(profilePath)) throw new WorkspaceError("PROFILE_EXISTS_USE_SAVED_ENDPOINT");
  const request = options.request ?? fetch, discovery = await discoverWorkspaceService(resource, request);
  const state = workspaceSecret(), verifier = workspaceSecret();
  let receive!: (code: string) => void, rejectReceive!: (error: Error) => void, finished = false;
  const received = new Promise<string>((resolve, reject) => { receive = resolve; rejectReceive = reject; });
  void received.catch(() => {}); // Registration failure may end before the callback is awaited.
  const callback = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback" || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state || finished) { res.writeHead(400); res.end("Invalid callback"); return; }
    if (url.searchParams.has("error")) { finished = true; rejectReceive(new WorkspaceError("CONSENT_DENIED")); res.writeHead(200); res.end("Authorization denied. Return to your terminal."); return; }
    if (url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code")) { res.writeHead(400); res.end("Invalid callback"); return; }
    finished = true; receive(url.searchParams.get("code")!); res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end("Authorization received. Return to your terminal.");
  });
  await new Promise<void>((resolve, reject) => { callback.once("error", reject); callback.listen(0, "127.0.0.1", resolve); });
  const timer = setTimeout(() => rejectReceive(new WorkspaceError("LOGIN_TIMEOUT")), options.timeoutMs ?? 300_000);
  try {
    const redirect = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`;
    const registration = await requestJson(discovery.registration, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "SkillWiki terminal", redirect_uris: [redirect] }) }, request);
    if (typeof registration.client_id !== "string" || !registration.client_id) throw new WorkspaceError("REGISTRATION_FAILED");
    const url = new URL(discovery.authorization);
    url.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect, response_type: "code", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: discovery.resource, scope: options.write ? "wiki:read wiki:write offline_access" : "wiki:read offline_access" }).toString();
    showUrl(url.toString());
    const code = await received;
    const tokens = await requestJson(discovery.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: registration.client_id, code_verifier: verifier, redirect_uri: redirect, resource: discovery.resource }).toString() }, request);
    const identity = await identify(discovery.resource, String(tokens.access_token), request);
    const profile = profileSchema.parse({ version: 1, resource: discovery.resource, clientId: registration.client_id, ...identity, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 });
    saveProfile(profilePath, profile, true); return profile;
  } finally { clearTimeout(timer); callback.closeAllConnections(); await new Promise<void>(resolve => callback.close(() => resolve())); }
}
export async function refreshWorkspaceClient(profilePath: string, request: typeof fetch = fetch): Promise<WorkspaceClientProfile> {
  const lock = `${profilePath}.lock`, fd = openSync(lock, "wx", 0o600); closeSync(fd);
  try {
    const profile = profileSchema.parse(JSON.parse(readFileSync(profilePath, "utf8")));
    if (!profile.refreshToken) throw new WorkspaceError("NEW_CONSENT_REQUIRED");
    const discovery = await discoverWorkspaceService(profile.resource, request);
    const tokens = await requestJson(discovery.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: profile.refreshToken, client_id: profile.clientId, resource: profile.resource }).toString() }, request);
    const identity = await identify(profile.resource, String(tokens.access_token), request);
    if (identity.workspaceId !== profile.workspaceId || identity.vaultId !== profile.vaultId || identity.writerId !== profile.writerId) throw new WorkspaceError("WORKSPACE_BINDING_CHANGED");
    const updated = profileSchema.parse({ ...profile, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 });
    const temporary = `${profilePath}.${workspaceSecret()}.tmp`; saveProfile(temporary, updated, true); renameSync(temporary, profilePath); return updated;
  } finally { unlinkSync(lock); }
}
export async function callWorkspaceTool(profilePath: string, name: string, args: Record<string, unknown>, request: typeof fetch = fetch) {
  if (!/^wiki_[a-z_]+$/.test(name) || !args || Array.isArray(args) || typeof args !== "object") throw new WorkspaceError("INVALID_TOOL_REQUEST");
  let profile = profileSchema.parse(JSON.parse(readFileSync(profilePath, "utf8")));
  if (args.vault !== undefined && args.vault !== profile.vaultId) throw new WorkspaceError("WORKSPACE_BINDING_CHANGED");
  if (profile.expiresAt <= Date.now() + 30_000) profile = await refreshWorkspaceClient(profilePath, request);
  return { result: await rpcTool(profile.resource, profile.accessToken, name, args, request) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, flag] = process.argv.slice(2);
  const run = Promise.resolve().then<unknown>(() => command === "call" && first && second && flag
    ? callWorkspaceTool(resolve(first), second, JSON.parse(flag)).then(result => { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); })
    : command === "authorize" && first && second && (!flag || flag === "--write")
    ? authorizeWorkspaceClient(first, resolve(second), url => process.stdout.write(`Open this URL to sign in and approve one workspace:\n${url}\n`), { write: flag === "--write" })
    : command === "refresh" && first && !second ? refreshWorkspaceClient(resolve(first)) : Promise.reject(new WorkspaceError("USAGE")));
  run.then(() => { if (command !== "call") process.stdout.write("Workspace credentials saved privately. Token values are not printed.\n"); }).catch(error => { process.stderr.write(`${error instanceof WorkspaceError ? error.code : "CLIENT_FAILED"}. No endpoint fallback was attempted.\n`); process.exitCode = 1; });
}
