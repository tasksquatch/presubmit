import { createOctokit } from "../github/client.js";
import {
  isClientIdConfigured,
  resolveClientId,
  type ResolvedClientId,
} from "../github/client-id.js";
import { resolveGitHubRepo, type GitHubRepoRef } from "../git/remote.js";
import { info, warn } from "../output/index.js";
import { runDeviceFlow } from "./device-flow.js";
import { createGitHubOAuthClient, OAuthError } from "./github-oauth.js";
import { isKeyringAvailable, createKeyringStore } from "./keyring-store.js";
import type { OAuthClient } from "./oauth-client.js";
import { isAccessTokenExpired, refreshStoredCredentials } from "./refresh.js";
import { revokeAndClear } from "./revoke.js";
import type { CredentialStore, StoredCredentials } from "./store.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface SessionDeps {
  store: CredentialStore;
  oauth: OAuthClient;
  resolveClient?: (env?: NodeJS.ProcessEnv) => ResolvedClientId;
  env?: NodeJS.ProcessEnv;
  fetchUser?: (accessToken: string) => Promise<{ id: number; login: string }>;
  resolveRepo?: (cwd: string) => Promise<GitHubRepoRef | null>;
  checkChecksWrite?: (
    accessToken: string,
    repo: GitHubRepoRef,
  ) => Promise<boolean | null>;
  isTTY?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AuthStatusReport {
  loggedIn: boolean;
  login?: string;
  githubUserId?: number;
  clientId: string;
  clientIdSource: string;
  accessTokenValid?: boolean;
  accessTokenExpiresAt?: string;
  refreshTokenPresent?: boolean;
  refreshTokenExpiresAt?: string;
  repo?: GitHubRepoRef | null;
  checksWriteAvailable?: boolean | null;
  message: string;
}

async function defaultFetchUser(
  accessToken: string,
): Promise<{ id: number; login: string }> {
  const octokit = createOctokit({ token: accessToken });
  const { data } = await octokit.users.getAuthenticated();
  return { id: data.id, login: data.login };
}

/**
 * Whether the authenticated app user token can write Checks for the repo.
 * Uses installations visible to the user-to-server token.
 */
export async function defaultCheckChecksWrite(
  accessToken: string,
  repo: GitHubRepoRef,
): Promise<boolean | null> {
  try {
    const octokit = createOctokit({ token: accessToken });
    const installations = await octokit.paginate(
      octokit.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );

    for (const installation of installations) {
      const checks = (
        installation.permissions as { checks?: string } | undefined
      )?.checks;
      if (checks !== "write") {
        continue;
      }

      try {
        const repos = await octokit.paginate(
          octokit.apps.listInstallationReposForAuthenticatedUser,
          { installation_id: installation.id, per_page: 100 },
        );
        if (
          repos.some(
            (r) =>
              r.owner.login.toLowerCase() === repo.owner.toLowerCase() &&
              r.name.toLowerCase() === repo.repo.toLowerCase(),
          )
        ) {
          return true;
        }
      } catch {
        // Installation may not expose repo list; try next.
      }
    }
    return false;
  } catch {
    return null;
  }
}

export async function getDefaultStore(): Promise<CredentialStore> {
  const available = await isKeyringAvailable();
  if (!available) {
    throw new AuthError(
      "OS credential store is unavailable. On Linux install libsecret-1-0 and enable Secret Service; otherwise check Keychain / Credential Manager.",
    );
  }
  return createKeyringStore();
}

function requireConfiguredClientId(
  resolved: ResolvedClientId,
): ResolvedClientId {
  if (!isClientIdConfigured(resolved.clientId)) {
    throw new AuthError(
      `GitHub Client ID is not configured. Set ${"PRESUBMIT_GITHUB_CLIENT_ID"} or rebuild with a real compiled Client ID.`,
    );
  }
  return resolved;
}

function createSession(deps: SessionDeps) {
  const resolve =
    deps.resolveClient ?? ((env?: NodeJS.ProcessEnv) => resolveClientId(env));
  const env = deps.env ?? process.env;
  const fetchUser = deps.fetchUser ?? defaultFetchUser;
  const resolveRepo = deps.resolveRepo ?? resolveGitHubRepo;
  const checkChecksWrite = deps.checkChecksWrite ?? defaultCheckChecksWrite;
  const now = deps.now ?? Date.now;
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  return {
    async login(): Promise<StoredCredentials> {
      const client = requireConfiguredClientId(resolve(env));
      const credentials = await runDeviceFlow({
        clientId: client.clientId,
        oauth: deps.oauth,
        fetchUser,
        sleep: deps.sleep,
        now,
      });
      await deps.store.save(credentials);
      return credentials;
    },

    async logout(): Promise<{ cleared: boolean; revoked: boolean }> {
      const client = resolve(env);
      const existing = await deps.store.load();
      if (!existing) {
        return { cleared: false, revoked: false };
      }
      const { revoked } = await revokeAndClear({
        clientId: client.clientId,
        oauth: deps.oauth,
        store: deps.store,
        credentials: existing,
      });
      return { cleared: true, revoked };
    },

    /**
     * Return a usable access token, refreshing or re-logging in as needed.
     */
    async ensureAccessToken(): Promise<StoredCredentials> {
      const client = requireConfiguredClientId(resolve(env));
      const credentials = await deps.store.load();
      if (!credentials) {
        if (isTTY) {
          info("Not logged in; starting device login…");
          return this.login();
        }
        throw new AuthError("Not logged in. Run `presubmit login`.");
      }

      if (!isAccessTokenExpired(credentials, now())) {
        return credentials;
      }

      if (credentials.refreshToken) {
        try {
          return await refreshStoredCredentials({
            clientId: client.clientId,
            oauth: deps.oauth,
            store: deps.store,
            credentials,
          });
        } catch (err) {
          warn(
            `Token refresh failed (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
      }

      if (isTTY) {
        info("Refresh failed or unavailable; starting device login…");
        return this.login();
      }
      throw new AuthError(
        "Access token expired and refresh failed. Run `presubmit login`.",
      );
    },

    async getAuthStatus(cwd: string = process.cwd()): Promise<AuthStatusReport> {
      const client = resolve(env);
      const base = {
        clientId: client.clientId,
        clientIdSource: client.source,
      };

      let credentials: StoredCredentials | null;
      try {
        credentials = await deps.store.load();
      } catch (err) {
        throw new AuthError(
          `Failed to read credential store: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!credentials) {
        return {
          ...base,
          loggedIn: false,
          message: "Not logged in.",
        };
      }

      let accessTokenValid = !isAccessTokenExpired(credentials, now());
      if (!accessTokenValid && credentials.refreshToken) {
        try {
          requireConfiguredClientId(client);
          credentials = await refreshStoredCredentials({
            clientId: client.clientId,
            oauth: deps.oauth,
            store: deps.store,
            credentials,
          });
          accessTokenValid = true;
        } catch {
          accessTokenValid = false;
        }
      }

      if (!accessTokenValid) {
        return {
          ...base,
          loggedIn: true,
          login: credentials.login,
          githubUserId: credentials.githubUserId,
          accessTokenValid: false,
          accessTokenExpiresAt: credentials.expiresAt,
          refreshTokenPresent: Boolean(credentials.refreshToken),
          refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
          message:
            "Logged in but access token is expired; run `presubmit login` to renew.",
        };
      }

      // Refresh identity if missing.
      if (!credentials.login || credentials.githubUserId === undefined) {
        try {
          const user = await fetchUser(credentials.accessToken);
          credentials = {
            ...credentials,
            login: user.login,
            githubUserId: user.id,
          };
          await deps.store.save(credentials);
        } catch {
          // Keep status with whatever we have.
        }
      }

      const repo = await resolveRepo(cwd);
      let checksWriteAvailable: boolean | null = null;
      if (repo) {
        checksWriteAvailable = await checkChecksWrite(
          credentials.accessToken,
          repo,
        );
      }

      return {
        ...base,
        loggedIn: true,
        login: credentials.login,
        githubUserId: credentials.githubUserId,
        accessTokenValid: true,
        accessTokenExpiresAt: credentials.expiresAt,
        refreshTokenPresent: Boolean(credentials.refreshToken),
        refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
        repo,
        checksWriteAvailable,
        message: "Authenticated.",
      };
    },
  };
}

export type AuthSession = ReturnType<typeof createSession>;

export function createAuthSession(deps: SessionDeps): AuthSession {
  return createSession(deps);
}

/** CLI helper: session with OS keyring store + real GitHub OAuth. */
export async function createDefaultAuthSession(
  overrides: Partial<SessionDeps> = {},
): Promise<AuthSession> {
  const store = overrides.store ?? (await getDefaultStore());
  const oauth = overrides.oauth ?? createGitHubOAuthClient();
  return createAuthSession({ store, oauth, ...overrides });
}

export { OAuthError };
