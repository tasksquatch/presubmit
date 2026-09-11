import type { OAuthClient } from "./oauth-client.js";
import { OAuthError } from "./github-oauth.js";
import {
  tokenResultToPartialCredentials,
  type OAuthTokenResult,
} from "./oauth-client.js";
import type { StoredCredentials } from "./store.js";
import { info } from "../output/index.js";

export interface DeviceFlowOptions {
  clientId: string;
  oauth: OAuthClient;
  /** Fetch authenticated user after token exchange. */
  fetchUser: (accessToken: string) => Promise<{ id: number; login: string }>;
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override "now" for expiry calculations in tests. */
  now?: () => number;
  onPrompt?: (prompt: {
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run GitHub App device flow and return credentials ready for the store.
 */
export async function runDeviceFlow(
  options: DeviceFlowOptions,
): Promise<StoredCredentials> {
  const sleep = options.sleep ?? defaultSleep;
  const device = await options.oauth.createDeviceCode(options.clientId);

  const prompt = options.onPrompt ?? defaultPrompt;
  prompt({
    verificationUri: device.verificationUri,
    userCode: device.userCode,
    expiresIn: device.expiresIn,
  });

  const deadline =
    (options.now?.() ?? Date.now()) + device.expiresIn * 1000;
  let intervalMs = Math.max(device.interval, 1) * 1000;

  while ((options.now?.() ?? Date.now()) < deadline) {
    await sleep(intervalMs);
    try {
      const tokens = await options.oauth.exchangeDeviceCode(
        options.clientId,
        device.deviceCode,
      );
      return await credentialsFromTokens(tokens, options.fetchUser);
    } catch (err) {
      if (!(err instanceof OAuthError)) {
        throw err;
      }
      if (err.code === "authorization_pending") {
        continue;
      }
      if (err.code === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (
        err.code === "expired_token" ||
        err.code === "access_denied" ||
        err.code === "incorrect_device_code"
      ) {
        throw err;
      }
      throw err;
    }
  }

  throw new OAuthError("Device code expired before authorization", "expired_token");
}

async function credentialsFromTokens(
  tokens: OAuthTokenResult,
  fetchUser: (accessToken: string) => Promise<{ id: number; login: string }>,
): Promise<StoredCredentials> {
  const user = await fetchUser(tokens.accessToken);
  return {
    ...tokenResultToPartialCredentials(tokens),
    githubUserId: user.id,
    login: user.login,
  };
}

function defaultPrompt(prompt: {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
}): void {
  info("");
  info("Complete authentication in your browser:");
  info(`  ${prompt.verificationUri}`);
  info(`  Enter code: ${prompt.userCode}`);
  info(`  (code expires in ~${Math.round(prompt.expiresIn / 60)} minutes)`);
  info("");
}
