import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { workspaceHash, WorkspaceError, WorkspaceStore, syncWorkspaceDirectory } from "./workspace-store.js";
import { buildVaultRegistry } from "./vault-registry.js";
import { workspaceBindingHash } from "./workspace-binding.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const mapping = z.object({
  vaultId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  workspaceName: z.string().min(1), ownerGithubId: z.string().regex(/^[1-9][0-9]*$/),
  ownerLogin: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
  workspaceSlug: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/).optional(),
  s3Endpoint: z.string().url().optional(), s3Region: z.string().optional(),
  localRoot: z.string().min(1), rcloneRemote: z.string().min(1), rclonePath: z.string().min(1),
  s3Bucket: z.string().min(1), s3Prefix: z.string().min(1),
  liveAccessVerified: z.boolean(), fullInventoryReviewed: z.boolean(), directAccessReviewed: z.boolean(),
  writers: z.array(z.string().min(1)), credentialMetadataReviewed: z.boolean(),
  contentManifestSha256: digest.optional(), backupSha256: digest.optional(), restoreProofSha256: digest.optional(),
}).strict();
const inventory = z.object({ version: z.literal(1), deploymentRevision: z.string().min(1), wikis: z.array(mapping).min(1) }).strict();
export type WorkspaceMigrationInventory = z.infer<typeof inventory>;

/** A deterministic review report, never authority to execute a production cutover. */
export function planWorkspaceMigration(input: unknown) {
  const source = inventory.parse(input);
  source.wikis.sort((a, b) => a.vaultId.localeCompare(b.vaultId));
  buildVaultRegistry(source.wikis.map((w, i) => ({ ...w, isDefault: i === 0 })));
  const inventorySha256 = workspaceHash(JSON.stringify(source));
  const wikis = source.wikis.map(w => {
    const blockers: string[] = [];
    if (!w.liveAccessVerified) blockers.push("live access not verified");
    if (!w.fullInventoryReviewed) blockers.push("full writer/storage inventory pending");
    if (!w.directAccessReviewed) blockers.push("Obsidian/Git/S3/FUSE/backup access inventory pending");
    if (!w.writers.length) blockers.push("no authoritative writer identified");
    if (!w.credentialMetadataReviewed) blockers.push("credential metadata review pending");
    if (!w.contentManifestSha256) blockers.push("content manifest missing");
    if (!w.backupSha256 || !w.restoreProofSha256) blockers.push("backup and isolated restore proof required");
    return { vaultId: w.vaultId, workspaceName: w.workspaceName, ownerGithubId: w.ownerGithubId, status: blockers.length ? "blocked" : "ready-for-isolated-rehearsal", blockers };
  });
  const report = { version: 1, inventorySha256, deploymentRevision: source.deploymentRevision, mode: "plan-only", productionMutation: false, pilot: "not-selected", wikis,
    runbook: ["inventory-and-explicit-mapping", "consistent-backup-and-isolated-restore", "pinned-isolated-rehearsal", "review-pilot-and-cutover-window", "per-wiki-lock-pause-writers-and-revalidate-hashes", "checkpoint-and-bind-in-place-once", "verify-content-memberships-grants-and-cross-workspace-denials", "resume-single-writer", "rollback-only-with-isolation-and-post-cutover-writes-preserved"] };
  return { ...report, planSha256: workspaceHash(JSON.stringify(report)) };
}

export function verifyWorkspaceMigrationPlan(input: unknown, expectedPlanSha256: string) {
  const plan = planWorkspaceMigration(input);
  if (plan.planSha256 !== expectedPlanSha256) throw new WorkspaceError("MIGRATION_PLAN_DRIFT");
  return plan;
}

function migrationTarget(input: unknown, expected: string, vaultId: string) {
  const plan = verifyWorkspaceMigrationPlan(input, expected), source = inventory.parse(input);
  const target = source.wikis.find(w => w.vaultId === vaultId), status = plan.wikis.find(w => w.vaultId === vaultId);
  if (!target || !status || status.blockers.length || !target.ownerLogin) throw new WorkspaceError("MIGRATION_NOT_READY");
  return target;
}
export function applyWorkspaceMigration(input: unknown, expected: string, directory: string, vaultId: string) {
  const target = migrationTarget(input, expected, vaultId);
  const store = new WorkspaceStore(directory);
  try {
    const backup = join(directory, `workspaces.before-${expected}.json`);
    if (!existsSync(backup)) {
      const fd = openSync(backup,"wx",0o600);
      try { writeFileSync(fd,readFileSync(join(directory,"workspaces.json")));fsyncSync(fd); } finally {closeSync(fd);}
      syncWorkspaceDirectory(directory);
    }
    const entry=buildVaultRegistry([{...target,isDefault:true}]).entries.get(target.vaultId)!;
    return store.importLegacy(expected,{vaultId,name:target.workspaceName,slug:target.workspaceSlug??vaultId,ownerId:target.ownerGithubId,ownerLogin:target.ownerLogin!,bindingHash:workspaceBindingHash(entry)});
  } finally {store.close();}
}
export function rollbackWorkspaceMigration(input: unknown, expected: string, directory: string, vaultId: string): void {
  migrationTarget(input,expected,vaultId);
  const store=new WorkspaceStore(directory);
  try {store.rollbackLegacy(expected,vaultId);}finally{store.close();}
}

export function migrationMain(args: string[]): number {
  const [command, file, expected, directory, vaultId] = args;
  const mutating=command==="apply"||command==="rollback";
  if (!file || !["plan", "verify-plan", "apply", "rollback"].includes(command) || args.length !== (command === "plan" ? 2 : mutating ? 5 : 3) || (command !== "plan" && !expected)) {
    process.stderr.write("Usage: workspace-migration plan <inventory.json> | verify-plan <inventory.json> <plan-sha256> | apply|rollback <inventory.json> <plan-sha256> <control-directory> <vault-id>\nPlan is read-only. Apply/rollback require the daemon stopped and bind/archive control records only; wiki content and existing credentials remain untouched.\n"); return 2;
  }
  const input: unknown = JSON.parse(readFileSync(file, "utf8"));
  if(mutating){
    if(command==="apply"){const workspace=applyWorkspaceMigration(input,expected,directory,vaultId);process.stdout.write(JSON.stringify({ok:true,mode:"in-place-control-binding",workspaceId:workspace.id,vaultId,contentMoved:false,legacyCredentialsChanged:false})+"\n");}
    else{rollbackWorkspaceMigration(input,expected,directory,vaultId);process.stdout.write(JSON.stringify({ok:true,mode:"binding-archived",vaultId,contentPreserved:true,workspaceGrantsRevoked:true,legacyCredentialsChanged:false})+"\n");}
    return 0;
  }
  const plan = command === "plan" ? planWorkspaceMigration(input) : verifyWorkspaceMigrationPlan(input, expected);
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n"); return plan.wikis.some(w => w.blockers.length) ? 3 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = migrationMain(process.argv.slice(2)); }
  catch { process.stderr.write("Migration command refused or failed. Check inventory, reviewed hash, readiness evidence and the offline control-plane lock. Content and legacy credentials are never changed by this command.\n"); process.exitCode = 2; }
}
