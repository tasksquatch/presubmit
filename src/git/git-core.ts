import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultGitExec, type GitExec } from "./exec.js";

const execFileAsync = promisify(execFile);

/**
 * Return true when `git` is on PATH and responds to `--version`.
 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve current HEAD SHA.
 */
export async function getHeadSha(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<string | null> {
  try {
    const stdout = await exec(["rev-parse", "HEAD"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getRepoRoot(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<string> {
  const root = (await exec(["rev-parse", "--show-toplevel"], cwd)).trim();
  if (!root) {
    throw new Error("Unable to resolve git repository root");
  }
  return root;
}

/**
 * Current branch name, or `"HEAD"` when detached.
 */
export async function getCurrentBranch(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<string> {
  return (await exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
}

/**
 * Porcelain status output (empty when clean).
 */
export async function getWorktreeStatus(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<string> {
  return (await exec(["status", "--porcelain"], cwd)).trimEnd();
}

/**
 * Resolve a revision to a full SHA (`git rev-parse --verify`).
 */
export async function resolveSha(
  rev: string,
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<string> {
  return (await exec(["rev-parse", "--verify", `${rev}^{commit}`], cwd)).trim();
}

/**
 * True when `sha` is an ancestor of `ref` (or equal).
 */
export async function isShaAncestorOf(
  sha: string,
  ref: string,
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<boolean> {
  try {
    await exec(["merge-base", "--is-ancestor", sha, ref], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upstream symbolic name (e.g. `origin/main`), or null if unset.
 */
export async function getUpstreamRef(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<string | null> {
  try {
    const ref = (
      await exec(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        cwd,
      )
    ).trim();
    return ref || null;
  } catch {
    return null;
  }
}
