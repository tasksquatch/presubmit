export { defaultGitExec, GitCommandError, type GitExec } from "./exec.js";
export {
  getCurrentBranch,
  getHeadSha,
  getRepoRoot,
  getUpstreamRef,
  getWorktreeStatus,
  isGitAvailable,
  isShaAncestorOf,
  resolveSha,
} from "./git-core.js";
export {
  discoverRepoState,
  GitDiscoveryError,
  type RepoState,
} from "./discovery.js";
export {
  enforceIntegrityGates,
  GitIntegrityError,
  INTEGRITY_PROFILES,
  resolveIntegrityRequirements,
  type IntegrityOptions,
  type IntegrityProfile,
  type IntegrityRequirements,
  type IntegrityResult,
} from "./integrity.js";
export {
  parseGitHubRemoteUrl,
  resolveGitHubRepo,
  type GitHubRepoRef,
} from "./remote.js";
