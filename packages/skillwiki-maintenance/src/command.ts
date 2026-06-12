import { execFile } from "node:child_process";
import type { CommandRunOptions, CommandRunResult, CommandRunner } from "./types.js";

export function createCommandRunner(): CommandRunner {
  return (command, args, options) => execTool(command, args, options);
}

function execTool(command: string, args: string[], options: CommandRunOptions): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
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
