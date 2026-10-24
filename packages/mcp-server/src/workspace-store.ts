import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const id = z.string().min(1);
const githubId = z.string().regex(/^[1-9][0-9]*$/);
const role = z.enum(["owner", "editor", "viewer"]);
const action = z.enum(["read", "write"]);
const userSchema = z.object({ id: githubId, login: id, suspended: z.boolean(), creationAllowed: z.boolean() }).strict();
const workspaceSchema = z.object({
  id, vaultId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/), creator: githubId, name: id,
  origin: z.enum(["native", "legacy"]).default("native"),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
  state: z.enum(["draft", "provisioning", "verifying", "active", "failed", "archived"]),
  step: z.enum(["reserved", "initialized", "verified"]),
  operation: id, key: id, error: z.string().optional(),
}).strict();
const membershipSchema = z.object({ workspace: id, user: githubId, role }).strict();
const invitationSchema = z.object({ id, workspace: id, user: githubId, login: id, role, expires: z.number(), state: z.enum(["pending", "accepted", "cancelled"]) }).strict();
const grantSchema = z.object({ id, workspace: id, user: githubId, client: id, name: id, actions: z.array(action).min(1), offline: z.boolean(), expires: z.number(), revoked: z.boolean() }).strict();
const credentialSchema = z.object({ hash: id, kind: z.enum(["code", "access", "refresh"]), grant: id, expires: z.number(), used: z.boolean(), challenge: z.string().optional(), redirect: z.string().optional() }).strict();
const sessionSchema = z.object({ hash: id, user: githubId, csrf: id, expires: z.number() }).strict();
const loginSchema = z.object({ hash: id, binding: id, verifier: id, next: id, expires: z.number() }).strict();
const stateSchema = z.object({
  version: z.literal(1), users: z.array(userSchema), workspaces: z.array(workspaceSchema),
  members: z.array(membershipSchema), invitations: z.array(invitationSchema), grants: z.array(grantSchema),
  credentials: z.array(credentialSchema), sessions: z.array(sessionSchema), logins: z.array(loginSchema),
  audit: z.array(z.object({ at: z.number(), workspace: id, actor: id, event: id }).strict()),
}).strict();
export type WorkspaceState = z.infer<typeof stateSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceRole = z.infer<typeof role>;
export type WorkspaceAction = z.infer<typeof action>;
export type WorkspaceGrant = z.infer<typeof grantSchema>;
export const workspaceHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const workspaceSecret = (): string => randomBytes(32).toString("base64url");

/** Windows does not support opening directories for fsync; file fsync still applies. */
export function syncWorkspaceDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class WorkspaceError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function requireValue<T>(value: T | undefined | null, code = "ACCESS_DENIED"): T {
  if (value === undefined || value === null) throw new WorkspaceError(code);
  return value;
}
export function roleActions(value: WorkspaceRole): WorkspaceAction[] { return value === "viewer" ? ["read"] : ["read", "write"]; }
function canCreate(s: WorkspaceState, user: string): boolean {
  return s.users.some(u => u.id === user && !u.suspended && u.creationAllowed)
    && !s.workspaces.some(w => w.creator === user && w.state !== "archived")
    && !s.members.some(m => m.user === user && m.role === "owner" && s.workspaces.some(w => w.id === m.workspace && w.state === "active"));
}

/** One daemon owns this control plane. Never reset unreadable/corrupt state to empty. */
export class WorkspaceStore {
  private readonly file: string;
  private readonly lock: string;
  private readonly lockId = randomUUID();
  private closed = false;
  constructor(directory: string, private readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "workspaces.json");
    this.lock = join(directory, "workspaces.lock");
    // Do not reclaim automatically: two simultaneous crash-recovery attempts
    // could otherwise unlink the new owner's lock. Offline recovery is attended.
    if (existsSync(this.lock)) {
      throw new WorkspaceError("CONTROL_PLANE_LOCKED");
    }
    const fd = openSync(this.lock, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), id: this.lockId })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { if (!existsSync(this.file)) this.save({ version: 1, users: [], workspaces: [], members: [], invitations: [], grants: [], credentials: [], sessions: [], logins: [], audit: [] }); this.snapshot(); }
    catch (error) { this.close(); throw error; }
  }
  close(): void {
    if (this.closed) return;
    if (JSON.parse(readFileSync(this.lock, "utf8")).id !== this.lockId) throw new WorkspaceError("LOCK_OWNER_CHANGED");
    unlinkSync(this.lock); this.closed = true;
  }
  snapshot(): WorkspaceState {
    if (this.closed) throw new WorkspaceError("STORE_CLOSED");
    const state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    for (const w of state.workspaces) {
      if (w.state === "active" && !state.members.some(m => m.workspace === w.id && m.role === "owner")) throw new WorkspaceError("OWNERLESS_WORKSPACE");
    }
    return state;
  }
  private save(state: WorkspaceState): void {
    stateSchema.parse(state);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
    syncWorkspaceDirectory(dirname(this.file));
  }
  private transaction<T>(run: (state: WorkspaceState) => T): T {
    const state = this.snapshot(); const result = run(state); this.save(state); return result;
  }
  private event(s: WorkspaceState, workspace: string, actor: string, event: string): void { s.audit.push({ at: this.now(), workspace, actor, event }); }
  private member(s: WorkspaceState, user: string, workspace: string, owner = false) {
    const account = requireValue(s.users.find(u => u.id === user && !u.suspended));
    const w = requireValue(s.workspaces.find(w => w.id === workspace && w.state === "active"));
    const m = requireValue(s.members.find(m => m.workspace === workspace && m.user === account.id && (!owner || m.role === "owner")));
    return { w, m };
  }
  login(identity: { id: string; login: string }): string {
    githubId.parse(identity.id); id.parse(identity.login);
    return this.transaction(s => {
      let user = s.users.find(u => u.id === identity.id);
      if (!user) { user = { ...identity, suspended: false, creationAllowed: false }; s.users.push(user); }
      if (user.suspended) throw new WorkspaceError("ACCOUNT_SUSPENDED");
      user.login = identity.login;
      const secret = `sws_${workspaceSecret()}`;
      s.sessions.push({ hash: workspaceHash(secret), user: user.id, csrf: workspaceSecret(), expires: this.now() + 8 * 3600_000 });
      return secret;
    });
  }
  session(secret: string | undefined) {
    const s = this.snapshot();
    const session = s.sessions.find(x => x.hash === workspaceHash(secret ?? "") && x.expires > this.now());
    if (!session || !s.users.some(u => u.id === session.user && !u.suspended)) return null;
    return session;
  }
  logout(secret: string): void { this.transaction(s => { s.sessions = s.sessions.filter(x => x.hash !== workspaceHash(secret)); }); }
  allowCreation(user: string, allowed: boolean): void { this.transaction(s => { requireValue(s.users.find(u => u.id === user)).creationAllowed = allowed; }); }
  suspendAccount(user: string, suspended: boolean): void {
    this.transaction(s => {
      requireValue(s.users.find(u => u.id === user)).suspended = suspended;
      if (suspended) {
        s.sessions = s.sessions.filter(session => session.user !== user);
        s.grants.filter(g => g.user === user).forEach(g => { g.revoked = true; });
      }
    });
  }
  beginLogin(next = "/admin") {
    return this.transaction(s => {
      s.logins = s.logins.filter(x => x.expires > this.now());
      const state = workspaceSecret(), binding = workspaceSecret(), verifier = workspaceSecret();
      s.logins.push({ hash: workspaceHash(state), binding: workspaceHash(binding), verifier, next, expires: this.now() + 600_000 });
      return { state, binding, verifier };
    });
  }
  finishLogin(state: string, binding: string): { verifier: string; next: string } {
    return this.transaction(s => {
      const entry = requireValue(s.logins.find(x => x.hash === workspaceHash(state) && x.binding === workspaceHash(binding) && x.expires > this.now()), "LOGIN_STATE_INVALID");
      s.logins = s.logins.filter(x => x !== entry); return { verifier: entry.verifier, next: entry.next };
    });
  }
  create(user: string, name: string, slug: string, key: string): Workspace {
    if (!name.trim() || name.length > 80 || !/^[a-z][a-z0-9-]{1,47}$/.test(slug) || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new WorkspaceError("INVALID_WORKSPACE");
    return this.transaction(s => {
      const account = requireValue(s.users.find(u => u.id === user && !u.suspended));
      const existing = s.workspaces.find(w => w.creator === user && w.key === key);
      if (existing) {
        if (existing.name !== name.trim() || existing.slug !== slug) throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        return existing;
      }
      if (!canCreate(s, account.id)) throw new WorkspaceError("CREATION_UNAVAILABLE");
      if (s.workspaces.some(w => w.slug === slug)) throw new WorkspaceError("SLUG_UNAVAILABLE");
      const w: Workspace = { id: randomUUID(), vaultId: `v-${randomBytes(16).toString("hex")}`, origin: "native", creator: user, name: name.trim(), slug, state: "draft", step: "reserved", operation: randomUUID(), key };
      s.workspaces.push(w); this.event(s, w.id, user, "workspace-requested"); return w;
    });
  }
  bindNativeStorage(operation: string, bindingHash: string): Workspace {
    if (!/^[a-f0-9]{64}$/.test(bindingHash)) throw new WorkspaceError("INVALID_STORAGE_BINDING");
    return this.transaction(s => {
      const w = requireValue(s.workspaces.find(w => w.operation === operation && w.origin === "native"));
      if (w.bindingHash && w.bindingHash !== bindingHash) throw new WorkspaceError("STORAGE_BINDING_DRIFT");
      if (!w.bindingHash && (w.state === "active" || w.state === "archived")) throw new WorkspaceError("STORAGE_BINDING_MISSING");
      w.bindingHash = bindingHash;
      return w;
    });
  }
  /** Offline operator plane only. Never called from sign-in or a web endpoint. */
  importLegacy(planHash: string, input: { vaultId: string; name: string; slug: string; ownerId: string; ownerLogin: string; bindingHash: string }): Workspace {
    if (!/^[a-f0-9]{64}$/.test(planHash) || !/^[a-z][a-z0-9-]{1,62}$/.test(input.vaultId) || !/^[a-z][a-z0-9-]{1,47}$/.test(input.slug) || !/^[a-f0-9]{64}$/.test(input.bindingHash)) throw new WorkspaceError("INVALID_MIGRATION");
    githubId.parse(input.ownerId); id.parse(input.ownerLogin); id.parse(input.name);
    return this.transaction(s => {
      const key = `${planHash}:${input.vaultId}`;
      const existing = s.workspaces.find(w => w.vaultId === input.vaultId);
      if (existing) {
        if (existing.origin !== "legacy" || existing.key !== key || existing.bindingHash !== input.bindingHash || existing.creator !== input.ownerId || existing.name !== input.name || existing.slug !== input.slug) throw new WorkspaceError("MIGRATION_CONFLICT");
        if (existing.state !== "active") throw new WorkspaceError("MIGRATION_ALREADY_ROLLED_BACK");
        return existing;
      }
      if (s.workspaces.some(w => w.slug === input.slug)) throw new WorkspaceError("SLUG_UNAVAILABLE");
      let owner = s.users.find(u => u.id === input.ownerId);
      if (owner?.suspended) throw new WorkspaceError("ACCOUNT_SUSPENDED");
      if (!owner) { owner = { id: input.ownerId, login: input.ownerLogin, suspended: false, creationAllowed: false }; s.users.push(owner); }
      const w: Workspace = { id: randomUUID(), vaultId: input.vaultId, creator: owner.id, origin: "legacy", bindingHash: input.bindingHash, name: input.name, slug: input.slug, state: "active", step: "verified", operation: randomUUID(), key };
      s.workspaces.push(w); s.members.push({workspace:w.id,user:owner.id,role:"owner"});
      this.event(s,w.id,"deployment-operator",`legacy-bound-${planHash}`); return w;
    });
  }
  rollbackLegacy(planHash: string, vaultId: string): void {
    this.transaction(s => {
      const w = requireValue(s.workspaces.find(w => w.origin === "legacy" && w.key === `${planHash}:${vaultId}`), "MIGRATION_UNKNOWN");
      w.state = "archived"; s.grants.filter(g => g.workspace === w.id).forEach(g => { g.revoked = true; });
      this.event(s,w.id,"deployment-operator","legacy-binding-rolled-back-content-preserved");
    });
  }
  operation(user: string, operation: string): Workspace {
    const s = this.snapshot();
    requireValue(s.users.find(u => u.id === user && !u.suspended));
    return requireValue(s.workspaces.find(w => w.operation === operation && w.creator === user));
  }
  transition(operation: string, state: "provisioning" | "verifying" | "active" | "failed", error?: string): void {
    this.transaction(s => {
      const w = requireValue(s.workspaces.find(w => w.operation === operation));
      if (w.state === "active" || w.state === "archived") throw new WorkspaceError("INVALID_TRANSITION");
      const valid = state === "failed" || (state === "provisioning" && ["draft", "failed", "provisioning", "verifying"].includes(w.state)) || (state === "verifying" && (w.state === "provisioning" || (w.step === "initialized" && ["failed", "verifying"].includes(w.state)))) || (state === "active" && w.state === "verifying");
      if (!valid) throw new WorkspaceError("INVALID_TRANSITION");
      if (state !== "failed") requireValue(s.users.find(u => u.id === w.creator && !u.suspended));
      if (state === "active") {
        const creator = requireValue(s.users.find(u => u.id === w.creator && u.creationAllowed));
        if (s.members.some(m => m.user === creator.id && m.role === "owner" && s.workspaces.some(other => other.id === m.workspace && other.state === "active"))) throw new WorkspaceError("CREATION_UNAVAILABLE");
        // Membership and active state are persisted by the same atomic rename.
        s.members.push({ workspace: w.id, user: w.creator, role: "owner" });
        w.step = "verified";
      }
      if (state === "verifying") w.step = "initialized";
      w.state = state; w.error = error; this.event(s, w.id, w.creator, `provisioning-${state}`);
    });
  }
  visible(user: string) {
    const s = this.snapshot(); requireValue(s.users.find(u => u.id === user && !u.suspended));
    return s.workspaces.filter(w => w.state === "active" && s.members.some(m => m.workspace === w.id && m.user === user));
  }
  creationEligible(user: string): boolean {
    return canCreate(this.snapshot(), user);
  }
  view(user: string, workspace: string) {
    const s = this.snapshot(); const { w, m } = this.member(s, user, workspace);
    return { workspace: w, role: m.role, members: s.members.filter(x => x.workspace === workspace).map(x => ({ ...x, login: s.users.find(u => u.id === x.user)?.login ?? x.user })),
      invitations: m.role === "owner" ? s.invitations.filter(x => x.workspace === workspace) : [],
      grants: s.grants.filter(x => x.workspace === workspace && (m.role === "owner" || x.user === user)),
      audit: m.role === "owner" ? s.audit.filter(x => x.workspace === workspace) : [] };
  }
  invite(owner: string, workspace: string, target: { id: string; login: string }, value: WorkspaceRole, expires: number): void {
    githubId.parse(target.id); role.parse(value);
    if (expires <= this.now()) throw new WorkspaceError("INVALID_EXPIRY");
    this.transaction(s => {
      this.member(s, owner, workspace, true);
      s.invitations.push({ id: randomUUID(), workspace, user: target.id, login: target.login, role: value, expires, state: "pending" });
      this.event(s, workspace, owner, `invited-${target.id}-${value}`);
    });
  }
  accept(user: string, invitation: string): void {
    this.transaction(s => {
      requireValue(s.users.find(u => u.id === user && !u.suspended));
      const invite = requireValue(s.invitations.find(i => i.id === invitation && i.user === user && i.state === "pending" && i.expires > this.now()));
      requireValue(s.workspaces.find(w => w.id === invite.workspace && w.state === "active"));
      if (s.members.some(m => m.user === user && m.workspace === invite.workspace)) throw new WorkspaceError("ALREADY_MEMBER");
      s.members.push({ workspace: invite.workspace, user, role: invite.role }); invite.state = "accepted";
      this.event(s, invite.workspace, user, "invitation-accepted");
    });
  }
  cancelInvite(owner: string, workspace: string, invitation: string): void {
    this.transaction(s => { this.member(s, owner, workspace, true); requireValue(s.invitations.find(i => i.workspace === workspace && i.id === invitation && i.state === "pending")).state = "cancelled"; this.event(s, workspace, owner, "invitation-cancelled"); });
  }
  changeRole(owner: string, workspace: string, user: string, value: WorkspaceRole | "remove"): void {
    if (value !== "remove") role.parse(value);
    this.transaction(s => {
      this.member(s, owner, workspace, true);
      const m = requireValue(s.members.find(x => x.workspace === workspace && x.user === user));
      if (m.role === "owner" && value !== "owner" && s.members.filter(x => x.workspace === workspace && x.role === "owner").length < 2) throw new WorkspaceError("LAST_OWNER");
      if (value === "remove") s.members = s.members.filter(x => x !== m); else m.role = value;
      // Shrink existing grants permanently. Re-promotion/re-invitation never revives them.
      for (const g of s.grants.filter(x => x.workspace === workspace && x.user === user)) {
        if (value === "remove") g.revoked = true;
        else {
          const reduced = g.actions.filter(a => roleActions(value).includes(a));
          if (!reduced.length) g.revoked = true; else g.actions = reduced;
        }
      }
      this.event(s, workspace, owner, `membership-${user}-${value}`);
    });
  }
  archive(owner: string, workspace: string): void {
    this.transaction(s => {
      const { w } = this.member(s, owner, workspace, true); w.state = "archived";
      s.grants.filter(g => g.workspace === workspace).forEach(g => { g.revoked = true; });
      this.event(s, workspace, owner, "workspace-archived");
    });
  }
  private authorized(s: WorkspaceState, grantId: string): WorkspaceGrant {
    const g = requireValue(s.grants.find(g => g.id === grantId && !g.revoked && g.expires > this.now()));
    const { m } = this.member(s, g.user, g.workspace);
    if (!g.actions.some(a => roleActions(m.role).includes(a))) throw new WorkspaceError("ACCESS_DENIED");
    return { ...g, actions: g.actions.filter(a => roleActions(m.role).includes(a)) };
  }
  authorizeGrant(grant: string): WorkspaceGrant { return this.authorized(this.snapshot(), grant); }
  consent(user: string, input: { workspace: string; client: string; name: string; actions: WorkspaceAction[]; offline?: boolean; expires: number; redirect: string; challenge: string }): string {
    return this.transaction(s => {
      const { m } = this.member(s, user, input.workspace);
      if (!input.actions.length || input.actions.some(a => !roleActions(m.role).includes(a)) || input.expires <= this.now() || !/^[a-zA-Z0-9_-]{43}$/.test(input.challenge)) throw new WorkspaceError("INVALID_CONSENT");
      const g: WorkspaceGrant = { id: randomUUID(), workspace: input.workspace, user, client: input.client, name: input.name, actions: [...new Set(input.actions)], offline: input.offline === true, expires: input.expires, revoked: false };
      s.grants.push(g); const code = `swc_${workspaceSecret()}`;
      s.credentials.push({ hash: workspaceHash(code), kind: "code", grant: g.id, expires: this.now() + 300_000, used: false, redirect: input.redirect, challenge: input.challenge });
      this.event(s, g.workspace, user, `consented-${g.id}`); return code;
    });
  }
  revoke(user: string, workspace: string, grant: string): void {
    this.transaction(s => {
      const { m } = this.member(s, user, workspace);
      const g = requireValue(s.grants.find(g => g.workspace === workspace && g.id === grant && (m.role === "owner" || g.user === user)));
      g.revoked = true; this.event(s, workspace, user, `grant-revoked-${grant}`);
    });
  }
  exchange(input: { kind: "code" | "refresh"; secret: string; client: string; redirect?: string; verifier?: string }) {
    // Return errors rather than throw inside the transaction: replay revocation must persist.
    const result = this.transaction(s => {
      const c = s.credentials.find(c => c.hash === workspaceHash(input.secret) && c.kind === input.kind);
      if (!c) return null;
      const rawGrant = requireValue(s.grants.find(g => g.id === c.grant));
      if (c.used) { if (c.kind === "refresh") { rawGrant.revoked = true; this.event(s, rawGrant.workspace, rawGrant.user, "refresh-replay-revoked"); } return null; }
      let grant: WorkspaceGrant;
      try { grant = this.authorized(s, c.grant); } catch { return null; }
      if (c.expires <= this.now() || grant.client !== input.client) return null;
      if (c.kind === "refresh" && !grant.offline) return null;
      if (c.kind === "code" && (c.redirect !== input.redirect || !input.verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) || createHash("sha256").update(input.verifier).digest("base64url") !== c.challenge)) return null;
      c.used = true;
      const access = `sw_${workspaceSecret()}`, refresh = `swr_${workspaceSecret()}`;
      s.credentials.push({ hash: workspaceHash(access), kind: "access", grant: grant.id, expires: Math.min(grant.expires, this.now() + 3600_000), used: false });
      if (grant.offline) s.credentials.push({ hash: workspaceHash(refresh), kind: "refresh", grant: grant.id, expires: grant.expires, used: false });
      return { access_token: access, ...(grant.offline ? { refresh_token: refresh } : {}), token_type: "Bearer", expires_in: Math.min(3600, Math.floor((grant.expires - this.now()) / 1000)), scope: [...grant.actions.map(a => `wiki:${a}`), ...(grant.offline ? ["offline_access"] : [])].join(" ") };
    });
    if (!result) throw new WorkspaceError("INVALID_GRANT"); return result;
  }
  resolveAccess(secret: string): { grant: WorkspaceGrant; workspace: Workspace } | null {
    try {
      const s = this.snapshot();
      const c = s.credentials.find(c => c.hash === workspaceHash(secret) && c.kind === "access" && c.expires > this.now());
      if (!c) return null;
      const grant = this.authorized(s, c.grant);
      return { grant, workspace: requireValue(s.workspaces.find(w => w.id === grant.workspace)) };
    } catch { return null; }
  }
}
