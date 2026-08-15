import { execFile } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";

export interface PlatformExecFileOptions {
  cwd?: string;
  encoding?: "utf8";
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export type PlatformExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string
) => void;

/**
 * execFile wrapper. On POSIX this is byte-identical to a plain execFile call
 * (no shell). On Windows the command is routed through cmd.exe so `.cmd`/`.bat`
 * shims (npm, git, gh, ...) resolve from PATH; arguments containing spaces or
 * cmd metacharacters are double-quoted because Node's `shell: true` path only
 * concatenates args without escaping.
 */
export function platformExecFile(
  file: string,
  args: string[],
  options: PlatformExecFileOptions,
  callback: PlatformExecFileCallback
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
    // windowsVerbatimArguments keeps our pre-built command line intact;
    // without it Node re-quotes args with backslash escapes cmd.exe rejects.
    { ...options, windowsVerbatimArguments: true },
    (error, stdout, stderr) => callback(error, String(stdout), String(stderr))
  );
}

/** PATH list separator: ";" on Windows, ":" elsewhere. */
export function pathDelimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

const CMD_SPECIAL = /[\s"&|<>^()%!]/;

function quoteCmdArg(part: string): string {
  return CMD_SPECIAL.test(part) ? `"${part}"` : part;
}
