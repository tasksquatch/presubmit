import {
  getCurrentBranch,
  getHeadSha,
  getRepoRoot,
} from "./git-core.js";
import { defaultGitExec, type GitExec } from "./exec.js";
import {
  resolveGitHubRepo,
  type GitHubRepoRef,
} from "./remote.js";

export interface RepoState {
  root: string;
  headSha: string;
  branch: string;
  remoteName: string;
  repo: GitHubRepoRef | null;
}

export class GitDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiscoveryError";
  }
}

/**
 * Discover repository root, HEAD, branch, and GitHub owner/repo.
 */
export async function discoverRepoState(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<RepoState> {
  let root: string;
  try {
    root = await getRepoRoot(cwd, exec);
  } catch {
    throw new GitDiscoveryError(
      `Not a git repository (or any of the parent directories): ${cwd}`,
    );
  }

  const headSha = await getHeadSha(root, exec);
  if (!headSha) {
    throw new GitDiscoveryError(
      "Unable to resolve HEAD SHA. Create an initial commit and retry.",
    );
  }

  const branch = await getCurrentBranch(root, exec);
  const repo = await resolveGitHubRepo(root, exec);
  const remoteName = "origin";

  return {
    root,
    headSha,
    branch,
    remoteName,
    repo,
  };
}
