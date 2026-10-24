import { workspaceJson } from "./workspace-http.js";
import { createHash } from "node:crypto";
import { WorkspaceError, WorkspaceStore } from "./workspace-store.js";

export interface GitHubIdentity { id: string; login: string }
export interface WorkspaceGitHubConfig { clientId: string; clientSecret: string }

/** Adapted from GrokSearch operatorlogin/github.go: one-use bound state, PKCE, identity only. */
export class WorkspaceGitHub {
  constructor(private readonly issuer: string, private readonly config: WorkspaceGitHubConfig, private readonly request: typeof fetch = fetch) {}
  start(store: WorkspaceStore, next = "/admin") {
    const flow = store.beginLogin(next);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: `${this.issuer}/auth/github/callback`, state: flow.state,
      code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"), code_challenge_method: "S256", scope: "", prompt: "select_account" }).toString();
    return { url: url.toString(), binding: flow.binding };
  }
  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    return workspaceJson(url, { ...init, headers: { Accept: "application/json", "User-Agent": "skillwiki-workspace-login", ...init.headers } }, this.request);
  }
  async finish(store: WorkspaceStore, state: string, binding: string, code: string): Promise<GitHubIdentity & { next: string }> {
    const { verifier, next } = store.finishLogin(state, binding);
    if (!code || code.length > 1024) throw new WorkspaceError("GITHUB_LOGIN_FAILED");
    const result = await this.json("https://github.com/login/oauth/access_token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: `${this.issuer}/auth/github/callback`, code_verifier: verifier }).toString() });
    if (result.error || typeof result.access_token !== "string" || result.token_type !== "bearer") throw new WorkspaceError("GITHUB_LOGIN_FAILED");
    const user = await this.json("https://api.github.com/user", { headers: { Authorization: `Bearer ${result.access_token}`, "X-GitHub-Api-Version": "2022-11-28" } });
    if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.login !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(user.login)) throw new WorkspaceError("GITHUB_IDENTITY_INVALID");
    // The provider access token is intentionally never persisted or returned.
    return { id: String(user.id), login: user.login, next };
  }
  async lookup(login: string): Promise<GitHubIdentity> {
    if (!/^[a-zA-Z0-9-]{1,39}$/.test(login)) throw new WorkspaceError("INVALID_GITHUB_LOGIN");
    const user = await this.json(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { "X-GitHub-Api-Version": "2022-11-28" } });
    if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.login !== "string" || user.type !== "User") throw new WorkspaceError("GITHUB_IDENTITY_INVALID");
    return { id: String(user.id), login: user.login };
  }
}
