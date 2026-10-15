import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWriteText } from "../utils/atomic-write.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { expandUserPath, nestedOrEqual, PRODUCTION_WATCHER_LABEL, resolveClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { evidencePath, loadClipCredentials, validateRuntime } from "./runtime.js";

export const CLIP_MIGRATION_HINT = "Clip channel requires attended setup: run skillwiki clip-outbox install-or-migrate, then skillwiki doctor. Installation/update never sets clip_outbox.enabled=true or loads launchd. Prove deployed SeaweedFS If-None-Match:* create-only before operator enablement.";
export const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export async function packagedPlist(): Promise<string> {
  for (const rel of ["../templates/launchd/", "../../templates/launchd/"]) {
    try { return await readFile(new URL(`${rel}${PRODUCTION_WATCHER_LABEL}.plist`, import.meta.url), "utf8"); } catch { /* source/dist layouts */ }
  }
  throw new Error("packaged clip launchd template missing");
}
export async function stableCliBinary(argvPath = process.argv[1]): Promise<string> {
  // Keep the npm bin symlink, rather than its resolved package/version target.
  const candidates = [argvPath, ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(":")].map((dir) => join(dir, "skillwiki"))];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || basename(candidate) !== "skillwiki") continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next prefix */ }
  }
  throw new Error("global npm skillwiki binary not found; install/link the CLI before migrating");
}
export async function migrateClipOutbox(input: { home: string; load?: boolean; conditionalCreateProven?: boolean; binaryPath?: string; nodePath?: string; platform?: string; launch?: (args: string[]) => void }): Promise<{ plistPath: string; loaded: boolean; enabled: boolean; humanHint: string }> {
  const map = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  const resolved = resolveClipOutboxConfig(map as Record<string, string>, input.home);
  if (!resolved.ok) throw new Error(resolved.message);
  if (input.load && (!resolved.enabled || !input.conditionalCreateProven)) throw new Error("--load requires existing clip_outbox.enabled=true and --conditional-create-proven after the operator's deployed create-only race test");
  if ((input.platform ?? process.platform) !== "darwin") throw new Error("clip launchd migration requires macOS");
  // Validate the topology while disabled too, without persisting an enable flag.
  const rawRoot = map["clip_outbox.root"] ?? "~/Obsidian/clip-outbox";
  const root = resolved.enabled ? resolved.config.root : expandUserPath(rawRoot, input.home);
  if (!isAbsolute(root) || root.includes("\0") || rawRoot.split("/").includes("..")) throw new Error("invalid outbox root");
  const mirror = resolved.enabled ? resolved.config.mirrorRoot : expandUserPath(map["clip_outbox.mirror_root"] ?? join(input.home, "wiki"), input.home);
  if (nestedOrEqual(root, mirror)) throw new Error("outbox must be disjoint from mirror");
  const binary = input.binaryPath ?? await stableCliBinary();
  if (!isAbsolute(binary) || !isAbsolute(input.nodePath ?? process.execPath)) throw new Error("absolute executable paths required");
  const logRoot = join(input.home, "Library", "Logs", "SkillWiki");
  const plistPath = join(input.home, "Library", "LaunchAgents", `${PRODUCTION_WATCHER_LABEL}.plist`);
  const template = await packagedPlist();
  let plist = template;
  for (const [key, value] of Object.entries({ NODE_BINARY: input.nodePath ?? process.execPath, CLI_BINARY: binary, OUTBOX_ROOT: root, HOME: input.home, LOG_ROOT: logRoot })) plist = plist.replaceAll(`@${key}@`, xml(value));
  if (input.load) {
    if (!resolved.enabled) throw new Error("--load requires existing clip_outbox.enabled=true and --conditional-create-proven after the operator's deployed create-only race test");
    const creds = await loadClipCredentials(input.home, resolved.config);
    await mkdir(resolved.config.stateRoot, { recursive: true, mode: 0o700 });
    const proof = await atomicWriteText(evidencePath(resolved.config), JSON.stringify({ verified: true, destination: resolved.config.destination, endpoint: creds.s3.endpoint, testedAt: new Date().toISOString(), basis: "operator-attested deployed If-None-Match:* race test" }));
    if (!proof.ok) throw new Error("cannot record operator conditional-create attestation");
    await validateRuntime(input.home, resolved.config, creds.s3.endpoint);
  }
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(logRoot, { recursive: true });
  const result = await atomicWriteText(plistPath, plist);
  if (!result.ok) throw new Error("cannot refresh clip plist");
  if (input.load) {
    if (typeof process.getuid !== "function") throw new Error("clip launchd load requires macOS");
    const domain = `gui/${process.getuid()}`;
    const launch = input.launch ?? ((args: string[]) => { execFileSync("launchctl", args, { stdio: "ignore", timeout: 5000 }); });
    // bootout may report not loaded; bootstrap/enable failures remain fatal.
    try { launch(["bootout", `${domain}/${PRODUCTION_WATCHER_LABEL}`]); } catch { /* absent is normal on first install */ }
    launch(["enable", `${domain}/${PRODUCTION_WATCHER_LABEL}`]);
    launch(["bootstrap", domain, plistPath]);
  }
  return { plistPath, loaded: !!input.load, enabled: resolved.enabled, humanHint: `${result.data.changed ? "Refreshed" : "Current"} clip launchd plist: ${plistPath}. ${input.load ? "Operator-gated launchd bootstrap requested." : CLIP_MIGRATION_HINT}` };
}

/** Refresh an already-installed clip plist after CLI upgrade. Never creates or loads a job. */
export async function refreshInstalledClipPlist(
  home: string,
  opts?: Omit<Parameters<typeof migrateClipOutbox>[0], "home" | "load">,
): Promise<string | undefined> {
  const plistPath = join(home, "Library", "LaunchAgents", `${PRODUCTION_WATCHER_LABEL}.plist`);
  try { await access(plistPath, constants.F_OK); }
  catch { return undefined; }
  const result = await migrateClipOutbox({ ...opts, home, load: false });
  return result.humanHint;
}
