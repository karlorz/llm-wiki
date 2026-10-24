import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthStore } from "./oauth-store.js";
import { WorkspaceGitHub } from "./workspace-github.js";
import { WorkspaceError, WorkspaceStore, workspaceSecret, type WorkspaceAction, type WorkspaceRole, roleActions } from "./workspace-store.js";
import { WorkspaceProvisioner } from "./workspace-storage.js";

export interface WorkspaceWebOptions {
  issuer: string;
  store: WorkspaceStore;
  provisioner: WorkspaceProvisioner;
  github: WorkspaceGitHub;
  creationAllowlist: readonly string[];
  /** Deployment policy, required rather than invented product lifetimes. */
  grantLifetimeMs: number;
  invitationLifetimeMs: number;
}
export const escapeWorkspaceHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const h = escapeWorkspaceHtml;
function unique(params: URLSearchParams, key: string): string {
  const values = params.getAll(key); if (values.length > 1) throw new WorkspaceError("DUPLICATE_PARAMETER"); return values[0] ?? "";
}
function cookie(req: IncomingMessage, name: string): string | undefined {
  const values = (req.headers.cookie ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}
function redirect(res: ServerResponse, path: string): void { res.writeHead(303, { Location: path, "Cache-Control": "no-store" }); res.end(); }
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body));
}
function page(res: ServerResponse, title: string, content: string, navigation = "", status = 200, formRedirectOrigin?: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formRedirectOrigin ? ` ${formRedirectOrigin}` : ""}; base-uri 'none'; frame-ancestors 'none'` });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · SkillWiki</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#202936;font:16px/1.55 system-ui,sans-serif}header{background:white;border-bottom:1px solid #dde3e9;padding:20px 5vw}header strong{font-size:22px}main{max-width:1100px;margin:36px auto;padding:0 24px}nav{display:flex;gap:22px;flex-wrap:wrap;margin:18px 0 30px}a{color:#2459ba}h1{font-size:28px;line-height:1.25}h2{font-size:20px}section,article{padding:24px;background:white;border:1px solid #dde3e9;border-radius:12px;margin:20px 0}label{display:block;margin:14px 0}input,select,button{font:inherit;padding:9px 12px;border:1px solid #aab5c4;border-radius:6px;max-width:100%}input:not([type=checkbox]){display:block;width:360px;margin-top:5px}button{cursor:pointer;background:#2459ba;color:white;border:0;margin:8px 0}button.danger{background:#9e2935}small,.muted{color:#586779}.notice{padding:16px;background:#edf3ff;border-left:4px solid #4475ca}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:14px 8px;border-bottom:1px solid #e0e5eb;vertical-align:top}code{overflow-wrap:anywhere}.table{overflow:auto}.inline{display:inline-block;margin-right:12px}footer{margin:32px 0;color:#586779}@media(max-width:640px){main{padding:0 16px}section{padding:18px}th,td{min-width:130px}}
  </style><header><strong>SkillWiki</strong> <span class="muted">Administration</span></header><main>${navigation}<h1>${h(title)}</h1>${content}<footer>Wiki content stays in Obsidian. Each workspace has one isolated wiki.</footer></main></html>`);
}
const hidden = (name: string, value: string) => `<input type="hidden" name="${h(name)}" value="${h(value)}">`;
const form = (path: string, csrf: string, body: string) => `<form method="post" action="${h(path)}">${hidden("csrf", csrf)}${body}</form>`;
const roles = `<option value="viewer">Viewer — read only</option><option value="editor">Editor — read and write</option><option value="owner">Owner — administer workspace</option>`;

/** Separate user administration surface. Never exposes the loopback operator console. */
export class WorkspaceWeb {
  readonly issuer: string;
  readonly sessionCookie: string;
  private readonly secure: string;
  constructor(readonly options: WorkspaceWebOptions) {
    const url = new URL(options.issuer);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new WorkspaceError("INVALID_WORKSPACE_ISSUER");
    if (!Number.isSafeInteger(options.grantLifetimeMs) || options.grantLifetimeMs <= 0 || !Number.isSafeInteger(options.invitationLifetimeMs) || options.invitationLifetimeMs <= 0) throw new WorkspaceError("LIFETIME_POLICY_REQUIRED");
    this.issuer = url.origin; this.secure = url.protocol === "https:" ? "; Secure" : ""; this.sessionCookie = this.secure ? "__Host-sw_session" : "sw_session";
  }
  isPath(path: string): boolean { return path === "/admin" || path.startsWith("/admin/") || path.startsWith("/auth/github/") || path === "/workspace/authorize"; }
  private setCookie(res: ServerResponse, name: string, value: string, age: number): void { res.setHeader("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.secure}`); }
  private sameOrigin(req: IncomingMessage): void {
    if (req.headers.origin !== this.issuer || req.headers["sec-fetch-site"] === "cross-site") throw new WorkspaceError("ORIGIN_DENIED");
  }
  private loginLink(next: string): string { return `/auth/github/start?next=${encodeURIComponent(next)}`; }
  private next(raw: string): string {
    if (raw === "/admin" || raw === "") return "/admin";
    const url = new URL(raw, this.issuer);
    if (url.origin !== this.issuer || url.pathname !== "/workspace/authorize" || url.hash) throw new WorkspaceError("INVALID_RETURN_PATH");
    return url.pathname + url.search;
  }
  async handle(req: IncomingMessage, res: ServerResponse, rawBody: string, clients?: OAuthStore): Promise<boolean> {
    const url = new URL(req.url ?? "/", this.issuer);
    const tokenParams = new URLSearchParams(rawBody);
    const isScopedToken = url.pathname === "/token" && [tokenParams.get("code"), tokenParams.get("refresh_token")].some(x => x?.startsWith("swc_") || x?.startsWith("swr_"));
    if (!this.isPath(url.pathname) && !isScopedToken) return false;
    try {
      if (req.headers.host !== new URL(this.issuer).host) throw new WorkspaceError("HOST_DENIED");
      const params = req.method === "POST" ? new URLSearchParams(rawBody) : url.searchParams;
      if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new WorkspaceError("FORM_REQUIRED");
      const get = (key: string) => unique(params, key);
      if (isScopedToken) {
        const kind = get("grant_type") === "authorization_code" ? "code" : get("grant_type") === "refresh_token" ? "refresh" : undefined;
        if (!kind || get("resource") !== `${this.issuer}/mcp`) throw new WorkspaceError("INVALID_RESOURCE");
        json(res, 200, this.options.store.exchange({ kind, secret: get(kind === "code" ? "code" : "refresh_token"), client: get("client_id"), redirect: get("redirect_uri"), verifier: get("code_verifier") })); return true;
      }
      const { store, github, provisioner } = this.options;
      if (url.pathname === "/auth/github/start" && req.method === "GET") {
        if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== this.issuer)) throw new WorkspaceError("ORIGIN_DENIED");
        const flow = github.start(store, this.next(get("next"))); this.setCookie(res, this.secure ? "__Host-sw_login" : "sw_login", flow.binding, 600); redirect(res, flow.url); return true;
      }
      if (url.pathname === "/auth/github/callback" && req.method === "GET") {
        if (get("error")) throw new WorkspaceError("GITHUB_LOGIN_FAILED");
        const identity = await github.finish(store, get("state"), cookie(req, this.secure ? "__Host-sw_login" : "sw_login") ?? "", get("code"));
        const secret = store.login({ id: identity.id, login: identity.login });
        store.allowCreation(identity.id, this.options.creationAllowlist.includes(identity.id));
        this.setCookie(res, this.sessionCookie, secret, 8 * 3600); redirect(res, this.next(identity.next)); return true;
      }
      const session = store.session(cookie(req, this.sessionCookie));
      if (!session) { page(res, "Sign in", `<section><p>Sign in to manage your workspaces. GitHub identifies you; access requires explicit workspace membership.</p><a href="${h(this.loginLink(this.next(url.pathname === "/workspace/authorize" ? req.url! : "/admin")))}">Sign in with GitHub</a>${url.pathname === "/workspace/authorize" ? `<p><a href="${h(`/authorize${url.search}`)}">Existing trusted-host operator consent</a></p>` : ""}</section>`); return true; }
      if (req.method === "POST") {
        this.sameOrigin(req); if (get("csrf") !== session.csrf) throw new WorkspaceError("CSRF_DENIED");
      } else if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const csrf = session.csrf, user = session.user;
      const nav = `<nav><a href="/admin">Workspaces</a>${form("/admin/logout", csrf, '<button>Sign out</button>')}</nav>`;
      if (url.pathname === "/admin/logout" && req.method === "POST") { store.logout(cookie(req, this.sessionCookie)!); this.setCookie(res, this.sessionCookie, "", 0); redirect(res, "/admin"); return true; }
      if (url.pathname === "/workspace/authorize") {
        if (!clients) throw new WorkspaceError("OAUTH_UNAVAILABLE");
        const client = await clients.getClient(get("client_id"));
        const redirectUri = get("redirect_uri");
        if (!client || !client.redirectUris.includes(redirectUri) || get("response_type") !== "code" || get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(get("code_challenge")) || get("resource") !== `${this.issuer}/mcp`) throw new WorkspaceError("INVALID_AUTHORIZATION_REQUEST");
        const redirectTarget = new URL(redirectUri);
        if (redirectTarget.hash || redirectTarget.username || redirectTarget.password || !(redirectTarget.protocol === "https:" || (redirectTarget.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirectTarget.hostname)))) throw new WorkspaceError("INVALID_REDIRECT");
        const scopes = get("scope").split(/\s+/).filter(Boolean);
        if (scopes.some(s => !["wiki:read", "wiki:write", "offline_access"].includes(s))) throw new WorkspaceError("INVALID_SCOPE");
        const actions = scopes.filter(s => s !== "offline_access").map(s => s.slice(5) as WorkspaceAction);
        if (!actions.length) actions.push("read");
        if (req.method === "POST") {
          const code = store.consent(user, { workspace: get("workspace"), client: client.clientId, name: client.clientName ?? "MCP client", actions, offline: scopes.includes("offline_access"), expires: Date.now() + this.options.grantLifetimeMs, redirect: redirectUri, challenge: get("code_challenge") });
          redirectTarget.searchParams.set("code", code); if (get("state")) redirectTarget.searchParams.set("state", get("state")); redirect(res, redirectTarget.toString()); return true;
        }
        const fields = ["client_id", "redirect_uri", "response_type", "code_challenge_method", "code_challenge", "resource", "scope", "state"].map(k => hidden(k, get(k))).join("");
        const eligible = store.visible(user).map(w => ({ w, role: store.view(user, w.id).role }))
          .filter(({ role }) => actions.every(a => roleActions(role).includes(a)));
        const account = store.snapshot().users.find(u => u.id === user)!;
        // Chromium applies form-action to the POST's redirect chain as well.
        // The target is the exact registered, validated callback origin above.
        page(res, "Authorize MCP connection", `<section><p>Authorizing for yourself: <strong>${h(account.login)}</strong> · GitHub ID ${h(user)}.</p><p><strong>${h(client.clientName ?? "MCP client")}</strong> requests: ${h(actions.join(", "))}.</p><p>Access is limited to the workspace you choose. Changing the web workspace never changes this connection. Expires ${h(new Date(Date.now() + this.options.grantLifetimeMs).toISOString())}.</p>${eligible.length ? form("/workspace/authorize", csrf, `${fields}<label>Workspace<select name="workspace">${eligible.map(({ w, role }) => `<option value="${h(w.id)}">${h(w.name)} · ${h(role)} — ${h(roleActions(role).join(", "))}</option>`).join("")}</select></label><button>Authorize this connection</button>`) : '<p>No active membership permits these requested actions. Request read-only access if your role is Viewer.</p>'}</section>`, nav, 200, redirectTarget.origin); return true;
      }
      if (url.pathname === "/admin" && req.method === "GET") {
        const s = store.snapshot(), workspaces = store.visible(user);
        const invitations = s.invitations.filter(i => i.user === user && i.state === "pending" && i.expires > Date.now() && s.workspaces.some(w => w.id === i.workspace && w.state === "active"));
        const operations = s.workspaces.filter(w => w.creator === user && !["active", "archived"].includes(w.state));
        page(res, workspaces.length ? "Your workspaces" : "No workspaces yet", `${workspaces.map(w => `<section><h2><a href="/admin/workspaces/${w.id}">${h(w.name)}</a></h2><p>One bound wiki · ${h(store.view(user, w.id).role)}</p></section>`).join("")}${invitations.map(i => `<section><h2>Workspace invitation</h2><p>${h(s.workspaces.find(w => w.id === i.workspace)!.name)} · ${h(i.role)}</p>${form("/admin/accept", csrf, `${hidden("invitation", i.id)}<button>Accept invitation</button>`)}</section>`).join("")}${operations.map(w => `<section><a href="/admin/operations/${w.operation}">Continue ${h(w.name)} setup — ${h(w.state)}</a></section>`).join("")}<section>${store.creationEligible(user) ? '<a href="/admin/create">Create a workspace and wiki</a>' : '<p>Workspace creation is unavailable for this account. You can accept an invitation from an Owner.</p>'}</section>`, nav); return true;
      }
      if (url.pathname === "/admin/accept" && req.method === "POST") { store.accept(user, get("invitation")); redirect(res, "/admin"); return true; }
      if (url.pathname === "/admin/create") {
        if (req.method === "POST") {
          const w = store.create(user, get("name"), get("slug"), get("key")); void provisioner.run(user, w.operation).catch(() => {}); redirect(res, `/admin/operations/${w.operation}`); return true;
        }
        if (!store.creationEligible(user)) throw new WorkspaceError("CREATION_UNAVAILABLE");
        page(res, "Create workspace", `<section><p>Create one private workspace with one new isolated wiki. Nothing is copied from existing wikis. You become Owner only when setup completes.</p>${form("/admin/create", csrf, `${hidden("key", workspaceSecret())}<label>Workspace name<input name="name" required maxlength="80"></label><label>Workspace slug<input name="slug" required pattern="[a-z][a-z0-9-]{1,47}" maxlength="48"></label><p class="notice">Creating a workspace does not create an MCP connection or distribute storage credentials.</p><button>Create workspace and wiki</button>`)}</section>`, nav); return true;
      }
      const operation = /^\/admin\/operations\/([a-f0-9-]+)(\/retry)?$/.exec(url.pathname);
      if (operation) {
        const w = store.operation(user, operation[1]);
        if (operation[2] && req.method === "POST") {
          if (w.state !== "failed") throw new WorkspaceError("RETRY_UNAVAILABLE");
          void provisioner.run(user, w.operation).catch(() => {}); redirect(res, `/admin/operations/${w.operation}`); return true;
        }
        page(res, w.state === "active" ? "Workspace ready" : w.state === "failed" ? "Setup failed" : "Setting up workspace", `<section><p>${h(w.name)} · ${h(w.state)}</p><p>Operation <code>${h(w.operation)}</code></p><p>You can leave this page and return to the same setup operation.</p><ol><li>Workspace and wiki identifiers: reserved</li><li>Wiki schema: ${w.step === "reserved" ? "not verified complete" : "initialized"}</li><li>Storage and schema verification: ${w.step === "verified" ? "complete" : w.state === "failed" && w.step === "initialized" ? "failed" : "not complete"}</li><li>Workspace and initial Owner activation: ${w.state === "active" ? "complete" : "not active"}</li></ol>${w.state === "failed" ? `<p role="alert">${h(w.error)}</p>${form(`/admin/operations/${w.operation}/retry`, csrf, '<button>Retry same setup</button>')}` : w.state === "active" ? `<a href="/admin/workspaces/${w.id}">Open workspace administration</a>` : `<a href="/admin/operations/${w.operation}">Refresh setup status</a>`}</section>`, nav); return true;
      }
      const workspacePath = /^\/admin\/workspaces\/([a-f0-9-]+)(?:\/(members|connections|audit|settings|lookup|invite|role|cancel-invite|revoke|archive))?$/.exec(url.pathname);
      if (!workspacePath) { json(res, 404, { error: "not_found" }); return true; }
      const workspace = workspacePath[1], tab = workspacePath[2] ?? "overview", view = store.view(user, workspace), owner = view.role === "owner";
      const base = `/admin/workspaces/${workspace}`;
      const navigation = nav + `<p>${h(view.workspace.name)} · ${h(view.role)}</p><nav>${["overview", "members", "connections", "audit", "settings"].map(t => `<a href="${base}${t === "overview" ? "" : `/${t}`}">${h(t === "connections" ? "MCP Connections" : t[0].toUpperCase() + t.slice(1))}</a>`).join("")}</nav>`;
      if (req.method === "POST") {
        if (!owner && tab !== "revoke") throw new WorkspaceError("ACCESS_DENIED");
        if (tab === "lookup") {
          const target = await github.lookup(get("login"));
          const payload = JSON.stringify({ workspace, target, role: get("role"), expires: Date.now() + 300_000 });
          const proof = createHmac("sha256", csrf).update(payload).digest("hex");
          page(res, "Confirm invitation", `<section><p>Invite <strong>${h(target.login)}</strong>, GitHub ID <code>${h(target.id)}</code>, as ${h(get("role"))}?</p><p>Only that exact GitHub identity can accept.</p>${form(`${base}/invite`, csrf, `${hidden("payload", payload)}${hidden("proof", proof)}<button>Confirm invitation</button>`)}</section>`, navigation); return true;
        }
        if (tab === "invite") {
          const payload = get("payload"), expected = createHmac("sha256", csrf).update(payload).digest(), actual = Buffer.from(get("proof"), "hex");
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new WorkspaceError("INVITATION_PROOF_INVALID");
          const resolved = JSON.parse(payload) as { workspace: string; target: { id: string; login: string }; role: WorkspaceRole; expires: number };
          if (resolved.workspace !== workspace || resolved.expires <= Date.now()) throw new WorkspaceError("INVITATION_PROOF_EXPIRED");
          store.invite(user, workspace, resolved.target, resolved.role, Date.now() + this.options.invitationLifetimeMs);
        } else if (tab === "role") {
          if (get("confirm") !== "1") throw new WorkspaceError("CONFIRMATION_REQUIRED");
          store.changeRole(user, workspace, get("user"), get("role") as WorkspaceRole | "remove");
        }
        else if (tab === "cancel-invite") store.cancelInvite(user, workspace, get("invitation"));
        else if (tab === "revoke") { if (get("confirm") !== "1") throw new WorkspaceError("CONFIRMATION_REQUIRED"); store.revoke(user, workspace, get("grant")); }
        else if (tab === "archive") { if (get("confirm") !== view.workspace.name) throw new WorkspaceError("CONFIRMATION_REQUIRED"); store.archive(user, workspace); redirect(res, "/admin"); return true; }
        else throw new WorkspaceError("UNKNOWN_ACTION");
        redirect(res, `${base}/${tab === "revoke" ? "connections" : "members"}`); return true;
      }
      let body: string;
      if (tab === "members") body = `<section><h2>Active members</h2><p class="notice">Role reductions restrict subsequent requests and refresh. Promotion does not expand old grants. The last Owner cannot be removed or demoted.</p>${view.members.map(m => `<article><strong>${h(m.login)}</strong> · ${h(m.role)}<p>${m.role === "owner" ? "Manage workspace, members and connections." : m.role === "editor" ? "Read and write wiki content; no administration." : "Read only."}</p>${owner ? form(`${base}/role`, csrf, `${hidden("user", m.user)}<label>New role<select name="role">${roles.replace(`value="${m.role}"`, `value="${m.role}" selected`)}<option value="remove">Remove membership</option></select></label><label><input type="checkbox" name="confirm" value="1" required> Confirm the selected change for ${h(m.login)}. Reductions restrict existing connections; removal revokes them. Promotion requires new consent for broader actions.</label><button>Apply membership change</button>`) : ""}</article>`).join("")}</section>${owner ? `<section><h2>Invite member</h2>${form(`${base}/lookup`, csrf, `<label>Exact GitHub username<input name="login" required></label><label>Role<select name="role">${roles}</select></label><button>Look up identity</button>`)}<h2>Pending invitations</h2>${view.invitations.filter(i => i.state === "pending").map(i => `<article>${h(i.login)} · ID ${h(i.user)} · ${h(i.role)} · ${i.expires > Date.now() ? "Pending" : "Expired"}${form(`${base}/cancel-invite`, csrf, `${hidden("invitation", i.id)}<button>Cancel invitation</button>`)}</article>`).join("") || '<p>No pending invitations.</p>'}</section>` : ""}`;
      else if (tab === "connections") body = `<section><h2>MCP service</h2><code>${h(this.issuer)}/mcp</code><p>Each connection requires separate consent and is bound to this workspace only. Members connect their own agents. Owners can view and revoke any connection in this workspace. You can revoke your own connections.</p><h2>${owner ? "All workspace connections" : "Your connections"}</h2><div class="table"><table><tr><th>Client</th><th>GitHub identity</th><th>Actions</th><th>Authorization</th><th>Expires</th><th>Revoke</th></tr>${view.grants.map(g => `<tr><td>${h(g.name)}</td><td>${h(g.user)}</td><td>${h(g.actions.join(", "))}</td><td>${g.revoked ? "Revoked" : g.expires <= Date.now() ? "Expired" : "Authorized"}</td><td>${h(new Date(g.expires).toISOString())}</td><td>${!g.revoked ? form(`${base}/revoke`, csrf, `${hidden("grant", g.id)}<label><input type="checkbox" name="confirm" value="1" required> Revoke ${h(g.name)} for ${h(view.workspace.name)}; new consent is required to restore access.</label><button class="danger">Revoke connection</button>`) : ""}</td></tr>`).join("")}</table></div></section><section><h2>Connector setup</h2><p>Add the MCP service URL above to a supported connector, sign in with GitHub, select this workspace and approve its requested actions.</p></section><section><h2>Skill + CLI setup</h2><p>Use an OAuth-capable terminal client with the same MCP URL and separate workspace consent. Retain any saved endpoint unless explicitly asked to change it; never reuse credentials for another service or workspace.</p><p class="muted">Automatic installation and direct Obsidian credential delivery are not available.</p></section>`;
      else if (tab === "audit") body = owner ? `<section><h2>Administrative events</h2>${view.audit.slice(-100).reverse().map(e => `<p>${h(new Date(e.at).toISOString())} · ${h(e.actor)} · ${h(e.event)}</p>`).join("")}</section>` : '<section>Only Owners can view workspace administrative events.</section>';
      else if (tab === "settings") body = `<section><h2>Workspace</h2><p>${h(view.workspace.name)} · ${h(view.workspace.slug)}</p><p>Wiki binding is read-only: <code>${h(view.workspace.vaultId)}</code></p><p>Storage capacity and deletion retention are not configured. Destructive deletion and external repository provisioning are unavailable.</p>${owner ? form(`${base}/archive`, csrf, `<label>Type ${h(view.workspace.name)} to archive<input name="confirm" required></label><p>Archiving preserves content and audit, blocks access and revokes connections. Existing downloaded copies are not erased.</p><button class="danger">Archive workspace</button>`) : ""}</section>`;
      else if (tab === "overview") body = `<section><h2>Bound wiki</h2><code>${h(view.workspace.vaultId)}</code><p>One isolated wiki. Content browsing remains in Obsidian.</p></section><section><h2>Administration</h2><p>${view.members.length} members · ${view.grants.filter(g => !g.revoked && g.expires > Date.now()).length} authorized connections</p><p>Provisioning verification: completed. Live storage health has not been checked by this page.</p></section><section><h2>Obsidian access</h2><p>Ask the deployment operator for a separately authorized workspace binding. Web sign-in and MCP consent do not grant direct filesystem, Git, S3 or backup access.</p></section>`;
      else { json(res, 404, { error: "not_found" }); return true; }
      page(res, tab === "connections" ? "MCP connections" : tab[0].toUpperCase() + tab.slice(1), body, navigation); return true;
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : "REQUEST_FAILED";
      if (isScopedToken) json(res, 400, { error: "invalid_grant", error_description: code });
      else page(res, "Request could not be completed", `<section><p role="alert">${h(code)}</p><p>No additional access was granted. Return to your workspaces or retry the same setup operation.</p><a href="/admin">Workspaces</a></section>`, "", code === "ACCESS_DENIED" ? 403 : 400);
      return true;
    }
  }
}
