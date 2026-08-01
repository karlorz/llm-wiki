import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";

function vaultRelative(vaultReal: string, candidate: string): string {
  return relative(vaultReal, candidate).split(sep).join("/");
}

function isInside(vaultReal: string, candidate: string): boolean {
  const rel = vaultRelative(vaultReal, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

export function existingRegularFileInsideVaultSync(vault: string, target: string): boolean {
  try {
    const vaultReal = realpathSync(vault);
    const absolutePath = resolve(vaultReal, target);
    const rel = vaultRelative(vaultReal, absolutePath);
    if (!isInside(vaultReal, absolutePath) || rel === "") return false;
    let current = vaultReal;
    for (const part of rel.split("/").filter(Boolean)) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) return false;
    }
    const info = lstatSync(absolutePath);
    return info.isFile() && !info.isSymbolicLink() && realpathSync(absolutePath) === absolutePath;
  } catch {
    return false;
  }
}

async function canonicalVault(vault: string, target: string): Promise<Result<string>> {
  try {
    return ok(await realpath(vault));
  } catch (error) {
    return err("VAULT_PATH_INVALID", { target, message: "vault realpath failed", cause: String(error) });
  }
}

async function rejectSymlinkedComponents(vaultReal: string, absolutePath: string, target: string): Promise<Result<true>> {
  const rel = vaultRelative(vaultReal, absolutePath);
  if (!isInside(vaultReal, absolutePath) || rel === "") {
    return err("VAULT_PATH_INVALID", { target, message: "target escapes vault" });
  }
  const parts = rel.split("/").filter(Boolean);
  let current = vaultReal;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        return err("VAULT_PATH_INVALID", { target, message: "target path may not contain symlink aliases" });
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return err("VAULT_PATH_INVALID", { target, message: "target lstat failed", cause: String(error) });
    }
  }
  return ok(true);
}

export async function resolveExistingRegularFileInsideVault(vault: string, target: string): Promise<Result<string>> {
  const vaultResult = await canonicalVault(vault, target);
  if (!vaultResult.ok) return vaultResult;
  const vaultReal = vaultResult.data;
  const absolutePath = resolve(vaultReal, target);
  const components = await rejectSymlinkedComponents(vaultReal, absolutePath, target);
  if (!components.ok) return components;
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return err("VAULT_PATH_INVALID", { target, message: "target must be a regular non-symlink file" });
    }
    const targetReal = await realpath(absolutePath);
    if (!isInside(vaultReal, targetReal) || targetReal !== absolutePath) {
      return err("VAULT_PATH_INVALID", { target, message: "target realpath escapes vault or uses an alias" });
    }
    return ok(absolutePath);
  } catch (error) {
    return err("FILE_NOT_FOUND", { path: target, message: String(error) });
  }
}

export async function resolveAbsentTargetInsideVault(vault: string, target: string): Promise<Result<string>> {
  const vaultResult = await canonicalVault(vault, target);
  if (!vaultResult.ok) return vaultResult;
  const vaultReal = vaultResult.data;
  const absolutePath = resolve(vaultReal, target);
  const components = await rejectSymlinkedComponents(vaultReal, dirname(absolutePath), target);
  if (!components.ok) return components;
  try {
    await lstat(absolutePath);
    return err("RAW_DESTINATION_EXISTS", { path: target });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err("VAULT_PATH_INVALID", { target, message: "destination lstat failed", cause: String(error) });
    }
  }
  return ok(absolutePath);
}
