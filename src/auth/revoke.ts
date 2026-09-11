import type { OAuthClient } from "./oauth-client.js";
import type { CredentialStore, StoredCredentials } from "./store.js";
import { warn } from "../output/index.js";

/**
 * Best-effort revoke then clear the credential store.
 * Always clears local credentials even when revoke fails.
 */
export async function revokeAndClear(options: {
  clientId: string;
  oauth: OAuthClient;
  store: CredentialStore;
  credentials: StoredCredentials | null;
}): Promise<{ revoked: boolean }> {
  let revoked = false;
  if (options.credentials?.accessToken) {
    try {
      revoked = await options.oauth.revokeToken(
        options.clientId,
        options.credentials.accessToken,
      );
      if (!revoked) {
        warn(
          "Token revoke via GitHub API is unavailable without a client secret; clearing local credentials only.",
        );
      }
    } catch (err) {
      warn(
        `Failed to revoke token at GitHub (${err instanceof Error ? err.message : String(err)}); clearing local credentials.`,
      );
      revoked = false;
    }
  }
  await options.store.clear();
  return { revoked };
}
