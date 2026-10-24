import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore, workspaceSecret } from "../src/workspace-store.js";
import { LocalWorkspaceStorage, WorkspaceProvisioner } from "../src/workspace-storage.js";
import { buildVaultRegistry } from "../src/vault-registry.js";
const stores: WorkspaceStore[] = []; afterEach(() => stores.splice(0).forEach(s => s.close()));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-provision-")), legacy = join(root, "legacy"); await mkdir(legacy); await writeFile(join(legacy, "private.md"), "private");
  const registry = buildVaultRegistry([{ vaultId: "central", isDefault: true, localRoot: legacy, rcloneRemote: "legacy", rclonePath: "legacy" }]);
  const store = new WorkspaceStore(join(root, "control")); stores.push(store); store.login({ id: "11", login: "alice" }); store.allowCreation("11", true);
  const workspace = store.create("11", "Alpha", "alpha", workspaceSecret()), storage = new LocalWorkspaceStorage(join(root, "wikis"));
  return { root, legacy, registry, store, workspace, storage };
}
describe("durable isolated provisioning", () => {
  it("quarantines verification failure; concurrent retry resumes one operation without overwriting content", async () => {
    const { root, store, workspace: w, registry, storage } = await fixture(); let attempts = 0;
    const provisioner = new WorkspaceProvisioner(store, { binding: x => storage.binding(x), provision: x => storage.provision(x), verify: async x => { if (++attempts === 1) throw new Error("simulated storage failure"); await storage.verify(x); }, runtime: x => storage.runtime(x) }, registry);
    await provisioner.run("11", w.operation); expect(store.operation("11", w.operation).state).toBe("failed"); expect(store.visible("11")).toEqual([]); expect(store.snapshot().members).toEqual([]);
    await Promise.all([provisioner.run("11", w.operation), provisioner.run("11", w.operation)]);
    expect(attempts).toBe(2); expect(store.snapshot().workspaces).toHaveLength(1); expect(store.snapshot().members).toHaveLength(1); expect(store.snapshot().grants).toHaveLength(0);
    expect(await readdir(join(root, "wikis", w.vaultId))).toHaveLength(3);
  });
  it("resumes a persisted initialized checkpoint after clean restart without provisioning twice", async () => {
    const { root, store, workspace: w, registry, storage } = await fixture();
    store.transition(w.operation, "provisioning"); await storage.provision(w); store.transition(w.operation, "verifying");
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new WorkspaceStore(join(root, "control")); stores.push(reopened);
    const provisioner = new WorkspaceProvisioner(reopened, { binding: x => storage.binding(x), provision: async () => { throw new Error("must not initialize twice"); }, verify: x => storage.verify(x), runtime: x => storage.runtime(x) }, registry);
    await provisioner.resumePending(); expect(reopened.operation("11", w.operation).state).toBe("active"); expect(reopened.view("11", w.id).role).toBe("owner");
  });
  it("rejects inherited content and leaves failed namespaces quarantined", async () => {
    const { root, store, workspace: w, registry, storage } = await fixture(); const dir = join(root, "wikis", w.vaultId); await mkdir(dir); await writeFile(join(dir, "inherited.md"), "must stay quarantined");
    await new WorkspaceProvisioner(store, storage, registry).run("11", w.operation); expect(store.operation("11", w.operation).state).toBe("failed"); expect(store.visible("11")).toEqual([]); expect(await readFile(join(dir, "inherited.md"), "utf8")).toBe("must stay quarantined");
  });
  it("rejects symlinked schema without touching its target", async () => {
    const { root, legacy, store, workspace: w, registry, storage } = await fixture(); const dir = join(root, "wikis", w.vaultId); await mkdir(dir); await symlink(join(legacy, "private.md"), join(dir, "SCHEMA.md"));
    await new WorkspaceProvisioner(store, storage, registry).run("11", w.operation); expect(store.operation("11", w.operation).state).toBe("failed"); expect(await readFile(join(legacy, "private.md"), "utf8")).toBe("private");
  });
  it("refuses overlapping legacy binding before schema writes", async () => {
    const { legacy, store, workspace: w, registry } = await fixture(); const storage = new LocalWorkspaceStorage(legacy);
    await new WorkspaceProvisioner(store, storage, registry).run("11", w.operation); expect(store.operation("11", w.operation).state).toBe("failed"); expect(await readdir(legacy)).toEqual(["private.md"]);
  });
  it("rechecks account eligibility at activation and still records a quarantined failure", async () => {
    const { store, workspace: w, registry, storage } = await fixture();
    const provisioner = new WorkspaceProvisioner(store, { binding: x => storage.binding(x), provision: x => storage.provision(x), verify: async x => { await storage.verify(x); store.suspendAccount("11", true); }, runtime: x => storage.runtime(x) }, registry);
    await provisioner.run("11", w.operation); expect(store.snapshot().workspaces[0].state).toBe("failed"); expect(store.snapshot().members).toEqual([]);
  });
});
