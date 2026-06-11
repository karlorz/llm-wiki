import { execFile } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export function createGitRunner(cwd: string): CommandRunner {
  return (args) => execTool("git", args, cwd);
}

export function createSkillwikiRunner(cwd: string): CommandRunner {
  return (args) => execTool("skillwiki", args, cwd);
}

function execTool(tool: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(tool, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}
