import {
  AuthError,
  createDefaultAuthSession,
  type AuthSession,
  type CredentialStore,
} from "../auth/index.js";
import { ExitCode, error, info } from "../output/index.js";

export interface LogoutCommandOptions {
  session?: AuthSession;
  store?: CredentialStore;
}

export async function logoutCommand(
  options: LogoutCommandOptions = {},
): Promise<ExitCode> {
  try {
    const session =
      options.session ??
      (await createDefaultAuthSession(
        options.store ? { store: options.store } : {},
      ));
    const result = await session.logout();
    if (!result.cleared) {
      info("Already logged out.");
      return ExitCode.Success;
    }
    if (result.revoked) {
      info("Logged out and revoked GitHub token.");
    } else {
      info("Logged out (local credentials cleared).");
    }
    return ExitCode.Success;
  } catch (err) {
    if (err instanceof AuthError) {
      error(err.message);
      return ExitCode.AuthError;
    }
    error(err instanceof Error ? err.message : String(err));
    return ExitCode.AuthError;
  }
}
