import {
  AuthError,
  createDefaultAuthSession,
  defaultCheckChecksWrite,
  type AuthSession,
} from "../auth/index.js";
import { ConfigError, loadConfig } from "../config/index.js";
import {
  discoverRepoState,
  enforceIntegrityGates,
  GitDiscoveryError,
  GitIntegrityError,
  type GitExec,
  type RepoState,
} from "../git/index.js";
import {
  buildCheckOutput,
  createChecksClient,
  createOctokit,
  GitHubApiError,
  type CheckConclusion,
  type ChecksClient,
} from "../github/index.js";
import { ExitCode, error, info } from "../output/index.js";
import {
  runChecks,
  type RunChecksOptions,
  type RunChecksResult,
  type SpawnFn,
} from "../runner/index.js";
import { VERSION } from "../version.js";

export interface RunCommandOptions {
  cwd?: string;
  /** `--sha` override for automation/testing. */
  sha?: string;
  /** When false (`--no-publish`), skip Check Run publish; integrity still applies. */
  publish?: boolean;
  /** `--skip-integrity` testing escape hatch. */
  skipIntegrity?: boolean;
  exec?: GitExec;
  /** Test seam: inject discovered state. */
  discover?: (cwd: string) => Promise<RepoState>;
  /** Test seam: auth session. */
  session?: AuthSession;
  /** Test seam: Checks client (skips Octokit construction). */
  checksClient?: ChecksClient;
  /** Test seam: runner. */
  runChecksFn?: (options: RunChecksOptions) => Promise<RunChecksResult>;
  spawnFn?: SpawnFn;
  now?: () => number;
}

/**
 * `presubmit run` — integrity gates, optional Check Run lifecycle, local runner.
 */
export async function runCommand(
  options: RunCommandOptions = {},
): Promise<ExitCode> {
  const cwd = options.cwd ?? process.cwd();
  const publish = options.publish ?? true;
  const now = options.now ?? Date.now;

  let config;
  try {
    const loaded = await loadConfig(cwd);
    config = loaded.config;
    info(
      `Loaded config${loaded.path ? ` from ${loaded.path}` : " (defaults)"}: check="${config.checkName}", runner=${config.runner} ${config.runnerArgs.join(" ")}`,
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      error(err.message);
      return ExitCode.ConfigError;
    }
    error(err instanceof Error ? err.message : String(err));
    return ExitCode.ConfigError;
  }

  let state: RepoState;
  try {
    state = options.discover
      ? await options.discover(cwd)
      : await discoverRepoState(cwd, options.exec);
  } catch (err) {
    const message =
      err instanceof GitDiscoveryError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    error(message);
    return ExitCode.GitError;
  }

  info(
    `Repo ${state.repo ? `${state.repo.owner}/${state.repo.repo}` : "(unresolved)"} @ ${state.headSha.slice(0, 12)} (${state.branch})`,
  );

  let effectiveSha: string;
  try {
    const integrity = await enforceIntegrityGates({
      state,
      config,
      shaOverride: options.sha,
      skipIntegrity: options.skipIntegrity,
      exec: options.exec,
    });
    effectiveSha = integrity.effectiveSha;
    if (integrity.skipped) {
      info("Integrity gates skipped (--skip-integrity).");
    } else {
      info(`Integrity OK for ${effectiveSha.slice(0, 12)}.`);
    }
  } catch (err) {
    const message =
      err instanceof GitIntegrityError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    error(message);
    return ExitCode.GitError;
  }

  let checks: ChecksClient | null = null;
  let checkRunId: number | null = null;
  let login: string | undefined;

  if (publish) {
    if (!state.repo) {
      error(
        "Cannot publish Check Run: git remote does not resolve to a GitHub owner/repo.",
      );
      return ExitCode.GitError;
    }

    try {
      const session =
        options.session ?? (await createDefaultAuthSession());
      const credentials = await session.ensureAccessToken();
      login = credentials.login;

      checks =
        options.checksClient ??
        createChecksClient(createOctokit({ token: credentials.accessToken }), {
          accessToken: credentials.accessToken,
          checkChecksWrite: defaultCheckChecksWrite,
        });

      await checks.verifyAppAccess(state.repo.owner, state.repo.repo);
      info(
        `App Checks write OK for ${state.repo.owner}/${state.repo.repo}.`,
      );

      checkRunId = await checks.createInProgressCheckRun({
        owner: state.repo.owner,
        repo: state.repo.repo,
        name: config.checkName,
        headSha: effectiveSha,
      });
      info(`Created Check Run ${checkRunId} (in_progress) for ${effectiveSha.slice(0, 12)}.`);
    } catch (err) {
      if (err instanceof AuthError) {
        error(err.message);
        return ExitCode.AuthError;
      }
      if (err instanceof GitHubApiError) {
        error(err.message);
        return ExitCode.GitHubError;
      }
      error(err instanceof Error ? err.message : String(err));
      return ExitCode.GitHubError;
    }
  } else {
    info("Publish disabled (--no-publish); Check Run will be skipped.");
  }

  const startedAt = now();
  const runFn = options.runChecksFn ?? runChecks;
  let result: RunChecksResult;
  try {
    result = await runFn({
      cwd: state.root,
      runner: config.runner,
      runnerArgs: config.runnerArgs,
      maxLogLines: config.maxLogLines,
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Failed to start local runner: ${message}`);
    if (publish && checks && checkRunId !== null && state.repo) {
      try {
        const durationMs = now() - startedAt;
        await checks.completeCheckRun({
          owner: state.repo.owner,
          repo: state.repo.repo,
          checkRunId,
          conclusion: "failure",
          output: buildCheckOutput({
            checkName: config.checkName,
            conclusion: "failure",
            headSha: effectiveSha,
            login,
            durationMs,
            cliVersion: VERSION,
          }),
        });
      } catch (completeErr) {
        error(
          completeErr instanceof Error
            ? completeErr.message
            : String(completeErr),
        );
        return ExitCode.GitHubError;
      }
    }
    return ExitCode.ConfigError;
  }

  const durationMs = now() - startedAt;
  const conclusion: CheckConclusion = result.cancelled
    ? "cancelled"
    : result.exitCode === 0
      ? "success"
      : "failure";

  if (publish && checks && checkRunId !== null && state.repo) {
    try {
      await checks.completeCheckRun({
        owner: state.repo.owner,
        repo: state.repo.repo,
        checkRunId,
        conclusion,
        output: buildCheckOutput({
          checkName: config.checkName,
          conclusion,
          headSha: effectiveSha,
          login,
          durationMs,
          cliVersion: VERSION,
        }),
      });
      info(`Completed Check Run ${checkRunId} as ${conclusion}.`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      return ExitCode.GitHubError;
    }
  }

  if (result.cancelled) {
    error("Local checks were cancelled.");
    return ExitCode.Cancelled;
  }
  if (result.exitCode !== 0) {
    error(`Local checks failed (exit ${result.exitCode}).`);
    return ExitCode.ChecksFailed;
  }

  info("Local checks passed.");
  return ExitCode.Success;
}
