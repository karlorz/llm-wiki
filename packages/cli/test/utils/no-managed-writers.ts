import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface NoManagedWritersEnv {
  withNoManagedWriters(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  cleanup(): void;
}

/**
 * Isolate CLI child-process tests from unrelated host writer processes.
 *
 * The production peer gate still runs normally; only the OS process-list
 * command used by these temporary-vault tests is replaced in the child
 * environment. Lock files and stash audits remain real.
 */
export function createNoManagedWritersEnv(): NoManagedWritersEnv {
  const binDir = mkdtempSync(join(tmpdir(), "skillwiki-test-processes-"));

  if (process.platform === "win32") {
    writeFileSync(
      join(binDir, "tasklist.cmd"),
      ["@echo off", "exit /b 0", ""].join("\r\n"),
    );
  } else {
    const ps = join(binDir, "ps");
    writeFileSync(
      ps,
      [
        "#!/bin/sh",
        'if [ "${1:-}" = "-axo" ] && [ "${2:-}" = "pid=,command=" ]; then',
        "  exit 0",
        "fi",
        'exec /bin/ps "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(ps, 0o755);
  }

  return {
    withNoManagedWriters(env = process.env): NodeJS.ProcessEnv {
      return {
        ...env,
        PATH: [binDir, env.PATH].filter(Boolean).join(delimiter),
      };
    },
    cleanup(): void {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}
