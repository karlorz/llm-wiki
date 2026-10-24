import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore, workspaceSecret } from "../src/workspace-store.js";
import { WorkspaceProvisioner } from "../src/workspace-storage.js";
import { ProductionWorkspaceStorage, workspaceBindingHash, type WorkspaceObjectStore } from "../src/workspace-production.js";
import { buildVaultRegistry } from "../src/vault-registry.js";
import { ReconcileGate } from "../src/reconcile.js";
const stores: WorkspaceStore[] = []; afterEach(() => stores.splice(0).forEach(s => s.close()));
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "workspace-production-")); const legacyRoot = join(root,"legacy"); await mkdir(legacyRoot); await writeFile(join(legacyRoot,"SCHEMA.md"),"legacy unchanged");
 const registry = buildVaultRegistry([{vaultId:"central",isDefault:true,localRoot:legacyRoot,rcloneRemote:"storage",rclonePath:"bucket/wiki",s3Bucket:"bucket",s3Prefix:"wiki"}]);
 const store = new WorkspaceStore(join(root,"control")); stores.push(store); store.login({id:"11",login:"alice"});store.allowCreation("11",true);
 const workspace = store.create("11","New","new-wiki",workspaceSecret());const objects = new Map<string,Buffer>(); let puts = 0;
 const objectStore: WorkspaceObjectStore = {
   listKeys:async()=>[...objects.keys()],getObject:async path=>objects.has(path)?{body:objects.get(path)!}:null,
   putObject:async(path,body)=>{puts++;objects.set(path,body);},
   createObject:async(path,body)=>{if(objects.has(path))return false;objects.set(path,body);return true;},
   deleteObject:async path=>{objects.delete(path);},
 };
 const storage = new ProductionWorkspaceStorage({localRoot:join(root,"native"),remote:"storage",bucket:"bucket",prefix:"workspace-wikis",endpoint:"https://storage.example",region:"test",reconcileIntervalMs:0},registry,new Map(),()=>objectStore,async()=>{});
 return {root,legacyRoot,registry,store,workspace,objects,storage,puts:()=>puts};
}
describe("production workspace storage",()=>{
 it("prepares remote schema, verifies it and caches an isolated ready runtime",async()=>{
  const f=await fixture();await new WorkspaceProvisioner(f.store,f.storage,f.registry).run("11",f.workspace.operation);
  expect(f.store.operation("11",f.workspace.operation).state).toBe("active");expect([...f.objects.keys()].sort()).toEqual(["SCHEMA.md","index.md","log.md"]);
  const first=await f.storage.runtime(f.workspace),second=await f.storage.runtime(f.workspace);expect(first).toBe(second);expect(first.gate.ready).toBe(true);expect(first.s3WriteHealth?.s3Writable).toBe(true);
  await first.putObject("projects/test.md",Buffer.from("remote proof"));expect(f.objects.get("projects/test.md")?.toString()).toBe("remote proof");expect(await readFile(join(f.legacyRoot,"SCHEMA.md"),"utf8")).toBe("legacy unchanged");f.storage.close();
 });
 it("quarantines nonempty remote namespaces without overwriting inherited bytes",async()=>{
  const f=await fixture();f.objects.set("inherited.md",Buffer.from("private"));await new WorkspaceProvisioner(f.store,f.storage,f.registry).run("11",f.workspace.operation);
  expect(f.store.operation("11",f.workspace.operation).state).toBe("failed");expect(f.objects.get("inherited.md")?.toString()).toBe("private");expect(f.objects.size).toBe(1);f.storage.close();
 });
 it("rejects an overlapping namespace before provisioning",async()=>{
  const f=await fixture();expect(()=>new ProductionWorkspaceStorage({localRoot:join(f.root,"other"),remote:"storage",bucket:"bucket",prefix:"wiki/sub",endpoint:"https://storage.example",region:"test",reconcileIntervalMs:0},f.registry,new Map(),()=>{throw new Error("must not allocate");},async()=>{})).toThrow();f.storage.close();
 });
 it("reuses the exact imported legacy runtime and refuses changed bindings",async()=>{
  const f=await fixture(),entry=f.registry.entries.get("central")!,gate=new ReconcileGate(async()=>{});await gate.runFirst();
  const runtime={entry,gate,putObject:async()=>{throw new Error("legacy proof is read-only");}};
  const imported=f.store.importLegacy("a".repeat(64),{vaultId:"central",name:"Central",slug:"central",ownerId:"11",ownerLogin:"alice",bindingHash:workspaceBindingHash(entry)});
  const storage=new ProductionWorkspaceStorage({localRoot:join(f.root,"imported-native"),remote:"storage",bucket:"bucket",prefix:"other-workspaces",endpoint:"https://storage.example",region:"test",reconcileIntervalMs:0},f.registry,new Map([["central",runtime]]),()=>{throw new Error("must reuse legacy adapter");},async()=>{});
  const context=await new WorkspaceProvisioner(f.store,storage,f.registry).context(imported,f.registry);
  expect(context.runtimes.get("central")).toBe(runtime);expect([...context.registry.entries.keys()]).toEqual(["central"]);
  await expect(storage.runtime({...imported,bindingHash:"f".repeat(64)})).rejects.toThrow("LEGACY_BINDING_DRIFT");
  await expect(storage.provision(imported)).rejects.toThrow("LEGACY_PROVISIONING_DENIED");
  storage.close();f.storage.close();
 });
 it("does not start a runtime after storage has closed",async()=>{
  const f=await fixture();await f.storage.provision(f.workspace);f.storage.close();
  await expect(f.storage.runtime(f.workspace)).rejects.toThrow("WORKSPACE_STORAGE_CLOSED");
 });

 it("persists native bindings and refuses namespace changes after provisioning or restart",async()=>{
  const f=await fixture();const provisioner=new WorkspaceProvisioner(f.store,f.storage,f.registry);await provisioner.run("11",f.workspace.operation);
  const active=f.store.operation("11",f.workspace.operation);expect(active.bindingHash).toBe(workspaceBindingHash(f.storage.binding(active)));
  const changed=new ProductionWorkspaceStorage({localRoot:join(f.root,"retargeted"),remote:"storage",bucket:"bucket",prefix:"different-workspaces",endpoint:"https://storage.example",region:"test",reconcileIntervalMs:0},f.registry,new Map(),()=>{throw new Error("must reject before I/O");},async()=>{});
  await expect(new WorkspaceProvisioner(f.store,changed,f.registry).context(active,f.registry)).rejects.toThrow("STORAGE_BINDING_DRIFT");
  expect(f.store.operation("11",f.workspace.operation).bindingHash).toBe(active.bindingHash);changed.close();f.storage.close();
 });

});
