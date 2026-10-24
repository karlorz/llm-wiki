import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore, workspaceSecret } from "../src/workspace-store.js";
const stores: WorkspaceStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workspace-store-")); let now = Date.now();
  const s = new WorkspaceStore(dir, () => now); stores.push(s);
  const a = s.login({ id: "11", login: "alice" }), b = s.login({ id: "22", login: "bob" });
  s.allowCreation("11", true); s.allowCreation("22", true);
  const w = s.create("11", "Alpha", "alpha", workspaceSecret());
  s.transition(w.operation, "provisioning"); s.transition(w.operation, "verifying"); s.transition(w.operation, "active");
  return { s, dir, w, a, b, advance: (ms: number) => { now += ms; } };
}
function grant(s: WorkspaceStore, workspace: string) {
  const verifier = workspaceSecret();
  const code = s.consent("11", { workspace, client: "client", name: "Test client", actions: ["read", "write"], offline: true, expires: Date.now() + 86400_000, redirect: "http://127.0.0.1/cb", challenge: createHash("sha256").update(verifier).digest("base64url") });
  return s.exchange({ kind: "code", secret: code, client: "client", redirect: "http://127.0.0.1/cb", verifier });
}
describe("workspace control plane", () => {
  it("login creates identity only and does not expose other workspaces", () => { const { s } = fixture(); expect(s.visible("22")).toEqual([]); expect(() => s.view("22", s.visible("11")[0].id)).toThrow("ACCESS_DENIED"); expect(s.snapshot().grants).toEqual([]); });
  it("requires allowance, reserves one operation, rejects conflicting replay and concurrent create", () => {
    const { s } = fixture(); s.login({ id: "33", login: "charlie" });
    expect(() => s.create("33", "C", "charlie", workspaceSecret())).toThrow("CREATION_UNAVAILABLE");
    const key = workspaceSecret(), w = s.create("22", "Beta", "beta", key);
    expect(s.create("22", "Beta", "beta", key)).toEqual(w);
    expect(() => s.create("22", "Changed", "beta", key)).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => s.create("22", "Other", "other", workspaceSecret())).toThrow("CREATION_UNAVAILABLE");
    expect(s.visible("22")).toEqual([]); expect(s.snapshot().members.filter(m => m.workspace === w.id)).toEqual([]);
  });
  it("persists failed operations across restart and activates owner atomically", () => {
    const { s, dir } = fixture(); const w = s.create("22", "Beta", "beta", workspaceSecret());
    s.transition(w.operation, "provisioning"); s.transition(w.operation, "failed", "test");
    s.close(); stores.splice(stores.indexOf(s), 1); const reopened = new WorkspaceStore(dir); stores.push(reopened);
    expect(reopened.operation("22", w.operation).state).toBe("failed");
    reopened.transition(w.operation, "provisioning"); reopened.transition(w.operation, "verifying"); reopened.transition(w.operation, "active");
    expect(reopened.view("22", w.id).role).toBe("owner"); expect(reopened.snapshot().members.filter(m => m.workspace === w.id)).toHaveLength(1);
  });
  it("requires exact invitation identity, current workspace and single acceptance", () => {
    const { s, w } = fixture(); s.invite("11", w.id, { id: "22", login: "bob" }, "viewer", Date.now() + 10000);
    const invitation = s.snapshot().invitations[0].id;
    expect(() => s.accept("11", invitation)).toThrow(); s.accept("22", invitation);
    expect(s.view("22", w.id).role).toBe("viewer"); expect(() => s.accept("22", invitation)).toThrow();
    expect(() => s.changeRole("22", w.id, "11", "remove")).toThrow();
    expect(() => s.changeRole("11", w.id, "11", "remove")).toThrow("LAST_OWNER");
  });
  it("isolates credentials, shrinks grants on demotion and never expands after promotion", () => {
    const { s, w } = fixture(); const tokens = grant(s, w.id);
    expect(s.resolveAccess(tokens.access_token)?.workspace.id).toBe(w.id);
    s.invite("11", w.id, { id: "22", login: "bob" }, "owner", Date.now() + 10000); s.accept("22", s.snapshot().invitations[0].id);
    s.changeRole("22", w.id, "11", "viewer"); expect(s.resolveAccess(tokens.access_token)?.grant.actions).toEqual(["read"]);
    s.changeRole("22", w.id, "11", "owner"); expect(s.resolveAccess(tokens.access_token)?.grant.actions).toEqual(["read"]);
    s.changeRole("22", w.id, "11", "remove"); expect(s.resolveAccess(tokens.access_token)).toBeNull();
    expect(() => s.exchange({ kind: "refresh", secret: tokens.refresh_token!, client: "client" })).toThrow();
  });
  it("binds exchange to client and revokes the whole grant on refresh replay", () => {
    const { s, w } = fixture(); const tokens = grant(s, w.id);
    expect(() => s.exchange({ kind: "refresh", secret: tokens.refresh_token!, client: "wrong" })).toThrow();
    const next = s.exchange({ kind: "refresh", secret: tokens.refresh_token!, client: "client" });
    expect(s.resolveAccess(next.access_token)).not.toBeNull();
    expect(() => s.exchange({ kind: "refresh", secret: tokens.refresh_token!, client: "client" })).toThrow();
    expect(s.resolveAccess(next.access_token)).toBeNull(); expect(s.resolveAccess(tokens.access_token)).toBeNull();
  });
  it("rejects expired sessions/tokens and archived workspaces", () => { const { s, w, a, advance } = fixture(); const t = grant(s, w.id); s.archive("11", w.id); expect(s.resolveAccess(t.access_token)).toBeNull(); advance(9 * 3600_000); expect(s.session(a)).toBeNull(); });
  it("expires codes, access and refresh without falling back to legacy credentials", () => {
    const { s, w, advance } = fixture(); const tokens = grant(s, w.id);
    const verifier = workspaceSecret();
    const code = s.consent("11", { workspace: w.id, client: "late", name: "Late", actions: ["read"], expires: Date.now() + 86400_000, redirect: "http://127.0.0.1/cb", challenge: createHash("sha256").update(verifier).digest("base64url") });
    advance(3601_000); expect(s.resolveAccess(tokens.access_token)).toBeNull();
    expect(() => s.exchange({ kind: "code", secret: code, client: "late", redirect: "http://127.0.0.1/cb", verifier })).toThrow();
    advance(86400_000); expect(() => s.exchange({ kind: "refresh", secret: tokens.refresh_token!, client: "client" })).toThrow();
  });
  it("fails closed on corrupt storage and a second writer", () => {
    const { s, dir } = fixture(); expect(() => new WorkspaceStore(dir)).toThrow("CONTROL_PLANE_LOCKED");
    writeFileSync(join(dir, "workspaces.json"), "{corrupt"); expect(() => s.snapshot()).toThrow();
    expect(readFileSync(join(dir, "workspaces.json"), "utf8")).toBe("{corrupt");
  });
  it("allows role-capped personal consent, private views and self/Owner revocation", () => {
    const { s, w } = fixture(); const owner = grant(s, w.id);
    s.invite("11", w.id, { id: "22", login: "bob" }, "viewer", Date.now() + 10000); s.accept("22", s.snapshot().invitations[0].id);
    const issue = (actions: Array<"read" | "write">) => {
      const verifier = workspaceSecret();
      const code = s.consent("22", { workspace: w.id, client: "member", name: "Personal", actions, offline: true, expires: Date.now() + 10000, redirect: "http://127.0.0.1/cb", challenge: createHash("sha256").update(verifier).digest("base64url") });
      return s.exchange({ kind: "code", secret: code, client: "member", verifier, redirect: "http://127.0.0.1/cb" });
    };
    expect(() => issue(["write"])).toThrow("INVALID_CONSENT");
    const read = issue(["read"]); expect(s.resolveAccess(read.access_token)?.grant.user).toBe("22");
    expect(s.view("22", w.id).grants).toHaveLength(1);
    const ownerGrant = s.resolveAccess(owner.access_token)!.grant.id;
    expect(() => s.revoke("22", w.id, ownerGrant)).toThrow();
    s.revoke("22", w.id, s.resolveAccess(read.access_token)!.grant.id); expect(s.resolveAccess(read.access_token)).toBeNull();
    s.changeRole("11", w.id, "22", "editor"); const editor = issue(["read", "write"]);
    s.changeRole("11", w.id, "22", "viewer"); s.changeRole("11", w.id, "22", "editor");
    expect(s.exchange({ kind: "refresh", client: "member", secret: editor.refresh_token! }).scope).not.toContain("write");
    const fresh = issue(["read", "write"]); s.revoke("11", w.id, s.resolveAccess(fresh.access_token)!.grant.id);
    expect(s.resolveAccess(fresh.access_token)).toBeNull(); expect(s.resolveAccess(owner.access_token)).not.toBeNull();
  });
  it("persists suspension denial across restart without reviving old grants", () => {
    const { s, w, dir, a } = fixture(); const tokens = grant(s, w.id); s.suspendAccount("11", true);
    s.close(); stores.splice(stores.indexOf(s), 1); const reopened = new WorkspaceStore(dir); stores.push(reopened);
    expect(reopened.session(a)).toBeNull(); expect(reopened.resolveAccess(tokens.access_token)).toBeNull();
    expect(() => reopened.exchange({ kind: "refresh", secret: tokens.refresh_token!, client: "client" })).toThrow();
    reopened.suspendAccount("11", false); expect(reopened.resolveAccess(tokens.access_token)).toBeNull();
  });
  it("binds login state to browser and consumes it once", () => { const { s } = fixture(); const f = s.beginLogin(); expect(() => s.finishLogin(f.state, "wrong")).toThrow(); expect(s.finishLogin(f.state, f.binding).verifier).toBe(f.verifier); expect(() => s.finishLogin(f.state, f.binding)).toThrow(); });
});
