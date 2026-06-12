import { execFile } from "node:child_process";
import type { CommandRunResult, CommandRunner } from "./types.js";

export function createCommandRunner(): CommandRunner {
  return (command, args, options) => execTool(command, args, options.cwd);
}

function execTool(command: string, args: string[], cwd: string): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}
