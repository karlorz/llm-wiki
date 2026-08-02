#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [expectedVersion, lockfileArg = "package-lock.json"] = process.argv.slice(2);

if (!expectedVersion) {
  console.error("Usage: node scripts/check-release-lockfile.mjs <expected-version> [package-lock.json]");
  process.exit(2);
}

const lockfilePath = resolve(lockfileArg);
let lockfile;

try {
  lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
} catch (error) {
  console.error(`[release-lockfile] ERROR: cannot read or parse ${lockfilePath}: ${error.message}`);
  process.exit(1);
}

const errors = [];
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const checkVersion = (label, actual) => {
  if (actual !== expectedVersion) {
    errors.push(`${label}: expected ${expectedVersion}, found ${JSON.stringify(actual)}`);
  }
};

checkVersion("version", lockfile.version);

if (!isRecord(lockfile.packages)) {
  errors.push('packages: expected an object containing the root entry ""');
} else {
  const root = lockfile.packages[""];
  if (!isRecord(root)) {
    errors.push('packages[""]: expected a root package object');
  } else {
    checkVersion('packages[""].version', root.version);

    if (!Array.isArray(root.workspaces) || root.workspaces.some((entry) => typeof entry !== "string")) {
      errors.push('packages[""].workspaces: expected an array of workspace paths');
    } else {
      for (const workspace of root.workspaces) {
        const entry = lockfile.packages[workspace];
        if (!isRecord(entry)) {
          errors.push(`packages[${JSON.stringify(workspace)}]: expected a workspace package object`);
        }
      }

      for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
        if (
          /^packages\/[^/]+$/.test(packagePath) &&
          isRecord(entry) &&
          Object.hasOwn(entry, "version")
        ) {
          checkVersion(`packages[${JSON.stringify(packagePath)}].version`, entry.version);
        }
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[release-lockfile] ERROR: ${error}`);
  }
  process.exit(1);
}

const versionedPackageCount = Object.entries(lockfile.packages).filter(
  ([packagePath, entry]) =>
    /^packages\/[^/]+$/.test(packagePath) &&
    isRecord(entry) &&
    Object.hasOwn(entry, "version"),
).length;
console.log(
  `[release-lockfile] OK: ${expectedVersion} matches root metadata and ${versionedPackageCount} versioned package(s)`,
);
