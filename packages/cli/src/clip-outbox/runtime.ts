import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { ResolvedClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { loadClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { parseDotenvFile } from "../utils/dotenv.js";

const s3Schema = z.object({ endpoint: z.string().url(), region: z.string().default("us-east-1"), accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().optional() }).strict();
export type ClipCredentials = { s3: z.infer<typeof s3Schema>; readyToken: string };

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
    const endpoint = new URL(s3.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
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
