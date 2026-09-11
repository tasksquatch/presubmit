import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/**
 * Injectable git executor for discovery/integrity (and tests).
 */
export type GitExec = (args: string[], cwd: string) => Promise<string>;

export const defaultGitExec: GitExec = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as {
      message?: string;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr
          ? e.stderr.toString()
          : "";
    throw new GitCommandError(
      e.message ?? `git ${args.join(" ")} failed`,
      args,
      stderr.trim(),
    );
  }
};
