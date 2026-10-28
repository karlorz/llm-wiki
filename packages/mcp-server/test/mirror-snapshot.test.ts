import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { MAX_READ_PAGE_BYTES } from "../src/tools/reads.js";
import { buildVaultRegistry } from "../src/vault-registry.js";
import { SnapshotQueue } from "../src/snapshot-queue.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { wikiInventory } from "../src/tools/inventory.js";
import { commitWrite } from "../src/txn.js";
import { makeTempVault } from "./helpers.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

describe("inventory and snapshot boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reuses a continuation path index but rehashes selected bytes and refreshes the initial page", async () => {
    const vault = await makeTempVault();
    const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    const deps = { vaultDir: vault, vaultId: "central", gate };
    const walk = vi.spyOn(fs, "readdir");
    const first = await wikiInventory(deps, { limit: 1 });
    expect(first.ok).toBe(true);
    const walks = walk.mock.calls.length;
    await writeFile(join(vault, "concepts", "alpha.md"), "updated bytes");
    const next = await wikiInventory(deps, { after: "SCHEMA.md", limit: 1 });
    expect(walk.mock.calls.length).toBe(walks);
    expect(next).toMatchObject({ entries: [{ path: "concepts/alpha.md", sha256: createHash("sha256").update("updated bytes").digest("hex") }] });
    await wikiInventory(deps, { limit: 1 });
    expect(walk.mock.calls.length).toBeGreaterThan(walks);
  });
  it("paginates stable hashes and admits documents about secrets while excluding instructions, config and symlink escapes", async () => {
    const vault = await makeTempVault();
    await writeFile(join(vault, "concepts", "AGENTS.md"), "deny");
    await writeFile(join(vault, "concepts", "secret.md"), "documentation");
    await writeFile(join(vault, "concepts", "credential-rotation.md"), "documentation");
    await mkdir(join(vault, ".skillwiki"));
    await writeFile(join(vault, ".skillwiki", "config.md"), "deny");
    await writeFile(join(vault, "concepts", ".env"), "deny");
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "leak.md"), "deny");
    await symlink(outside, join(vault, "concepts", "escape"));
    const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    let after: string | undefined; const entries: Array<{path: string; sha256: string}> = [];
    do { const page = await wikiInventory({ vaultDir: vault, vaultId: "central", gate }, { limit: 1, after }); expect(page.ok).toBe(true); if (!("entries" in page)) throw Error("inventory failed"); entries.push(...page.entries); after = page.next_after; } while (after);
    expect(entries.map(e => e.path)).toEqual(["SCHEMA.md", "concepts/alpha.md", "concepts/credential-rotation.md", "concepts/secret.md", "index.md", "log.md"]);
    expect(entries[0]?.sha256).toBe(createHash("sha256").update("# Schema\n").digest("hex"));
    expect((await wikiInventory({vaultDir:vault,vaultId:"central",gate},{after:"../escape.md"})).ok).toBe(false);
    expect((await wikiInventory({vaultDir:vault,vaultId:"central",gate},{limit:1001})).ok).toBe(false);
  });
  it("queues unique requests, refuses wrong vault and unsafe state, and keeps saved writes successful", async () => {
    const vault = await makeTempVault(); const state = await realpath(await mkdtemp(join(tmpdir(), "queue-")));
    const queue = new SnapshotQueue({ stateDir: state, vaultId: "central" }, [vault]);
    const a = queue.request("central"), b = queue.request("central");
    expect(a.state).toBe("queued"); expect(a.request_id).not.toBe(b.request_id);
    expect(queue.status("central", a.request_id).state).toBe("queued");
    expect(queue.request("other").state).toBe("disabled");
    const noncentral = new SnapshotQueue({ stateDir: state, vaultId: "other" }, [vault]);
    expect(noncentral.request("other").state).toBe("disabled");
    expect(noncentral.status("other").state).toBe("disabled");
    expect(queue.status("central", "../../oops").ok).toBe(false);
    const bad = new SnapshotQueue({stateDir:join(vault,"queue"),vaultId:"central"},[vault]);
    expect(bad.request("central").state).toBe("failed");
    await expect(commitWrite({vaultDir:vault,putObject:async()=>{},onCommit:()=>{ bad.request("central"); throw Error("disconnected"); }},[{relPath:"concepts/saved.md",content:"saved"}])).resolves.toEqual({paths:["concepts/saved.md"]});
  });
  it("refuses physical containment through a live vault alias and dangling state links", async () => {
    const vault = await realpath(await makeTempVault());
    const base = await realpath(await mkdtemp(join(tmpdir(), "queue-alias-")));
    const alias = join(base, "alias"); await symlink(vault, alias);
    expect(new SnapshotQueue({ stateDir: join(vault, "state"), vaultId: "central" }, [alias]).request("central").state).toBe("failed");
    const dangling = join(base, "dangling"); await symlink(join(base, "absent"), dangling);
    expect(new SnapshotQueue({ stateDir: dangling, vaultId: "central" }, [vault]).request("central").state).toBe("failed");
    const state = join(base, "state"); await mkdir(state);
    await symlink(join(base, "absent"), join(state, "pending"));
    expect(new SnapshotQueue({ stateDir: state, vaultId: "central" }, [vault]).request("central").state).toBe("failed");
  });
  it("does not descend into a directory replaced by a symlink after readdir", async () => {
    const vault = await realpath(await makeTempVault());
    const outside = await mkdtemp(join(tmpdir(), "inventory-outside-"));
    await writeFile(join(outside, "leak.md"), "outside");
    const original = fs.readdir;
    const visited: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (dir: string, options: any) => {
      visited.push(String(dir));
      const entries = await original(dir, options);
      // The scan uses a pinned root fd on Linux.
      if (String(dir) === vault || visited.length === 1) {
        await rename(join(vault, "concepts"), join(vault, ".moved"));
        await symlink(outside, join(vault, "concepts"));
      }
      return entries;
    }) as typeof fs.readdir);
    const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    const result = await wikiInventory({ vaultDir: vault, vaultId: "central", gate }, {});
    expect(result.ok).toBe(true);
    expect(visited).not.toContain(join(vault, "concepts"));
    expect("entries" in result && result.entries.some(e => e.path.includes("leak"))).toBe(false);
  });
  it("omits oversized and concurrently modified files and bounds each read", async () => {
    const vault = await realpath(await makeTempVault());
    await writeFile(join(vault, "concepts", "large.md"), Buffer.alloc(MAX_READ_PAGE_BYTES + 1));
    const changing = join(vault, "concepts", "changing.md");
    await writeFile(changing, "before");
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const fd = await original(...args);
      if (args[0] === changing) {
        const read = fd.read.bind(fd);
        vi.spyOn(fd, "read").mockImplementationOnce((async (...readArgs: any[]) => {
          expect(readArgs[2]).toBeLessThanOrEqual(MAX_READ_PAGE_BYTES + 1);
          const result = await (read as any)(...readArgs);
          await writeFile(changing, "after!");
          return result;
        }) as typeof fd.read);
      }
      return fd;
    }) as typeof fs.open);
    const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    const result = await wikiInventory({ vaultDir: vault, vaultId: "central", gate }, {});
    expect(result.ok).toBe(true);
    expect("entries" in result && result.entries.some(e => /large|changing/.test(e.path))).toBe(false);
  });
  it.each(["central", "other"])("disables a noncentral daemon default even with a %s queue", async queueVault => {
    const vault = await makeTempVault(); const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    const registry = buildVaultRegistry([{ vaultId: "other", isDefault: true, localRoot: vault, rcloneRemote: "wiki", rclonePath: "cloud/other", s3Prefix: "other" }]);
    const queue = new SnapshotQueue({ stateDir: join(vault, "state"), vaultId: queueVault }, [vault]);
    const request = vi.spyOn(queue, "request");
    const token = "snapshot-default"; const hash = createHash("sha256").update(token).digest("hex");
    const server = await startMcpHttpServer({ bind: "127.0.0.1", port: 0, vaultDir: vault, gate, registry, runtimes: new Map([["other", { entry: registry.entries.get("other")!, gate, putObject: async () => {} }]]), snapshotQueue: queue, tokenMap: new Map([[hash, "macos-dev"]]), putObject: async () => {} });
    try {
      const port = (server.address() as AddressInfo).port;
      for (const name of ["wiki_snapshot_request", "wiki_snapshot_status"]) {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
        expect(((await response.json()) as any).result.structuredContent.state).toBe("disabled");
      }
      expect(request).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("successful registered MCP workitem writes enqueue; queue failure logs safely and preserves success", async () => {
    const vault = await makeTempVault(); const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    const state = await realpath(await mkdtemp(join(tmpdir(), "snapshot-write-")));
    const queue = new SnapshotQueue({ stateDir: state, vaultId: "central" }, [vault]);
    const request = vi.spyOn(queue, "request");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = "snapshot-write"; const hash = createHash("sha256").update(token).digest("hex");
    const server = await startMcpHttpServer({ bind: "127.0.0.1", port: 0, vaultDir: vault, gate, snapshotQueue: queue, tokenMap: new Map([[hash, "macos-dev"]]), putObject: async () => {} });
    try {
      const port = (server.address() as AddressInfo).port;
      for (const fail of [false, true]) {
        if (fail) queue.config.stateDir = join(vault, "unsafe");
        const path = `projects/llm-wiki/requirements/${fail ? "failure" : "success"}.md`;
        const content = "---\ntitle: Saved\n---\nbody\n";
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wiki_workitem_write", arguments: { path, content } } }) });
        expect(((await response.json()) as any).result.structuredContent.ok).toBe(true);
        expect(await readFile(join(vault, path), "utf8")).toBe(content);
      }
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledWith("central");
      expect(log).toHaveBeenCalledWith("skillwiki-mcp snapshot enqueue failed");
      expect(queue.status("central").state).toBe("failed");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("HTTP authenticates tools, rejects wrong vault, exposes disabled requests and readiness", async () => {
    const vault = await makeTempVault(); const gate = new ReconcileGate(async()=>{}); await gate.runFirst();
    const token="mirror-test"; const hash=createHash("sha256").update(token).digest("hex");
    let allowWrite = true;
    const server=await startMcpHttpServer({authorizeWorkspaceAction: action => action !== "write" || allowWrite, bind:"127.0.0.1",port:0,vaultDir:vault,gate,tokenMap:new Map([[hash,"macos-dev"]]),putObject:async()=>{}});
    const port=(server.address() as AddressInfo).port;
    async function call(name:string,args={},authorized=true) { return fetch(`http://127.0.0.1:${port}/mcp`,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",...(authorized?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}); }
    try {
      expect((await call("wiki_inventory",{},false)).status).toBe(401);
      const wrong=await (await call("wiki_inventory",{vault:"other"})).json() as any; expect(wrong.result.structuredContent.ok).toBe(false);
      const disabled=await (await call("wiki_snapshot_request")).json() as any; expect(disabled.result.structuredContent.state).toBe("disabled");
      allowWrite = false;
      const denied = await (await call("wiki_snapshot_request")).json() as any;
      expect(denied.result.structuredContent.error).toBe("VAULT_UNAUTHORIZED");
      const inventory=await (await call("wiki_inventory",{limit:1})).json() as any; expect(inventory.result.structuredContent.entries).toHaveLength(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
});
