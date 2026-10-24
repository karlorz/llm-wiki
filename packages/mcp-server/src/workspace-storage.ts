import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ReconcileGate } from "./reconcile.js";
import { buildVaultRegistry, type VaultRegistry, type VaultRegistryEntry } from "./vault-registry.js";
import type { VaultRuntime } from "./vault-runtime.js";
import { sha256Bytes, writeAtomicPath } from "./txn.js";
import { WorkspaceError, WorkspaceStore, syncWorkspaceDirectory, type Workspace } from "./workspace-store.js";
import { workspaceBindingHash } from "./workspace-binding.js";

export interface WorkspaceStorage {
  binding(workspace: Workspace): VaultRegistryEntry;
  provision(workspace: Workspace): Promise<void>;
  verify(workspace: Workspace): Promise<void>;
  runtime(workspace: Workspace): Promise<VaultRuntime>;
}

/** Explicit local-development storage. It never reads production S3/env credentials. */
export class LocalWorkspaceStorage implements WorkspaceStorage {
  private readonly roots: string;
  constructor(directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); this.roots = realpathSync.native(resolve(directory)); }
  private root(w: Workspace): string {
    if (!/^v-[a-f0-9]{32}$/.test(w.vaultId)) throw new WorkspaceError("INVALID_VAULT_ID");
    return join(this.roots, w.vaultId);
  }
  binding(w: Workspace): VaultRegistryEntry {
    return buildVaultRegistry([{ vaultId: w.vaultId, isDefault: true, localRoot: this.root(w), rcloneRemote: "local-development", rclonePath: w.vaultId }]).entries.get(w.vaultId)!;
  }
  private async safeRoot(w: Workspace): Promise<string> {
    await mkdir(this.roots, { recursive: true, mode: 0o700 });
    if (relative(this.roots, await realpath(this.roots)) !== "") throw new WorkspaceError("STORAGE_SYMLINK");
    const root = this.root(w);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink() || relative(root, await realpath(root)) !== "") throw new WorkspaceError("STORAGE_SYMLINK");
    return root;
  }
  async schema() {
    const schema = (await readFile(new URL("../../cli/templates/SCHEMA.md", import.meta.url), "utf8"))
      .replace("{{DOMAIN}}", "Workspace wiki").replace("{{WIKI_LANG}}", "en").replace("{{TAXONOMY_YAML}}", "  general: []");
    return { "SCHEMA.md": schema, "index.md": "# Vault Index\n\n## Projects\n", "log.md": "# Vault Log\n" };
  }
  async provision(w: Workspace): Promise<void> {
    const root = await this.safeRoot(w);
    for (const [path, content] of Object.entries(await this.schema())) {
      try {
        const file = await open(join(root, path), "wx", 0o600);
        try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await lstat(join(root, path))).isSymbolicLink() || await readFile(join(root, path), "utf8") !== content) throw new WorkspaceError("PROVISIONING_CONTENT_CONFLICT");
      }
    }
    syncWorkspaceDirectory(root);
  }
  async verify(w: Workspace): Promise<void> {
    const root = await this.safeRoot(w), schema = await this.schema();
    const files = await readdir(root);
    if (files.length !== Object.keys(schema).length) throw new WorkspaceError("UNEXPECTED_NEW_VAULT_CONTENT");
    for (const [path, content] of Object.entries(schema)) {
      if (!(await lstat(join(root, path))).isFile() || await readFile(join(root, path), "utf8") !== content) throw new WorkspaceError("SCHEMA_VERIFICATION_FAILED");
    }
  }
  async runtime(w: Workspace): Promise<VaultRuntime> {
    const root = await this.safeRoot(w);
    const entry = this.binding(w);
    const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    // Existing tool validation owns managed path rules; the adapter also fences arbitrary paths.
    const target = async (path: string) => {
      if (!path || path.split("/").some(p => !p || p === "." || p === "..") || /[\\\x00]/.test(path)) throw new WorkspaceError("STORAGE_PATH_DENIED");
      let current = root;
      for (const part of path.split("/")) {
        current = join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) throw new WorkspaceError("STORAGE_SYMLINK"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return current;
    };
    return { entry, gate, s3WriteHealth: { s3Writable: true, s3WritableCheckedAt: new Date().toISOString() },
      putObject: async (path, body) => { await writeAtomicPath(await target(path), body); },
      getObject: async path => {
        try { const body = await readFile(await target(path)); return { body, sha256: sha256Bytes(body) }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      } };
  }
}

export class WorkspaceProvisioner {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly store: WorkspaceStore, readonly storage: WorkspaceStorage, private readonly legacy: VaultRegistry) {}
  run(user: string, operation: string): Promise<void> {
    const w = this.store.operation(user, operation);
    return this.launch(w);
  }
  async resumePending(): Promise<void> {
    await Promise.all(this.store.snapshot().workspaces.filter(w => ["draft", "provisioning", "verifying"].includes(w.state)).map(w => this.launch(w)));
  }
  private launch(w: Workspace): Promise<void> {
    if (w.state === "active") return Promise.resolve();
    const current = this.running.get(w.operation); if (current) return current;
    const run = this.provision(w).finally(() => this.running.delete(w.operation));
    this.running.set(w.operation, run); return run;
  }
  private async provision(w: Workspace): Promise<void> {
    try {
      this.assertBinding(w, this.legacy);
      w = this.store.bindNativeStorage(w.operation, workspaceBindingHash(this.storage.binding(w)));
      if (w.step === "reserved") {
        this.store.transition(w.operation, "provisioning");
        await this.storage.provision(w);
      }
      this.store.transition(w.operation, "verifying");
      await this.storage.verify(w);
      this.store.transition(w.operation, "active");
    } catch {
      // Detailed filesystem/network errors may contain secrets or private paths.
      this.store.transition(w.operation, "failed", "Setup failed. Retry resumes this same operation.");
    }
  }
  private assertBinding(w: Workspace, legacy: VaultRegistry): void {
    const entry = this.storage.binding(w);
    if (entry.vaultId !== w.vaultId) throw new WorkspaceError("STORAGE_BINDING_MISMATCH");
    if (w.bindingHash && workspaceBindingHash(entry) !== w.bindingHash) throw new WorkspaceError("STORAGE_BINDING_DRIFT");
    if (w.state === "active" && !w.bindingHash) throw new WorkspaceError("STORAGE_BINDING_MISSING");
    if (w.origin === "legacy") {
      if (entry !== legacy.entries.get(w.vaultId) || !entry.enabled) throw new WorkspaceError("LEGACY_BINDING_MISMATCH");
      return;
    }
    const siblings = this.store.snapshot().workspaces.filter(other => other.id !== w.id && other.origin !== "legacy").map(other => this.storage.binding(other));
    buildVaultRegistry([...legacy.entries.values()].map(e => ({ ...e, localRoot: realpathSync.native(e.localRoot) })).concat([...siblings, entry].map(e => ({ ...e, isDefault: false,
      s3Bucket: e.s3Bucket ?? "local-development", s3Prefix: e.s3Prefix || e.vaultId,
      rclonePath: e.s3Bucket ? e.rclonePath : `local-development/${e.vaultId}` }))));
  }
  async context(w: Workspace, legacy: VaultRegistry) {
    this.assertBinding(w, legacy);
    const runtime = await this.storage.runtime(w);
    if (runtime.entry.vaultId !== w.vaultId) throw new WorkspaceError("STORAGE_BINDING_MISMATCH");
    return { registry: { defaultVaultId: w.vaultId, entries: new Map([[w.vaultId, runtime.entry]]) }, runtimes: new Map([[w.vaultId, runtime]]) };
  }
}
