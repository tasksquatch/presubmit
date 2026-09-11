import {
  AuthError,
  createDefaultAuthSession,
  createInstallationAuth,
  resolveDiagnosticAuthMode,
  type AuthModeOption,
  type AuthSession,
  type CredentialStore,
  type InstallationAuthResult,
} from "../auth/index.js";
import { resolveGitHubRepo, type GitHubRepoRef } from "../git/remote.js";
import { CLIENT_ID_ENV } from "../github/client-id.js";
import { GitHubApiError } from "../github/checks.js";
import { ExitCode, error, info, redactUnknown } from "../output/index.js";

export interface AuthStatusCommandOptions {
  session?: AuthSession;
  store?: CredentialStore;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  auth?: AuthModeOption;
  installationAuth?: (env: NodeJS.ProcessEnv) => Promise<InstallationAuthResult>;
  resolveRepo?: (cwd: string) => Promise<GitHubRepoRef | null>;
}

export async function authStatusCommand(
  options: AuthStatusCommandOptions = {},
): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveDiagnosticAuthMode(options.auth ?? "auto", env);

  if (resolved.mode === "installation") {
    return reportInstallationStatus(options, env, cwd);
  }

  try {
    const session =
      options.session ??
      (await createDefaultAuthSession(
        options.store ? { store: options.store, env } : { env },
      ));
    const status = await session.getAuthStatus(cwd);

    info("Auth mode: device");
    info(status.message);
    info(
      `Client ID source: ${status.clientIdSource === "env" ? CLIENT_ID_ENV : "compiled default"}`,
    );

    if (!status.loggedIn) {
      return ExitCode.AuthError;
    }

    info(`User: ${status.login ?? "unknown"} (id ${status.githubUserId ?? "?"})`);
    info(
      `Access token: ${status.accessTokenValid ? "valid" : "expired"}${
        status.accessTokenExpiresAt
          ? ` (expires ${status.accessTokenExpiresAt})`
          : ""
      }`,
    );
    info(
      `Refresh token: ${
        status.refreshTokenPresent
          ? `present${
              status.refreshTokenExpiresAt
                ? ` (expires ${status.refreshTokenExpiresAt})`
                : ""
            }`
          : "absent"
      }`,
    );

    if (status.repo) {
      const checks =
        status.checksWriteAvailable === true
          ? "available"
          : status.checksWriteAvailable === false
            ? "not available"
            : "could not determine";
      info(
        `Repo ${status.repo.owner}/${status.repo.repo}: Checks write ${checks}`,
      );
    } else {
      info("Current GitHub repo: not resolved from git remotes");
    }

    return status.accessTokenValid ? ExitCode.Success : ExitCode.AuthError;
  } catch (err) {
    if (err instanceof AuthError) {
      error(redactUnknown(err));
      return ExitCode.AuthError;
    }
    error(redactUnknown(err));
    return ExitCode.AuthError;
  }
}

async function reportInstallationStatus(
  options: AuthStatusCommandOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ExitCode> {
  try {
    const result = options.installationAuth
      ? await options.installationAuth(env)
      : await createInstallationAuth(env);

    info("Auth mode: installation");
    info(`App ID: ${result.credentials.appId}`);
    info(`Installation ID: ${result.credentials.installationId}`);
    info(
      `Private key: loaded from ${result.credentials.keySource === "env" ? "PRESUBMIT_GITHUB_PRIVATE_KEY" : "PRESUBMIT_GITHUB_PRIVATE_KEY_PATH"}`,
    );
    info(`Installation token: valid (expires ${result.access.expiresAt})`);

    const repo = await (options.resolveRepo ?? resolveGitHubRepo)(cwd);
    if (repo) {
      const write = await result.checkChecksWrite(result.accessToken, repo);
      const checks =
        write === true
          ? "available"
          : write === false
            ? "not available"
            : "could not determine";
      info(`Repo ${repo.owner}/${repo.repo}: Checks write ${checks}`);
      if (write !== true) {
        return ExitCode.GitHubError;
      }
    } else {
      info("Current GitHub repo: not resolved from git remotes");
    }

    return ExitCode.Success;
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
    return ExitCode.AuthError;
  }
}
