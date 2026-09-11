import type { OAuthClient } from "./oauth-client.js";
import { tokenResultToPartialCredentials } from "./oauth-client.js";
import type { CredentialStore, StoredCredentials } from "./store.js";

export interface RefreshOptions {
  clientId: string;
  oauth: OAuthClient;
  store: CredentialStore;
  credentials: StoredCredentials;
}

/**
 * Refresh an expired (or soon-expiring) access token and persist rotation.
 */
export async function refreshStoredCredentials(
  options: RefreshOptions,
): Promise<StoredCredentials> {
  const { credentials } = options;
  if (!credentials.refreshToken) {
    throw new Error("No refresh token available");
  }

  const tokens = await options.oauth.refreshToken(
    options.clientId,
    credentials.refreshToken,
  );

  const updated: StoredCredentials = {
    ...credentials,
    ...tokenResultToPartialCredentials(tokens),
  };
  await options.store.save(updated);
  return updated;
}

/** True when access token is missing expiry or expires within skewMs. */
export function isAccessTokenExpired(
  credentials: StoredCredentials,
  nowMs: number = Date.now(),
  skewMs: number = 60_000,
): boolean {
  if (!credentials.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(credentials.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return true;
  }
  return expiresAt <= nowMs + skewMs;
}
