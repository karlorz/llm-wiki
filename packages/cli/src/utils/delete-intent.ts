import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const DELETE_INTENT_SCHEMA = "vault-delete-intent/v1" as const;
export const DELETE_INTENT_DIR = "meta/delete-intents";

export type DeleteIntentAction = "remove" | "archive";
export type DeleteIntentSource = "cli" | "failsafe-git";

export interface DeleteIntentV1 {
  schema: typeof DELETE_INTENT_SCHEMA;
  path: string;
  action: DeleteIntentAction;
  created: string;
  host: string;
  actor: string;
  reason?: string;
  source: DeleteIntentSource;
  expires?: string | null;
}

export function normalizeVaultRelPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("..") || p.startsWith(".git/")) {
    throw new Error(`invalid vault-relative path: ${path}`);
  }
  return p;
}

export function pathToIntentFilename(path: string): string {
  const p = normalizeVaultRelPath(path);
  return `${p.replace(/\//g, "__")}.json`;
}

export function buildDeleteIntent(input: {
  path: string;
  action: DeleteIntentAction;
  host: string;
  actor: string;
  source: DeleteIntentSource;
  reason?: string;
  expires?: string | null;
  created?: string;
}): DeleteIntentV1 {
  return {
    schema: DELETE_INTENT_SCHEMA,
    path: normalizeVaultRelPath(input.path),
    action: input.action,
    created: input.created ?? new Date().toISOString(),
    host: input.host,
    actor: input.actor,
    reason: input.reason,
    source: input.source,
    expires: input.expires ?? null,
  };
}

export function isActiveDeleteIntent(intent: DeleteIntentV1, now = new Date()): boolean {
  if (intent.schema !== DELETE_INTENT_SCHEMA) return false;
  if (!intent.path || !intent.action) return false;
  if (intent.expires == null || intent.expires === "") return true;
  const exp = new Date(intent.expires).getTime();
  if (Number.isNaN(exp)) return false;
  return exp > now.getTime();
}

export async function writeDeleteIntent(vault: string, intent: DeleteIntentV1): Promise<string> {
  const dir = join(vault, DELETE_INTENT_DIR);
  await mkdir(dir, { recursive: true });
  const rel = `${DELETE_INTENT_DIR}/${pathToIntentFilename(intent.path)}`;
  await writeFile(join(vault, rel), JSON.stringify(intent, null, 2) + "\n", "utf8");
  return rel;
}

export async function listActiveDeleteIntentPaths(vault: string, now = new Date()): Promise<string[]> {
  const dir = join(vault, DELETE_INTENT_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as DeleteIntentV1;
      if (isActiveDeleteIntent(raw, now)) paths.push(raw.path);
    } catch {
      /* skip corrupt */
    }
  }
  return [...new Set(paths)].sort();
}
