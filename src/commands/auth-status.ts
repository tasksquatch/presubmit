import {
  AuthError,
  createDefaultAuthSession,
  type AuthSession,
  type CredentialStore,
} from "../auth/index.js";
import { CLIENT_ID_ENV } from "../github/client-id.js";
import { ExitCode, error, info } from "../output/index.js";

export interface AuthStatusCommandOptions {
  session?: AuthSession;
  store?: CredentialStore;
  cwd?: string;
}

export async function authStatusCommand(
  options: AuthStatusCommandOptions = {},
): Promise<ExitCode> {
  try {
    const session =
      options.session ??
      (await createDefaultAuthSession(
        options.store ? { store: options.store } : {},
      ));
    const status = await session.getAuthStatus(options.cwd ?? process.cwd());

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
      error(err.message);
      return ExitCode.AuthError;
    }
    error(err instanceof Error ? err.message : String(err));
    return ExitCode.AuthError;
  }
}
