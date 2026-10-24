import type { VaultRegistryEntry } from "./vault-registry.js";
import { workspaceHash } from "./workspace-store.js";

/** Display labels and health intervals do not change the immutable data binding. */
export function workspaceBindingHash(entry: VaultRegistryEntry): string {
  return workspaceHash(JSON.stringify({
    vaultId: entry.vaultId, localRoot: entry.localRoot,
    rcloneRemote: entry.rcloneRemote, rclonePath: entry.rclonePath,
    s3Endpoint: entry.s3Endpoint ?? "", s3Bucket: entry.s3Bucket ?? "",
    s3Prefix: entry.s3Prefix, s3Region: entry.s3Region,
  }));
}
