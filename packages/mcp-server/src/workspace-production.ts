import { mkdirSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildVaultRegistry, type VaultRegistry, type VaultRegistryEntry } from "./vault-registry.js";
import { LocalWorkspaceStorage, type WorkspaceStorage } from "./workspace-storage.js";
import { WorkspaceError, type Workspace } from "./workspace-store.js";
import { workspaceBindingHash } from "./workspace-binding.js";
export { workspaceBindingHash } from "./workspace-binding.js";
import type { VaultRuntime } from "./vault-runtime.js";
import type { S3Adapter } from "./versions.js";
import { ReconcileGate, rcloneCopyUpdate } from "./reconcile.js";
import { probeS3Writable, startS3WritePulse } from "./s3-write-probe.js";

export interface WorkspaceObjectStore extends S3Adapter {
 listKeys(): Promise<string[]>;
 createObject(path: string, body: Buffer): Promise<boolean>;
 deleteObject(path: string): Promise<void>;
}
export interface ProductionWorkspaceOptions {
 localRoot: string; remote: string; bucket: string; prefix: string; endpoint: string; region: string;
 reconcileIntervalMs: number;
}

/** One runtime per immutable namespace. Legacy imports reuse existing runtimes. */
export class ProductionWorkspaceStorage implements WorkspaceStorage {
 private readonly options: ProductionWorkspaceOptions;
 private readonly local: LocalWorkspaceStorage;
 private readonly runtimes = new Map<string,Promise<VaultRuntime>>();
 private readonly stops: Array<()=>void> = [];
 private closed = false;
 constructor(options: ProductionWorkspaceOptions, private readonly legacy: VaultRegistry,
  private readonly legacyRuntimes: ReadonlyMap<string,VaultRuntime>,
  private readonly objects: (entry:VaultRegistryEntry)=>WorkspaceObjectStore,
  private readonly reconcile: (entry:VaultRegistryEntry)=>Promise<void> = entry=>rcloneCopyUpdate({remote:entry.rcloneRemote,bucket:entry.rclonePath,vaultDir:entry.localRoot,timeoutMs:entry.rcloneTimeoutMs})) {
  if (!options.prefix || options.prefix.split("/").some(p=>!p || p===".." || p===".") || /[\\\x00]/.test(options.prefix) || !Number.isSafeInteger(options.reconcileIntervalMs) || options.reconcileIntervalMs<0) throw new WorkspaceError("INVALID_WORKSPACE_STORAGE");
  mkdirSync(options.localRoot,{recursive:true,mode:0o700});
  this.options={...options,localRoot:realpathSync(resolve(options.localRoot))};
  // Validate the whole reserved namespace against every existing legacy wiki.
  buildVaultRegistry([...legacy.entries.values(),{vaultId:"workspace-reserved",isDefault:false,localRoot:this.options.localRoot,rcloneRemote:options.remote,rclonePath:`${options.bucket}/${options.prefix}`,s3Endpoint:options.endpoint,s3Bucket:options.bucket,s3Prefix:options.prefix,s3Region:options.region}]);
  this.local=new LocalWorkspaceStorage(this.options.localRoot);
 }
 binding(w:Workspace):VaultRegistryEntry {
  if(w.origin==="legacy") {
   const entry=this.legacy.entries.get(w.vaultId);
   if(!entry?.enabled || !w.bindingHash || workspaceBindingHash(entry)!==w.bindingHash)throw new WorkspaceError("LEGACY_BINDING_DRIFT");
   return entry;
  }
  if(!/^v-[a-f0-9]{32}$/.test(w.vaultId))throw new WorkspaceError("INVALID_VAULT_ID");
  const prefix=`${this.options.prefix}/${w.vaultId}`;
  return buildVaultRegistry([{vaultId:w.vaultId,isDefault:true,localRoot:join(this.options.localRoot,w.vaultId),rcloneRemote:this.options.remote,rclonePath:`${this.options.bucket}/${prefix}`,s3Endpoint:this.options.endpoint,s3Bucket:this.options.bucket,s3Prefix:prefix,s3Region:this.options.region,reconcileIntervalMs:this.options.reconcileIntervalMs}]).entries.get(w.vaultId)!;
 }
 private async checkRoot(w:Workspace):Promise<void> {
  const entry=this.binding(w);
  if(await realpath(this.options.localRoot)!==this.options.localRoot)throw new WorkspaceError("STORAGE_SYMLINK");
  const stat=await lstat(entry.localRoot);
  if(!stat.isDirectory() || stat.isSymbolicLink() || await realpath(entry.localRoot)!==entry.localRoot)throw new WorkspaceError("STORAGE_SYMLINK");
 }
 async provision(w:Workspace):Promise<void> {
  if(w.origin==="legacy")throw new WorkspaceError("LEGACY_PROVISIONING_DENIED");
  const entry=this.binding(w),remote=this.objects(entry),schema=await this.local.schema();
  const keys=await remote.listKeys();
  if(keys.some(k=>!(k in schema)))throw new WorkspaceError("UNEXPECTED_NEW_VAULT_CONTENT");
  for(const [path,content]of Object.entries(schema)){
   if(!await remote.createObject(path,Buffer.from(content))){const existing=await remote.getObject(path);if(existing?.body?.toString("utf8")!==content)throw new WorkspaceError("PROVISIONING_CONTENT_CONFLICT");}
  }
  await this.local.provision(w);
 }
 async verify(w:Workspace):Promise<void> {
  if(w.origin==="legacy")throw new WorkspaceError("LEGACY_PROVISIONING_DENIED");
  await this.local.verify(w);const remote=this.objects(this.binding(w)),schema=await this.local.schema(),keys=await remote.listKeys();
  if(keys.length!==Object.keys(schema).length || keys.some(k=>!(k in schema)))throw new WorkspaceError("UNEXPECTED_NEW_VAULT_CONTENT");
  for(const [path,content]of Object.entries(schema))if((await remote.getObject(path))?.body?.toString("utf8")!==content)throw new WorkspaceError("SCHEMA_VERIFICATION_FAILED");
  // Activation requires the real reconciliation and write/read/delete probe,
  // rather than deferring storage readiness until the first member request.
  await this.runtime(w);
 }
 async runtime(w:Workspace):Promise<VaultRuntime> {
  if(this.closed)throw new WorkspaceError("WORKSPACE_STORAGE_CLOSED");
  const entry=this.binding(w);
  if(w.origin==="legacy"){
   const runtime=this.legacyRuntimes.get(w.vaultId);if(!runtime || runtime.entry!==entry)throw new WorkspaceError("LEGACY_RUNTIME_UNAVAILABLE");return runtime;
  }
  await this.checkRoot(w);
  let pending=this.runtimes.get(w.vaultId);
  if(!pending){pending=this.start(entry);this.runtimes.set(w.vaultId,pending);void pending.catch(()=>this.runtimes.delete(w.vaultId));}
  return pending;
 }
 private async start(entry:VaultRegistryEntry):Promise<VaultRuntime>{
  const adapter=this.objects(entry),gate=new ReconcileGate(()=>this.reconcile(entry));await gate.runFirst();
  const deps={...adapter,hostId:"workspace-daemon"};const health=await probeS3Writable(deps);
  if(this.closed)throw new WorkspaceError("WORKSPACE_STORAGE_CLOSED");
  if(!health.s3Writable)throw new WorkspaceError("WORKSPACE_STORAGE_UNAVAILABLE");
  if(this.options.reconcileIntervalMs>0){
   this.stops.push(startS3WritePulse(deps,health));
   const timer=setInterval(()=>{void gate.runPeriodic().catch(()=>{});},this.options.reconcileIntervalMs);timer.unref();this.stops.push(()=>clearInterval(timer));
  }
  return {entry,gate,putObject:adapter.putObject,getObject:adapter.getObject,s3WriteHealth:health};
 }
 close():void {this.closed=true;for(const stop of this.stops.splice(0))stop();}
}
