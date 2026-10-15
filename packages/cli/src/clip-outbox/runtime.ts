import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { ipv4InCidr } from "@skillwiki/shared";
import type { ResolvedClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { loadClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { defaultLookup, type LookupFn } from "./ssrf.js";

const s3Schema = z.object({ endpoint: z.string().url(), region: z.string().default("us-east-1"), accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().optional() }).strict();
export type ClipCredentials = { s3: z.infer<typeof s3Schema>; readyToken: string };

/** Private LAN/loopback IPv4/IPv6 used only for http SeaweedFS, never public HTTP. */
export function isRfc1918OrLoopback(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return ipv4InCidr(address, "10.0.0.0", 8)
      || ipv4InCidr(address, "172.16.0.0", 12)
      || ipv4InCidr(address, "192.168.0.0", 16)
      || ipv4InCidr(address, "127.0.0.0", 8);
  }
  return version === 6 && address.toLowerCase() === "::1";
}

/** https anywhere is allowed; http only when every resolved address is RFC1918 or loopback. */
export async function assertClipS3Endpoint(endpoint: string, lookup: LookupFn = defaultLookup): Promise<void> {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error("invalid clip S3 endpoint");
  if (url.protocol === "https:") return;
  if (url.protocol !== "http:") throw new Error("invalid clip S3 endpoint");
  const addresses = isIP(url.hostname) ? [url.hostname] : await lookup(url.hostname);
  if (addresses.length === 0 || !addresses.every(isRfc1918OrLoopback)) {
    throw new Error("http clip S3 endpoint must resolve only to RFC1918 or loopback");
  }
}

/** Protected host-only provider map; never read arbitrary vault paths or log values. */
export async function loadClipCredentials(home: string, config: ResolvedClipOutboxConfig, env: NodeJS.ProcessEnv = process.env): Promise<ClipCredentials> {
  let providers: Record<string, unknown> = {};
  const path = join(home, ".skillwiki", "clip-outbox-credentials.json");
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) throw new Error("protected credential file required");
    providers = JSON.parse(await readFile(path, "utf8"));
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("clip credential provider unreadable"); }
  try {
    const rawS3 = env[config.s3CredentialRef] ?? providers[config.s3CredentialRef];
    const s3 = s3Schema.parse(typeof rawS3 === "string" ? JSON.parse(rawS3) : rawS3);
    await assertClipS3Endpoint(s3.endpoint);
    const hostConfig = await parseDotenvFile(join(home, ".skillwiki", ".env"));
    const readyToken = env[config.readyCredentialRef] ?? providers[config.readyCredentialRef];
    if (typeof readyToken !== "string" || !readyToken || config.readyCredentialRef === "SKILLWIKI_MCP_TOKEN" || readyToken === env.SKILLWIKI_MCP_TOKEN || readyToken === hostConfig.SKILLWIKI_MCP_TOKEN || config.readyCredentialRef === config.s3CredentialRef) throw new Error();
    return { s3, readyToken };
  } catch { throw new Error("clip credential references missing or invalid; use a separate file-ingress token"); }
}
export const evidencePath = (config: ResolvedClipOutboxConfig) => join(config.stateRoot, "conditional-create.json");
export async function conditionalCreateProven(config: ResolvedClipOutboxConfig, endpoint: string): Promise<boolean> {
  try {
    const proof = JSON.parse(await readFile(evidencePath(config), "utf8"));
    return proof.verified === true && proof.destination === config.destination && proof.endpoint === endpoint && typeof proof.testedAt === "string" && Number.isFinite(Date.parse(proof.testedAt));
  } catch { return false; }
}
export async function validateRuntime(home: string, config: ResolvedClipOutboxConfig, endpoint: string): Promise<void> {
  const resolved = await loadClipOutboxConfig(home);
  if (!resolved.ok || !resolved.enabled || JSON.stringify(resolved.config) !== JSON.stringify(config)) throw new Error("clip configuration changed; restart after attended review");
  if (!existsSync(join(config.mirrorRoot, ".WIKI_GIT_FROZEN"))) throw new Error("frozen mirror marker missing");
  const map = await parseDotenvFile(join(home, ".skillwiki", ".env"));
  if (map["vault_sync.push_enabled"] !== "false") throw new Error("wiki-push must remain disabled");
  try {
    execFileSync("launchctl", ["list", "com.karlchow.wiki-push"], { stdio: "ignore", timeout: 2000 });
    throw new Error("wiki-push is loaded");
  } catch (e) { if (!(e as { status?: number }).status) throw e; }
  if (!await conditionalCreateProven(config, endpoint)) throw new Error("conditional-create evidence missing for this endpoint and destination");
}
