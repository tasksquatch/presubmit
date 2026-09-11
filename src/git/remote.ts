import { defaultGitExec, type GitExec } from "./exec.js";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into owner/repo for github.com (SSH or HTTPS).
 */
export function parseGitHubRemoteUrl(url: string): GitHubRepoRef | null {
  const trimmed = url.trim().replace(/\.git$/i, "");

  // git@github.com:owner/repo
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2] };
  }

  // ssh://git@github.com/owner/repo
  const sshAlt = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (sshAlt) {
    return { owner: sshAlt[1], repo: sshAlt[2] };
  }

  // https://github.com/owner/repo
  const https = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i.exec(
    trimmed,
  );
  if (https) {
    return { owner: https[1], repo: https[2] };
  }

  return null;
}

/**
 * Resolve owner/repo from `origin`, falling back to the first remote.
 */
export async function resolveGitHubRepo(
  cwd: string = process.cwd(),
  exec: GitExec = defaultGitExec,
): Promise<GitHubRepoRef | null> {
  const remotes = await listRemotes(cwd, exec);
  const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
  if (!origin) {
    return null;
  }
  return parseGitHubRemoteUrl(origin.url);
}

async function listRemotes(
  cwd: string,
  exec: GitExec,
): Promise<Array<{ name: string; url: string }>> {
  try {
    const stdout = await exec(["remote", "-v"], cwd);
    const seen = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line.trim());
      if (match) {
        seen.set(match[1], match[2]);
      }
    }
    return [...seen.entries()].map(([name, url]) => ({ name, url }));
  } catch {
    return [];
  }
}
