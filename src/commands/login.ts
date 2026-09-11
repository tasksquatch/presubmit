import {
  AuthError,
  OAuthError,
  createDefaultAuthSession,
  type AuthSession,
  type CredentialStore,
} from "../auth/index.js";
import { PRESUBMIT_APP_NAME } from "../github/app-info.js";
import { ExitCode, error, info, warn } from "../output/index.js";

export interface LoginCommandOptions {
  session?: AuthSession;
  store?: CredentialStore;
}

export async function loginCommand(
  options: LoginCommandOptions = {},
): Promise<ExitCode> {
  try {
    warn(
      `Only run login from a trusted @tasksquatch/presubmit install. On GitHub, confirm the App is "${PRESUBMIT_APP_NAME}".`,
    );
    const session =
      options.session ??
      (await createDefaultAuthSession(
        options.store ? { store: options.store } : {},
      ));
    const credentials = await session.login();
    info(
      `Logged in as ${credentials.login ?? "unknown"} (id ${credentials.githubUserId ?? "?"}).`,
    );
    return ExitCode.Success;
  } catch (err) {
    if (err instanceof AuthError || err instanceof OAuthError) {
      error(err.message);
      return ExitCode.AuthError;
    }
    error(err instanceof Error ? err.message : String(err));
    return ExitCode.AuthError;
  }
}
