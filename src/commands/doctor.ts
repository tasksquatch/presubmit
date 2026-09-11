import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AuthError,
  createDefaultAuthSession,
  defaultCheckChecksWrite,
  isKeytarAvailable as defaultIsKeytarAvailable,
  type AuthSession,
} from "../auth/index.js";
import {
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  type PresubmitConfig,
} from "../config/index.js";
import {
  discoverRepoState,
  enforceIntegrityGates,
  getWorktreeStatus,
  GitDiscoveryError,
  isGitAvailable as defaultIsGitAvailable,
  type GitExec,
  type GitHubRepoRef,
  type RepoState,
} from "../git/index.js";
import {
  appInstallHint,
  CLIENT_ID_ENV,
  detectForbiddenSecretEnvs,
  isClientIdConfigured,
  PRESUBMIT_APP_INSTALL_URL,
  PRESUBMIT_APP_NAME,
  resolveClientId,
} from "../github/index.js";
import { ExitCode, error, info, warn } from "../output/index.js";

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheckResult {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  exitCode?: ExitCode;
}

export interface DoctorCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  session?: AuthSession;
  exec?: GitExec;
  isGitAvailable?: () => Promise<boolean>;
  isKeytarAvailable?: () => Promise<boolean>;
  isCommandAvailable?: (command: string) => Promise<boolean>;
  checkChecksWrite?: (
    accessToken: string,
    repo: GitHubRepoRef,
  ) => Promise<boolean | null>;
  /** Test seam: skip live discovery. */
  discover?: (cwd: string) => Promise<RepoState>;
  /** Test seam: inject loaded config. */
  loadConfigFn?: (
    cwd: string,
  ) => Promise<{ config: PresubmitConfig; path: string | null }>;
}

async function defaultIsCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"]);
    return true;
  } catch {
    try {
      await execFileAsync(command, ["-v"]);
      return true;
    } catch {
      return false;
    }
  }
}

function printCheck(result: DoctorCheckResult): void {
  const prefix =
    result.status === "ok" ? "ok" : result.status === "warn" ? "warn" : "fail";
  const line = `[${prefix}] ${result.name}: ${result.message}`;
  if (result.status === "fail") {
    error(line);
  } else if (result.status === "warn") {
    warn(line);
  } else {
    info(line);
  }
}

/**
 * `presubmit doctor` — full-chain diagnostics with actionable fixes.
 * Prints all checks; returns the first failure's exit code (or Success).
 */
export async function doctorCommand(
  options: DoctorCommandOptions | NodeJS.ProcessEnv = {},
): Promise<ExitCode> {
  // Back-compat: older callers passed `env` as the sole argument.
  const opts: DoctorCommandOptions = isEnvOnly(options)
    ? { env: options }
    : options;

  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const isGitAvailable = opts.isGitAvailable ?? defaultIsGitAvailable;
  const isKeytarAvailable = opts.isKeytarAvailable ?? defaultIsKeytarAvailable;
  const isCommandAvailable =
    opts.isCommandAvailable ?? defaultIsCommandAvailable;
  const checkChecksWrite = opts.checkChecksWrite ?? defaultCheckChecksWrite;

  const results: DoctorCheckResult[] = [];
  const record = (result: DoctorCheckResult): void => {
    results.push(result);
    printCheck(result);
  };

  info(`Node.js: v${process.versions.node}`);

  const gitOk = await isGitAvailable();
  if (gitOk) {
    record({ name: "git", status: "ok", message: "available on PATH" });
  } else {
    record({
      name: "git",
      status: "fail",
      message: "NOT FOUND on PATH. Install git, then re-run `presubmit doctor`.",
      exitCode: ExitCode.GitError,
    });
  }

  const keytarOk = await isKeytarAvailable();
  if (keytarOk) {
    record({
      name: "keytar",
      status: "ok",
      message: "OS credential store available",
    });
  } else {
    record({
      name: "keytar",
      status: "fail",
      message:
        "OS credential store unavailable. Install keytar native deps or check Secret Service / Keychain access.",
      exitCode: ExitCode.AuthError,
    });
  }

  const { clientId, source } = resolveClientId(env);
  const displayId =
    clientId.length > 8 ? `${clientId.slice(0, 4)}…${clientId.slice(-4)}` : clientId;
  if (!isClientIdConfigured(clientId)) {
    record({
      name: "client-id",
      status: "fail",
      message: `GitHub Client ID is not configured (${displayId}). Set ${CLIENT_ID_ENV} or rebuild with a real compiled Client ID.`,
      exitCode: ExitCode.AuthError,
    });
  } else {
    record({
      name: "client-id",
      status: "ok",
      message: `${displayId} (source: ${source === "env" ? CLIENT_ID_ENV : "compiled default"})`,
    });
  }

  const forbidden = detectForbiddenSecretEnvs(env);
  if (forbidden.length > 0) {
    record({
      name: "secret-envs",
      status: "warn",
      message: `Ignoring unsupported secret env vars (never used by this CLI): ${forbidden.join(", ")}. Unset them to silence this warning.`,
    });
  } else {
    record({
      name: "secret-envs",
      status: "ok",
      message: "no unsupported PRESUBMIT_GITHUB_* secret env vars set",
    });
  }

  let state: RepoState | null = null;
  let config: PresubmitConfig = {
    ...DEFAULT_CONFIG,
    runnerArgs: [...DEFAULT_CONFIG.runnerArgs],
  };

  if (gitOk) {
    try {
      state = opts.discover
        ? await opts.discover(cwd)
        : await discoverRepoState(cwd, opts.exec);
      record({
        name: "git-repo",
        status: "ok",
        message: `repository root ${state.root}`,
      });
    } catch (err) {
      const message =
        err instanceof GitDiscoveryError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      record({
        name: "git-repo",
        status: "fail",
        message: `${message}. cd into a git clone of your repository.`,
        exitCode: ExitCode.GitError,
      });
    }

    if (state) {
      if (state.repo) {
        record({
          name: "github-remote",
          status: "ok",
          message: `${state.repo.owner}/${state.repo.repo}`,
        });
      } else {
        record({
          name: "github-remote",
          status: "fail",
          message:
            "git remotes do not resolve to a github.com owner/repo. Fix `origin` (SSH or HTTPS GitHub URL).",
          exitCode: ExitCode.GitError,
        });
      }
    }
  }

  try {
    const loaded = opts.loadConfigFn
      ? await opts.loadConfigFn(state?.root ?? cwd)
      : await loadConfig(state?.root ?? cwd);
    config = loaded.config;
    const configPath = loaded.path;
    record({
      name: "config",
      status: "ok",
      message: configPath
        ? `loaded ${configPath} (schema v${config.version})`
        : `no .presubmit.yaml; using defaults (runner=${config.runner} ${config.runnerArgs.join(" ")})`,
    });
  } catch (err) {
    const message =
      err instanceof ConfigError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    record({
      name: "config",
      status: "fail",
      message: `${message}. Fix .presubmit.yaml (supported schema version is 1).`,
      exitCode: ExitCode.ConfigError,
    });
  }

  const runnerOk = await isCommandAvailable(config.runner);
  if (runnerOk) {
    record({
      name: "runner",
      status: "ok",
      message: `${config.runner} available on PATH`,
    });
  } else {
    record({
      name: "runner",
      status: "fail",
      message: `${config.runner} NOT FOUND on PATH. Install it (default runner is \`just\`) so \`${config.runner} ${config.runnerArgs.join(" ")}\` can run.`,
      exitCode: ExitCode.ConfigError,
    });
  }

  let authUsable = false;
  let accessToken: string | undefined;

  if (keytarOk && isClientIdConfigured(clientId)) {
    try {
      const session =
        opts.session ?? (await createDefaultAuthSession({ env }));
      const status = await session.getAuthStatus(cwd);
      if (!status.loggedIn) {
        record({
          name: "auth",
          status: "fail",
          message: "Not logged in. Run `presubmit login`.",
          exitCode: ExitCode.AuthError,
        });
      } else if (!status.accessTokenValid) {
        record({
          name: "auth",
          status: "fail",
          message:
            "Logged in but access token is expired/unusable. Run `presubmit login`.",
          exitCode: ExitCode.AuthError,
        });
      } else {
        authUsable = true;
        record({
          name: "auth",
          status: "ok",
          message: `authenticated as ${status.login ?? "unknown"}`,
        });
        try {
          const creds = await session.ensureAccessToken();
          accessToken = creds.accessToken;
        } catch (err) {
          authUsable = false;
          const message =
            err instanceof AuthError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          record({
            name: "auth-token",
            status: "fail",
            message: `${message}. Run \`presubmit login\`.`,
            exitCode: ExitCode.AuthError,
          });
        }
      }
    } catch (err) {
      const message =
        err instanceof AuthError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      record({
        name: "auth",
        status: "fail",
        message: `${message}. Run \`presubmit login\`.`,
        exitCode: ExitCode.AuthError,
      });
    }
  } else if (!keytarOk) {
    record({
      name: "auth",
      status: "fail",
      message:
        "Cannot check auth while the OS credential store is unavailable. Fix keytar, then run `presubmit login`.",
      exitCode: ExitCode.AuthError,
    });
  } else {
    record({
      name: "auth",
      status: "fail",
      message: `Cannot check auth without a configured Client ID. Set ${CLIENT_ID_ENV}, then run \`presubmit login\`.`,
      exitCode: ExitCode.AuthError,
    });
  }

  if (authUsable && accessToken && state?.repo) {
    const write = await checkChecksWrite(accessToken, state.repo);
    if (write === true) {
      record({
        name: "app-install",
        status: "ok",
        message: `${PRESUBMIT_APP_NAME} Checks: write available for ${state.repo.owner}/${state.repo.repo}`,
      });
    } else if (write === false) {
      record({
        name: "app-install",
        status: "fail",
        message: `${PRESUBMIT_APP_NAME} is not installed (or lacks Checks: write) for ${state.repo.owner}/${state.repo.repo}. ${appInstallHint()}`,
        exitCode: ExitCode.GitHubError,
      });
    } else {
      record({
        name: "app-install",
        status: "fail",
        message: `Could not verify ${PRESUBMIT_APP_NAME} installation for ${state.repo.owner}/${state.repo.repo}. ${appInstallHint()}`,
        exitCode: ExitCode.GitHubError,
      });
    }
  } else if (state?.repo && !authUsable) {
    record({
      name: "app-install",
      status: "warn",
      message: `Skipped App installation check (auth unavailable). Fix auth, then re-run doctor. Install URL: ${PRESUBMIT_APP_INSTALL_URL}`,
    });
  } else if (gitOk) {
    record({
      name: "app-install",
      status: "warn",
      message: `Skipped App installation check (GitHub remote unresolved). Fix the remote, then re-run doctor. ${appInstallHint()}`,
    });
  }

  if (state && gitOk) {
    if (config.requireCleanWorktree) {
      try {
        const status = await getWorktreeStatus(state.root, opts.exec);
        if (status.trim() !== "") {
          record({
            name: "worktree",
            status: "warn",
            message:
              "Worktree is dirty. `presubmit run` will fail until you commit or stash (doctor does not fail on this).",
          });
        } else {
          record({
            name: "worktree",
            status: "ok",
            message: "clean",
          });
        }
      } catch (err) {
        record({
          name: "worktree",
          status: "warn",
          message: `Could not read worktree status: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (config.requirePushedCommit) {
      try {
        await enforceIntegrityGates({
          state,
          config: {
            requireCleanWorktree: false,
            requirePushedCommit: true,
          },
          exec: opts.exec,
        });
        record({
          name: "pushed-sha",
          status: "ok",
          message: `HEAD ${state.headSha.slice(0, 12)} appears pushed`,
        });
      } catch (err) {
        record({
          name: "pushed-sha",
          status: "warn",
          message: `${err instanceof Error ? err.message : String(err)} (doctor warns only; \`presubmit run\` will fail).`,
        });
      }
    }
  }

  const firstFail = results.find((r) => r.status === "fail");
  if (firstFail) {
    error(
      `doctor: ${results.filter((r) => r.status === "fail").length} check(s) failed. See messages above.`,
    );
    return firstFail.exitCode ?? ExitCode.ConfigError;
  }

  info("doctor: all blocking checks passed.");
  return ExitCode.Success;
}

function isEnvOnly(
  value: DoctorCommandOptions | NodeJS.ProcessEnv,
): value is NodeJS.ProcessEnv {
  if (value === null || typeof value !== "object") {
    return false;
  }
  // Heuristic: ProcessEnv values are strings/undefined; DoctorCommandOptions has known keys.
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  const optionKeys = new Set([
    "cwd",
    "env",
    "session",
    "exec",
    "isGitAvailable",
    "isKeytarAvailable",
    "isCommandAvailable",
    "checkChecksWrite",
    "discover",
    "loadConfigFn",
  ]);
  return !keys.some((k) => optionKeys.has(k));
}
