import type { StoredCredentials } from "./store.js";

/** Token material returned by device-flow exchange or refresh. */
export interface OAuthTokenResult {
  accessToken: string;
  expiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface DeviceCodeInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * Injectable OAuth operations (GitHub App, Client ID only — no secret).
 */
export interface OAuthClient {
  createDeviceCode(clientId: string): Promise<DeviceCodeInfo>;
  /**
   * Exchange a device code for tokens.
   * Throws with `code` of `authorization_pending` | `slow_down` | `expired_token` |
   * `access_denied` | `incorrect_device_code` while polling, or other errors.
   */
  exchangeDeviceCode(
    clientId: string,
    deviceCode: string,
  ): Promise<OAuthTokenResult>;
  refreshToken(clientId: string, refreshToken: string): Promise<OAuthTokenResult>;
  /** Best-effort revoke. Returns false when the API rejects (e.g. no client secret). */
  revokeToken(clientId: string, accessToken: string): Promise<boolean>;
}

export function tokenResultToPartialCredentials(
  tokens: OAuthTokenResult,
): Pick<
  StoredCredentials,
  "accessToken" | "expiresAt" | "refreshToken" | "refreshTokenExpiresAt"
> {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }
      : {}),
  };
}
