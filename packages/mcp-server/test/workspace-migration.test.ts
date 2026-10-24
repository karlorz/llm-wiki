import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/workspace-store.js";
import { applyWorkspaceMigration, rollbackWorkspaceMigration } from "../src/workspace-migration.js";
import { describe, expect, it } from "vitest";
import { planWorkspaceMigration, verifyWorkspaceMigrationPlan } from "../src/workspace-migration.js";
const wiki = (vaultId: string) => ({ vaultId, workspaceName: vaultId, ownerGithubId: "11", localRoot: `/isolated/${vaultId}`, rcloneRemote: "storage", rclonePath: `bucket/${vaultId}`, s3Bucket: "bucket", s3Prefix: vaultId, liveAccessVerified: vaultId === "central", fullInventoryReviewed: false, directAccessReviewed: false, writers: [], credentialMetadataReviewed: false });
describe("operator migration planning", () => {
  it("keeps both inventories pending, distinguishes central live proof and does not select a pilot", () => {
    const plan = planWorkspaceMigration({ version: 1, deploymentRevision: "test-revision", wikis: [wiki("wiki-fin"), wiki("central")] });
    expect(plan.productionMutation).toBe(false); expect(plan.pilot).toBe("not-selected");
    expect(plan.wikis.every(w => w.status === "blocked")).toBe(true);
    expect(plan.wikis[0].blockers).not.toContain("live access not verified"); expect(plan.wikis[1].blockers).toContain("live access not verified");
    expect(plan.wikis.every(w => w.blockers.includes("full writer/storage inventory pending"))).toBe(true);
  });
  it("detects reviewed-plan drift and rejects overlapping bindings/secrets", () => {
    const input = { version: 1, deploymentRevision: "revision", wikis: [wiki("central"), wiki("wiki-fin")] };
    const plan = planWorkspaceMigration(input); expect(verifyWorkspaceMigrationPlan(input, plan.planSha256)).toEqual(plan);
    expect(() => verifyWorkspaceMigrationPlan({ ...input, deploymentRevision: "changed" }, plan.planSha256)).toThrow("MIGRATION_PLAN_DRIFT");
    expect(() => planWorkspaceMigration({ ...input, wikis: [wiki("central"), { ...wiki("wiki-fin"), localRoot: "/isolated/central/finance" }] })).toThrow("overlap");
    expect(() => planWorkspaceMigration({ ...input, token: "must-not-collect" })).toThrow();
  });
  it("applies one in-place binding idempotently and rolls back without reviving grants or deleting state",()=>{
    const w={...wiki("central"),ownerLogin:"alice",liveAccessVerified:true,fullInventoryReviewed:true,directAccessReviewed:true,credentialMetadataReviewed:true,writers:["mcp"],contentManifestSha256:"a".repeat(64),backupSha256:"b".repeat(64),restoreProofSha256:"c".repeat(64)};
    const input={version:1,deploymentRevision:"pinned",wikis:[w]},plan=planWorkspaceMigration(input),dir=mkdtempSync(join(tmpdir(),"migration-control-"));
    const first=applyWorkspaceMigration(input,plan.planSha256,dir,"central");const again=applyWorkspaceMigration(input,plan.planSha256,dir,"central");expect(again.id).toBe(first.id);
    let store=new WorkspaceStore(dir);expect(store.view("11",first.id).workspace.vaultId).toBe("central");expect(store.snapshot().grants).toEqual([]);expect(store.snapshot().sessions).toEqual([]);
    const verifier="v".repeat(43);
    const code=store.consent("11",{workspace:first.id,client:"fixture",name:"proof",actions:["read"],offline:true,expires:Date.now()+60000,redirect:"http://localhost/callback",challenge:createHash("sha256").update(verifier).digest("base64url")});
    const tokens=store.exchange({kind:"code",secret:code,client:"fixture",redirect:"http://localhost/callback",verifier});
    expect(store.resolveAccess(tokens.access_token)).not.toBeNull();store.close();
    rollbackWorkspaceMigration(input,plan.planSha256,dir,"central");store=new WorkspaceStore(dir);expect(store.snapshot().workspaces[0].state).toBe("archived");expect(store.snapshot().members).toHaveLength(1);
    expect(store.resolveAccess(tokens.access_token)).toBeNull();
    expect(()=>store.exchange({kind:"refresh",secret:tokens.refresh_token!,client:"fixture"})).toThrow("INVALID_GRANT");store.close();
    expect(()=>applyWorkspaceMigration(input,plan.planSha256,dir,"central")).toThrow("ROLLED_BACK");
  });
  it("does not apply a blocked or drifted plan and respects an active daemon lock",()=>{
    const input={version:1,deploymentRevision:"pinned",wikis:[wiki("central")]},plan=planWorkspaceMigration(input),dir=mkdtempSync(join(tmpdir(),"migration-blocked-"));
    expect(()=>applyWorkspaceMigration(input,plan.planSha256,dir,"central")).toThrow("NOT_READY");
    expect(()=>applyWorkspaceMigration(input,"f".repeat(64),dir,"central")).toThrow("DRIFT");
    const ready={...input,wikis:[{...wiki("central"),ownerLogin:"alice",liveAccessVerified:true,fullInventoryReviewed:true,directAccessReviewed:true,credentialMetadataReviewed:true,writers:["mcp"],contentManifestSha256:"a".repeat(64),backupSha256:"b".repeat(64),restoreProofSha256:"c".repeat(64)}]};
    const daemon=new WorkspaceStore(dir);
    try {expect(()=>applyWorkspaceMigration(ready,planWorkspaceMigration(ready).planSha256,dir,"central")).toThrow("CONTROL_PLANE_LOCKED");expect(daemon.snapshot().workspaces).toHaveLength(0);} finally {daemon.close();}
  });

});
