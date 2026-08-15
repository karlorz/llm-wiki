import { execFile } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import type { CommandRunOptions, CommandRunResult, CommandRunner } from "./types.js";

export function createCommandRunner(): CommandRunner {
  return (command, args, options) => execTool(command, args, options);
}

/**
 * execFile wrapper. On POSIX this is byte-identical to a plain execFile call
 * (no shell). On Windows the command is routed through cmd.exe so `.cmd`/`.bat`
 * shims (npm, git, gh, ...) resolve from PATH; arguments containing spaces or
 * cmd metacharacters are double-quoted because Node's `shell: true` path only
 * concatenates args without escaping. Mirrors packages/agent-memory-trends/
 * src/exec-utils.ts (maintenance cannot import from the sibling package).
 */
function platformExecFile(
  file: string,
  args: string[],
  options: { cwd?: string; encoding?: "utf8"; env?: NodeJS.ProcessEnv },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
): ChildProcess {
  if (process.platform !== "win32") {
    return execFile(file, args, options, (error, stdout, stderr) =>
      callback(error, String(stdout), String(stderr))
    );
  }
  const command = [file, ...args].map(quoteCmdArg).join(" ");
  return execFile(
    process.env.comspec || "cmd.exe",
    ["/d", "/s", "/c", command],
    { ...options, windowsVerbatimArguments: true },
    (error, stdout, stderr) => callback(error, String(stdout), String(stderr))
  );
}

const CMD_SPECIAL = /[\s"&|<>^()%!]/;

function quoteCmdArg(part: string): string {
  return CMD_SPECIAL.test(part) ? `"${part}"` : part;
}

function execTool(command: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    platformExecFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : process.env,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}
