#!/usr/bin/env node
/**
 * Post-tsup asset copy for skillwiki CLI (cross-platform).
 * Copies skills package + vault-sync helper scripts into package output.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsSrc = join(cliRoot, "..", "skills");
const skillsDst = join(cliRoot, "skills");
const vaultScriptsSrc = join(cliRoot, "..", "vault-sync", "scripts");
const vaultScriptsDst = join(cliRoot, "dist", "vault-sync", "scripts");

function replaceDir(src, dst) {
  if (!existsSync(src)) {
    throw new Error(`missing source directory: ${src}`);
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

replaceDir(skillsSrc, skillsDst);
replaceDir(vaultScriptsSrc, vaultScriptsDst);
console.log("copied skills and dist/vault-sync/scripts");
