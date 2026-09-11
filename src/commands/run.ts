import {
  AuthError,
  createDefaultAuthSession,
  createInstallationAuth,
  defaultCheckChecksWrite,
  type AuthMode,
  type AuthSession,
  type InstallationAuthResult,
} from "../auth/index.js";
import { ConfigError, loadConfig } from "../config/index.js";
import {
  discoverRepoState,
  enforceIntegrityGates,
  GitDiscoveryError,
  GitIntegrityError,
  type GitExec,
  type IntegrityProfile,
  type RepoState,
} from "../git/index.js";
import {
  buildCheckOutput,
  createChecksClient,
  createOctokit,
  GitHubApiError,
  type AttestationMode,
  type CheckConclusion,
  type ChecksClient,
} from "../github/index.js";
import { ExitCode, error, info, redactUnknown } from "../output/index.js";
import {
  runChecks,
  type RunChecksOptions,
  type RunChecksResult,
  type SpawnFn,
} from "../runner/index.js";
import { VERSION } from "../version.js";

export interface RunPresubmitOptions {
  cwd?: string;
  /** `--sha` override for automation/testing. */
  sha?: string;
  /** When false (`--no-publish`), skip Check Run publish; integrity still applies. */
  publish?: boolean;
  /** `--skip-integrity` testing escape hatch. */
  skipIntegrity?: boolean;
  /** CLI `--integrity`. Default `developer`. */
  integrity?: IntegrityProfile;
  /** Explicit auth mode. Default `device`; never auto-selected from env. */
  auth?: AuthMode;
  env?: NodeJS.ProcessEnv;
  exec?: GitExec;
  /** Test seam: inject discovered state. */
  discover?: (cwd: string) => Promise<RepoState>;
  /** Test seam: auth session. */
  session?: AuthSession;
  /** Test seam: Checks client (skips Octokit construction). */
  checksClient?: ChecksClient;
  /** Test seam: installation token mint. */
  installationAuth?: (env: NodeJS.ProcessEnv) => Promise<InstallationAuthResult>;
  /** Test seam: runner. */
  runChecksFn?: (options: RunChecksOptions) => Promise<RunChecksResult>;
  spawnFn?: SpawnFn;
  now?: () => number;
}

/** CLI-facing alias; prefer `runPresubmit` for library callers. */
export type RunCommandOptions = RunPresubmitOptions;

/**
 * Core `presubmit run` pipeline — integrity gates, optional Check Run lifecycle, local runner.
 */
export async function runPresubmit(
  options: RunPresubmitOptions = {},
): Promise<ExitCode> {
  const cwd = options.cwd ?? process.cwd();
  const publish = options.publish ?? true;
  const now = options.now ?? Date.now;
  const auth: AuthMode = options.auth ?? "device";
  const env = options.env ?? process.env;
  const integrity: IntegrityProfile = options.integrity ?? "developer";
  const attestation: AttestationMode =
    auth === "installation" ? "orchestrator" : "local-developer";

  if (publish && integrity === "pre-push") {
    error(
      "Integrity profile pre-push cannot publish a Check Run. Use --no-publish, or use --integrity post-push after the commit is on the remote.",
    );
    return ExitCode.GitError;
  }

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
    const integrityResult = await enforceIntegrityGates({
      state,
      config,
      shaOverride: options.sha,
      profile: integrity,
      skipIntegrity: options.skipIntegrity,
      exec: options.exec,
    });
    effectiveSha = integrityResult.effectiveSha;
    if (integrityResult.skipped) {
      info("Integrity gates skipped (--skip-integrity).");
    } else {
      info(
        `Integrity OK for ${effectiveSha.slice(0, 12)} (profile ${integrity}).`,
      );
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
      if (auth === "installation") {
        if (options.checksClient) {
          checks = options.checksClient;
        } else {
          const installAuth = options.installationAuth
            ? await options.installationAuth(env)
            : await createInstallationAuth(env);
          checks = createChecksClient(
            createOctokit({ token: installAuth.accessToken }),
            {
              accessToken: installAuth.accessToken,
              checkChecksWrite: installAuth.checkChecksWrite,
            },
          );
        }
        info("Using GitHub App installation authentication.");
      } else {
        const session =
          options.session ?? (await createDefaultAuthSession({ env }));
        const credentials = await session.ensureAccessToken();
        login = credentials.login;

        checks =
          options.checksClient ??
          createChecksClient(
            createOctokit({ token: credentials.accessToken }),
            {
              accessToken: credentials.accessToken,
              checkChecksWrite: defaultCheckChecksWrite,
            },
          );
      }

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
        error(redactUnknown(err));
        return ExitCode.AuthError;
      }
      if (err instanceof GitHubApiError) {
        error(redactUnknown(err));
        return ExitCode.GitHubError;
      }
      error(redactUnknown(err));
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
      env,
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    });
  } catch (err) {
    error(`Failed to start local runner: ${redactUnknown(err)}`);
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
            attestation,
          }),
        });
      } catch (completeErr) {
        error(redactUnknown(completeErr));
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
          attestation,
        }),
      });
      info(`Completed Check Run ${checkRunId} as ${conclusion}.`);
    } catch (err) {
      error(redactUnknown(err));
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

/**
 * `presubmit run` — thin CLI mapper over `runPresubmit`.
 */
export async function runCommand(
  options: RunCommandOptions = {},
): Promise<ExitCode> {
  return runPresubmit(options);
}
