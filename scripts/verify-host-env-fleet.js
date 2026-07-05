#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const repoRoot = path.resolve(__dirname, "..");
const hostsDir = process.env.HOST_ENV_DIR || path.join(repoRoot, "scripts", "hosts");
const defaultFleetPath = path.join(
  os.homedir(),
  "wiki",
  "projects",
  "llm-wiki",
  "architecture",
  "fleet.yaml",
);
const fleetPath = process.env.FLEET_PATH || defaultFleetPath;

// CI may not have the private vault checkout. Keep a small fallback for the
// committed host profiles whose safety metadata is required by CI gates.
const fallbackFleet = {
  hosts: {
    "macos-dev": {
      class: "dev-macos",
      role: "leaf",
      protected: false,
    },
    sg01: {
      class: "prod-linux",
      role: "snapshotter",
      protected: true,
    },
    sg02: {
      class: "dev-linux",
      role: "leaf",
      protected: false,
      maintenance: {
        skillwiki_satellite: {
          enabled: true,
          vault_path: "/home/agent-memory/wiki",
          scheduler: "systemd",
        },
      },
    },
  },
};

const requiredKeys = [
  "SSH_HOST",
  "SSH_USER",
  "HOST_CLASS",
  "HOST_ROLE",
  "INSTALL_ALLOWED",
  "DESTRUCTIVE_ALLOWED",
  "READONLY_VERIFY",
  "RCLONE_REQUIRED",
  "SCHEDULER",
  "VAULT_PATH",
  "EXPECTED_VERSION_SOURCE",
];

function loadFleet() {
  if (fs.existsSync(fleetPath)) {
    return {
      source: fleetPath,
      data: yaml.load(fs.readFileSync(fleetPath, "utf8")),
      fallback: false,
    };
  }
  return {
    source: "built-in fallback host expectations",
    data: fallbackFleet,
    fallback: true,
  };
}

function parseEnvFile(filePath) {
  const values = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new Error(`${filePath}:${index + 1}: expected KEY=value`);
    }
    values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

function resolveFleetHost(envFile, env, hosts) {
  const stem = path.basename(envFile, ".env");
  if (env.SSH_HOST && hosts[env.SSH_HOST]) {
    return { id: env.SSH_HOST, host: hosts[env.SSH_HOST] };
  }
  if (hosts[stem]) {
    return { id: stem, host: hosts[stem] };
  }
  return { id: env.SSH_HOST || stem, host: null };
}

function checkEqual(errors, label, actual, expected, context) {
  if (actual !== expected) {
    errors.push(`${context}: ${label} is ${actual || "unset"} (expected ${expected})`);
  }
}

function validateHostEnv(envFile, env, fleetHosts) {
  const errors = [];
  const { id, host } = resolveFleetHost(envFile, env, fleetHosts);
  const context = path.relative(repoRoot, envFile);

  for (const key of requiredKeys) {
    if (!env[key]) {
      errors.push(`${context}: missing required key ${key}`);
    }
  }

  for (const key of ["INSTALL_ALLOWED", "DESTRUCTIVE_ALLOWED", "READONLY_VERIFY", "RCLONE_REQUIRED"]) {
    if (env[key] && !["true", "false"].includes(env[key])) {
      errors.push(`${context}: ${key} must be true or false (got ${env[key]})`);
    }
  }

  if (env.READONLY_VERIFY === "true") {
    checkEqual(errors, "INSTALL_ALLOWED", env.INSTALL_ALLOWED, "false", context);
    checkEqual(errors, "DESTRUCTIVE_ALLOWED", env.DESTRUCTIVE_ALLOWED, "false", context);
  }

  if (!host) {
    errors.push(`${context}: ${id} is not present in fleet metadata`);
    return errors;
  }

  checkEqual(errors, "HOST_CLASS", env.HOST_CLASS, host.class, context);
  checkEqual(errors, "HOST_ROLE", env.HOST_ROLE, host.role, context);

  if (host.protected === true) {
    checkEqual(errors, "READONLY_VERIFY", env.READONLY_VERIFY, "true", context);
    checkEqual(errors, "INSTALL_ALLOWED", env.INSTALL_ALLOWED, "false", context);
    checkEqual(errors, "DESTRUCTIVE_ALLOWED", env.DESTRUCTIVE_ALLOWED, "false", context);
  }

  const satellite = host.maintenance && host.maintenance.skillwiki_satellite;
  if (satellite && satellite.enabled === true) {
    if (satellite.vault_path) {
      checkEqual(errors, "VAULT_PATH", env.VAULT_PATH, satellite.vault_path, context);
    }
    if (satellite.scheduler) {
      checkEqual(errors, "SCHEDULER", env.SCHEDULER, satellite.scheduler, context);
    }
  }

  return errors;
}

function main() {
  const { source, data, fallback } = loadFleet();
  const fleetHosts = (data && data.hosts) || {};
  const envFiles = fs
    .readdirSync(hostsDir)
    .filter((name) => name.endsWith(".env"))
    .sort()
    .map((name) => path.join(hostsDir, name));

  const errors = [];
  const snapshotters = Object.entries(fleetHosts).filter(([, host]) => host.role === "snapshotter");
  if (snapshotters.length !== 1) {
    errors.push(`fleet metadata: expected exactly one snapshotter, found ${snapshotters.length}`);
  }

  for (const envFile of envFiles) {
    let env;
    try {
      env = parseEnvFile(envFile);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    errors.push(...validateHostEnv(envFile, env, fleetHosts));
  }

  if (fallback) {
    console.log(`! Fleet metadata not found at ${fleetPath}; using built-in host expectations`);
  } else {
    console.log(`✓ Loaded fleet metadata from ${source}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`✗ ${error}`);
    }
    process.exit(1);
  }

  console.log(`✓ ${envFiles.length} host env file(s) match fleet maintenance metadata`);
}

main();
