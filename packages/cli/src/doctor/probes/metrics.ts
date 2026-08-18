import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReadOnlyVaultRoot, scanVault } from "../../utils/vault.js";
import { buildWikilinkAdjacency, toUndirectedWeighted, louvain, communityCohesion } from "../../utils/community.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

const METRIC_TYPES = ["entities", "concepts", "comparisons", "queries", "meta"];

/**
 * Prefer the same read-only vault mirror lint uses (e.g. /root/wiki-git on sg01)
 * so doctor metrics/conflict/dsstore walks do not amplify rclone FUSE latency.
 */
export function doctorReadOnlyScanRoot(resolvedPath: string): string {
  return resolveReadOnlyVaultRoot(resolvedPath).root;
}

/**
 * Vault graph/health metrics (info severity — never affect exit code).
 * Always returns exactly 5 rows so the doctor check count stays stable;
 * when no vault is configured each row reports "no vault configured".
 * Reuses utils/community.ts (no duplicated graph pass).
 */
export async function vaultMetrics(resolvedPath: string | undefined): Promise<CheckResult[]> {
  const ids = [
    ["vault_metric_pages", "Vault pages by type"],
    ["vault_metric_orphans", "Vault orphan rate"],
    ["vault_metric_bridges", "Vault bridge count"],
    ["vault_metric_cohesion", "Mean community cohesion"],
    ["vault_metric_log_size", "Vault log size"],
  ] as const;
  const noVault = (): CheckResult[] => ids.map(([id, label]) => check("info", id, label, "no vault configured"));

  if (!resolvedPath) return noVault();
  const scanRoot = doctorReadOnlyScanRoot(resolvedPath);
  const scan = await scanVault(scanRoot);
  if (!scan.ok) return noVault();

  const tk = scan.data.typedKnowledge;
  const typedCount = tk.length;
  const perType = METRIC_TYPES.map(d => `${d} ${tk.filter(p => p.relPath.startsWith(d + "/")).length}`).join(", ");

  const adj = await buildWikilinkAdjacency(tk, undefined, scan.data.allMarkdown);
  const g = toUndirectedWeighted(adj);
  const nodes = [...g.keys()];
  const total = nodes.length;

  const orphanCount = nodes.filter(n => g.get(n)!.size === 0).length;
  const orphanRate = total > 0 ? Math.round((orphanCount / total) * 1000) / 10 : 0;

  const comm = louvain(g);
  const groups = new Map<number, string[]>();
  for (const [node, c] of comm) {
    const arr = groups.get(c);
    if (arr) arr.push(node); else groups.set(c, [node]);
  }
  const cohesions = [...groups.values()].filter(m => m.length >= 2).map(m => communityCohesion(m, g));
  const meanCohesion = cohesions.length > 0
    ? Math.round((cohesions.reduce((a, b) => a + b, 0) / cohesions.length) * 1000) / 1000
    : 0;

  let bridges = 0;
  for (const n of nodes) {
    const nbrComms = new Set<number>();
    for (const nb of g.get(n)!.keys()) nbrComms.add(comm.get(nb)!);
    if (nbrComms.size >= 3) bridges++;
  }

  let logLines = 0;
  try { logLines = readFileSync(join(scanRoot, "log.md"), "utf8").split("\n").length; } catch { /* no log.md */ }

  return [
    check("info", "vault_metric_pages", "Vault pages by type", `${total} graph node(s) (${typedCount} typed; ${perType})`),
    check("info", "vault_metric_orphans", "Vault orphan rate", `${orphanRate}% (${orphanCount}/${total} degree-0)`),
    check("info", "vault_metric_bridges", "Vault bridge count", `${bridges} page(s) link >= 3 communities`),
    check("info", "vault_metric_cohesion", "Mean community cohesion", `${meanCohesion} across ${cohesions.length} communities (size >= 2)`),
    check("info", "vault_metric_log_size", "Vault log size", `${logLines} lines`),
  ];
}

export const metricsProbe: DoctorProbe = {
  id: "metrics",
  async run(ctx: DoctorContext): Promise<CheckResult[]> {
    return await vaultMetrics(ctx.resolvedPath);
  },
};
