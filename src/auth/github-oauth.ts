import {
  createDeviceCode,
  exchangeDeviceCode,
} from "@octokit/oauth-methods";
import { request as defaultRequest } from "@octokit/request";
import type {
  DeviceCodeInfo,
  OAuthClient,
  OAuthTokenResult,
} from "./oauth-client.js";

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

function toTimestamp(apiTimeMs: number, expiresInSeconds: number): string {
  return new Date(apiTimeMs + expiresInSeconds * 1000).toISOString();
}

function parseTokenPayload(
  data: Record<string, unknown>,
  dateHeader: string | undefined,
): OAuthTokenResult {
  if (typeof data.error === "string") {
    throw new OAuthError(
      typeof data.error_description === "string"
        ? data.error_description
        : data.error,
      data.error,
    );
  }

  const accessToken = data.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new OAuthError(
      "Token response missing access_token",
      "invalid_response",
    );
  }

  const apiTimeMs = dateHeader ? new Date(dateHeader).getTime() : Date.now();
  const result: OAuthTokenResult = { accessToken };

  if (typeof data.expires_in === "number") {
    result.expiresAt = toTimestamp(apiTimeMs, data.expires_in);
  }
  if (typeof data.refresh_token === "string") {
    result.refreshToken = data.refresh_token;
  }
  if (typeof data.refresh_token_expires_in === "number") {
    result.refreshTokenExpiresAt = toTimestamp(
      apiTimeMs,
      data.refresh_token_expires_in,
    );
  }

  return result;
}

function rethrowOAuthError(err: unknown): never {
  if (err instanceof OAuthError) {
    throw err;
  }
  const anyErr = err as {
    message?: string;
    response?: { data?: { error?: string; error_description?: string } };
  };
  const code = anyErr.response?.data?.error;
  if (code) {
    throw new OAuthError(
      anyErr.response?.data?.error_description ?? anyErr.message ?? code,
      code,
    );
  }
  throw err;
}

/**
 * Production OAuth client: device flow via @octokit/oauth-methods;
 * refresh without client_secret (required for device-flow tokens per GitHub).
 * API revoke requires client_secret and is not supported — returns false.
 */
export function createGitHubOAuthClient(): OAuthClient {
  return {
    async createDeviceCode(clientId: string): Promise<DeviceCodeInfo> {
      const { data } = await createDeviceCode({
        clientType: "github-app",
        clientId,
      });
      return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in,
        interval: data.interval,
      };
    },

    async exchangeDeviceCode(
      clientId: string,
      deviceCode: string,
    ): Promise<OAuthTokenResult> {
      try {
        const response = await exchangeDeviceCode({
          clientType: "github-app",
          clientId,
          code: deviceCode,
        });
        const auth = response.authentication as {
          token: string;
          expiresAt?: string;
          refreshToken?: string;
          refreshTokenExpiresAt?: string;
        };
        return {
          accessToken: auth.token,
          ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
          ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
          ...(auth.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: auth.refreshTokenExpiresAt }
            : {}),
        };
      } catch (err) {
        rethrowOAuthError(err);
      }
    },

    async refreshToken(
      clientId: string,
      refreshTokenValue: string,
    ): Promise<OAuthTokenResult> {
      // Device-flow refresh must NOT send client_secret (GitHub docs).
      const response = await defaultRequest("POST /login/oauth/access_token", {
        baseUrl: "https://github.com",
        headers: {
          accept: "application/json",
        },
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshTokenValue,
      });
      return parseTokenPayload(
        response.data as Record<string, unknown>,
        typeof response.headers.date === "string"
          ? response.headers.date
          : undefined,
      );
    },

    async revokeToken(clientId: string, accessToken: string): Promise<boolean> {
      // DELETE /applications/{client_id}/token requires Basic client_id:client_secret.
      // This CLI never ships or accepts a client secret, so API revoke is unavailable.
      if (!clientId || !accessToken) {
        return false;
      }
      return false;
    },
  };
}
