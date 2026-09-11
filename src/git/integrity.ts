import type { PresubmitConfig } from "../config/load.js";
import {
  getUpstreamRef,
  getWorktreeStatus,
  isShaAncestorOf,
  resolveSha,
} from "./git-core.js";
import { defaultGitExec, type GitExec } from "./exec.js";
import type { RepoState } from "./discovery.js";

export class GitIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIntegrityError";
  }
}

/** CLI `--integrity` profiles. Default `developer` preserves yaml gates. */
export const INTEGRITY_PROFILES = ["developer", "pre-push", "post-push"] as const;
export type IntegrityProfile = (typeof INTEGRITY_PROFILES)[number];

export interface IntegrityOptions {
  state: RepoState;
  config: Pick<
    PresubmitConfig,
    "requireCleanWorktree" | "requirePushedCommit"
  >;
  /** CLI `--sha` override (resolved against the repo). */
  shaOverride?: string;
  /** CLI `--integrity`. Default `developer`. */
  profile?: IntegrityProfile;
  skipIntegrity?: boolean;
  exec?: GitExec;
}

export interface IntegrityResult {
  /** SHA that would be published / attested. */
  effectiveSha: string;
  skipped: boolean;
}

export type IntegrityRequirements = Pick<
  PresubmitConfig,
  "requireCleanWorktree" | "requirePushedCommit"
>;

/**
 * Map an integrity profile onto yaml gates.
 * `pre-push` never requires remote; `post-push` always does.
 * Both still honor yaml `requireCleanWorktree`.
 */
export function resolveIntegrityRequirements(
  config: IntegrityRequirements,
  profile: IntegrityProfile = "developer",
): IntegrityRequirements {
  switch (profile) {
    case "pre-push":
      return {
        requireCleanWorktree: config.requireCleanWorktree,
        requirePushedCommit: false,
      };
    case "post-push":
      return {
        requireCleanWorktree: config.requireCleanWorktree,
        requirePushedCommit: true,
      };
    case "developer":
      return {
        requireCleanWorktree: config.requireCleanWorktree,
        requirePushedCommit: config.requirePushedCommit,
      };
  }
}

/**
 * Enforce clean-worktree and pushed-SHA gates for the selected profile.
 * `--skip-integrity` bypasses both; SHA==HEAD still applies.
 */
export async function enforceIntegrityGates(
  options: IntegrityOptions,
): Promise<IntegrityResult> {
  const exec = options.exec ?? defaultGitExec;
  const { state } = options;
  const gates = resolveIntegrityRequirements(
    options.config,
    options.profile ?? "developer",
  );

  let effectiveSha = state.headSha;
  if (options.shaOverride?.trim()) {
    try {
      effectiveSha = await resolveSha(options.shaOverride.trim(), state.root, exec);
    } catch {
      throw new GitIntegrityError(
        `Invalid --sha value "${options.shaOverride.trim()}". Pass a resolvable git commit.`,
      );
    }
  }

  if (effectiveSha !== state.headSha) {
    throw new GitIntegrityError("--sha must resolve to checked-out HEAD; check out the intended commit before running checks.");
  }

  if (options.skipIntegrity) {
    return { effectiveSha, skipped: true };
  }

  if (gates.requireCleanWorktree) {
    const status = await getWorktreeStatus(state.root, exec);
    if (status.trim() !== "") {
      throw new GitIntegrityError(
        "Worktree is dirty. Commit or stash your changes, then rerun `presubmit run` (no auto-stash).",
      );
    }
  }

  if (gates.requirePushedCommit) {
    await assertShaPushed({
      sha: effectiveSha,
      state,
      exec,
    });
  }

  return { effectiveSha, skipped: false };
}

async function assertShaPushed(options: {
  sha: string;
  state: RepoState;
  exec: GitExec;
}): Promise<void> {
  const { sha, state, exec } = options;

  const upstream = await getUpstreamRef(state.root, exec);
  if (upstream) {
    const ok = await isShaAncestorOf(sha, upstream, state.root, exec);
    if (ok) {
      return;
    }
    throw new GitIntegrityError(
      `Commit ${sha.slice(0, 12)} is not on upstream ${upstream}. Run \`git push\` then rerun \`presubmit run\` (no auto-push).`,
    );
  }

  if (state.branch && state.branch !== "HEAD") {
    const remoteBranch = `refs/remotes/${state.remoteName}/${state.branch}`;
    const exists = await refExists(remoteBranch, state.root, exec);
    if (exists) {
      const ok = await isShaAncestorOf(sha, remoteBranch, state.root, exec);
      if (ok) {
        return;
      }
      throw new GitIntegrityError(
        `Commit ${sha.slice(0, 12)} is not on ${state.remoteName}/${state.branch}. Run \`git push\` then rerun \`presubmit run\` (no auto-push).`,
      );
    }
  }

  throw new GitIntegrityError(
    `Cannot verify commit ${sha.slice(0, 12)} is on the remote. Set an upstream (e.g. \`git push -u ${state.remoteName} HEAD\`), ensure remote-tracking refs are current, then rerun.`,
  );
}

async function refExists(
  ref: string,
  cwd: string,
  exec: GitExec,
): Promise<boolean> {
  try {
    await exec(["rev-parse", "--verify", ref], cwd);
    return true;
  } catch {
    return false;
  }
}
