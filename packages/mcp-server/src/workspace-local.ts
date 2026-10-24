import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { startMcpHttpServer } from "./server.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceWeb } from "./workspace-web.js";
import { WorkspaceGitHub } from "./workspace-github.js";
import { WorkspaceProvisioner, LocalWorkspaceStorage } from "./workspace-storage.js";
import { FileOAuthStore } from "./oauth-store.js";
import { ReconcileGate } from "./reconcile.js";
import { buildVaultRegistry } from "./vault-registry.js";

/** Deliberately separate from production main/config. No live env or token-map imports. */
export async function startLocalWorkspaceConsole(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ server: Server; url: string }> {
  const parameters = new Map<string, string>();
  if (args.length % 2 !== 0) throw new Error("options require values");
  for (let i = 0; i < args.length; i += 2) {
    if (!["--directory", "--port", "--grant-hours", "--invitation-hours"].includes(args[i]) || parameters.has(args[i])) throw new Error("unknown or duplicate option");
    parameters.set(args[i], args[i + 1]);
  }
  const directory = parameters.get("--directory"), port = Number(parameters.get("--port"));
  const grantHours = Number(parameters.get("--grant-hours")), invitationHours = Number(parameters.get("--invitation-hours"));
  const clientId = env.SKILLWIKI_WORKSPACE_DEV_GITHUB_CLIENT_ID, clientSecret = env.SKILLWIKI_WORKSPACE_DEV_GITHUB_CLIENT_SECRET;
  if (!directory || !Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isFinite(grantHours) || grantHours <= 0 || !Number.isFinite(invitationHours) || invitationHours <= 0 || !clientId || !clientSecret) throw new Error("local directory, port, explicit grant/invitation lifetimes and dedicated development GitHub app are required");
  const root = resolve(directory), marker = join(root, ".skillwiki-local-workspace");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (readdirSync(root).length && (!existsSync(marker) || readFileSync(marker, "utf8") !== "local-development/v1\n")) throw new Error("refusing a nonempty directory without the local-development marker");
  if (!existsSync(marker)) writeFileSync(marker, "local-development/v1\n", { flag: "wx", mode: 0o600 });
  const legacyRoot = join(root, "legacy-disabled"); mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
  const registry = buildVaultRegistry([{ vaultId: "central", isDefault: true, localRoot: legacyRoot, rcloneRemote: "local-development", rclonePath: "legacy-disabled" }]);
  const store = new WorkspaceStore(join(root, "control"));
  try {
    const issuer = `http://127.0.0.1:${port}`;
    const storage = new LocalWorkspaceStorage(join(root, "wikis"));
    const provisioner = new WorkspaceProvisioner(store, storage, registry);
    const web = new WorkspaceWeb({ issuer, store, provisioner, github: new WorkspaceGitHub(issuer, { clientId, clientSecret }),
      creationAllowlist: (env.SKILLWIKI_WORKSPACE_DEV_CREATOR_IDS ?? "").split(",").filter(Boolean), grantLifetimeMs: grantHours * 3600_000, invitationLifetimeMs: invitationHours * 3600_000 });
    const gate = new ReconcileGate(async () => {}); await gate.runFirst();
    const server = await startMcpHttpServer({ bind: "127.0.0.1", port, vaultDir: legacyRoot, registry,
      runtimes: new Map([["central", { entry: registry.entries.get("central")!, gate, putObject: async () => { throw new Error("legacy storage disabled"); } }]]),
      gate, tokenMap: new Map(), putObject: async () => { throw new Error("legacy storage disabled"); },
      oauth: { enabled: true, issuer, store: new FileOAuthStore(join(root, "oauth")) }, workspaceWeb: web });
    server.on("close", () => store.close());
    return { server, url: `${issuer}/admin` };
  } catch (error) { store.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalWorkspaceConsole(process.argv.slice(2)).then(({ server, url }) => {
    process.stdout.write(`Local development only: ${url}\nNo production vaults or credentials are loaded.\n`);
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  }).catch(() => { process.stderr.write("Local console did not start. Supply a clean development directory, explicit policies and a dedicated development GitHub app.\n"); process.exitCode = 1; });
}
