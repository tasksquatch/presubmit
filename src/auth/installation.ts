import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GitHubRepoRef } from "../git/remote.js";
import { appInstallHint } from "../github/app-info.js";
import { GitHubApiError } from "../github/checks.js";
import { createOctokit } from "../github/client.js";
import { redactUnknown } from "../output/redact.js";
import { AuthError } from "./session.js";

export const APP_ID_ENV = "PRESUBMIT_GITHUB_APP_ID";
export const INSTALLATION_ID_ENV = "PRESUBMIT_GITHUB_INSTALLATION_ID";
export const PRIVATE_KEY_ENV = "PRESUBMIT_GITHUB_PRIVATE_KEY";
export const PRIVATE_KEY_PATH_ENV = "PRESUBMIT_GITHUB_PRIVATE_KEY_PATH";

export const INSTALLATION_CREDENTIAL_ENVS = [
  APP_ID_ENV,
  INSTALLATION_ID_ENV,
  PRIVATE_KEY_ENV,
  PRIVATE_KEY_PATH_ENV,
] as const;

export type AuthMode = "device" | "installation";
export type AuthModeOption = "auto" | AuthMode;
export type PrivateKeySource = "env" | "path";
export type InstallationEnvPresence = "none" | "partial" | "complete";

export interface InstallationCredentials {
  appId: number;
  installationId: number;
  privateKey: string;
  keySource: PrivateKeySource;
}

export interface InstallationAccess {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositorySelection: string;
}

export interface InstallationEnvDetection {
  presence: InstallationEnvPresence;
  present: string[];
  missing: string[];
}

export interface MintInstallationTokenDeps {
  createJwt?: (
    appId: number,
    privateKeyPem: string,
    now?: number,
  ) => string;
  createAccessToken?: (
    jwt: string,
    installationId: number,
  ) => Promise<InstallationTokenResponse>;
  now?: () => number;
}

export interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string | undefined>;
  repository_selection?: string;
}

export interface CheckInstallationChecksWriteDeps {
  getRepo?: (repo: GitHubRepoRef) => Promise<"ok" | "not_found" | "error">;
}

const JWT_IAT_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new AuthError(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Which installation credential env vars are present (non-empty).
 */
export function detectInstallationEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstallationEnvDetection {
  const appId = envValue(env, APP_ID_ENV);
  const installationId = envValue(env, INSTALLATION_ID_ENV);
  const privateKey = envValue(env, PRIVATE_KEY_ENV);
  const privateKeyPath = envValue(env, PRIVATE_KEY_PATH_ENV);

  const present: string[] = [];
  if (appId) present.push(APP_ID_ENV);
  if (installationId) present.push(INSTALLATION_ID_ENV);
  if (privateKey) present.push(PRIVATE_KEY_ENV);
  if (privateKeyPath) present.push(PRIVATE_KEY_PATH_ENV);

  const missing: string[] = [];
  if (!appId) missing.push(APP_ID_ENV);
  if (!installationId) missing.push(INSTALLATION_ID_ENV);
  if (!privateKey && !privateKeyPath) {
    missing.push(`${PRIVATE_KEY_ENV} or ${PRIVATE_KEY_PATH_ENV}`);
  }

  let presence: InstallationEnvPresence = "none";
  if (present.length > 0 && missing.length === 0) {
    presence = "complete";
  } else if (present.length > 0) {
    presence = "partial";
  }

  return { presence, present, missing };
}

export function missingInstallationCredentialsMessage(missing: string[]): string {
  const list = missing.join(", ");
  return `Incomplete installation credentials: missing ${list}. Set ${APP_ID_ENV}, ${INSTALLATION_ID_ENV}, and ${PRIVATE_KEY_ENV} or ${PRIVATE_KEY_PATH_ENV}.`;
}

/**
 * Resolve diagnostic auth (`doctor` / `auth status`). `run` always passes an explicit mode.
 */
export function resolveDiagnosticAuthMode(
  requested: AuthModeOption,
  env: NodeJS.ProcessEnv = process.env,
): { mode: AuthMode } & InstallationEnvDetection {
  const detection = detectInstallationEnv(env);
  if (requested === "installation") {
    return { mode: "installation", ...detection };
  }
  if (requested === "device") {
    return { mode: "device", ...detection };
  }
  if (detection.presence === "none") {
    return { mode: "device", ...detection };
  }
  return { mode: "installation", ...detection };
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function loadPrivateKeyFromPath(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new AuthError(
      `Unable to read GitHub App private key file: ${path}${
        err instanceof Error ? ` (${err.message})` : ""
      }`,
    );
  }
}

/**
 * Load App installation credentials from env. Inline PEM overrides path.
 */
export function loadInstallationCredentials(
  env: NodeJS.ProcessEnv = process.env,
): InstallationCredentials {
  const detection = detectInstallationEnv(env);
  if (detection.missing.length > 0) {
    throw new AuthError(missingInstallationCredentialsMessage(detection.missing));
  }

  const appId = parsePositiveInteger(envValue(env, APP_ID_ENV), APP_ID_ENV);
  const installationId = parsePositiveInteger(
    envValue(env, INSTALLATION_ID_ENV),
    INSTALLATION_ID_ENV,
  );
  if (appId === undefined || installationId === undefined) {
    throw new AuthError(missingInstallationCredentialsMessage(detection.missing));
  }

  const inlineKey = envValue(env, PRIVATE_KEY_ENV);
  if (inlineKey) {
    return {
      appId,
      installationId,
      privateKey: normalizePem(inlineKey),
      keySource: "env",
    };
  }

  const keyPath = envValue(env, PRIVATE_KEY_PATH_ENV);
  if (!keyPath) {
    throw new AuthError(missingInstallationCredentialsMessage(detection.missing));
  }

  return {
    appId,
    installationId,
    privateKey: normalizePem(loadPrivateKeyFromPath(keyPath)),
    keySource: "path",
  };
}

function base64url(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

/**
 * Sign a GitHub App JWT (RS256). `iat` is skewed 60s into the past; `exp` is under 10 minutes.
 */
export function createAppJwt(
  appId: number,
  privateKeyPem: string,
  now: number = Date.now(),
): string {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new AuthError(
      `Could not parse GitHub App private key. Check ${PRIVATE_KEY_ENV} or ${PRIVATE_KEY_PATH_ENV}.`,
    );
  }

  const nowSeconds = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - JWT_IAT_SKEW_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), key);
  return `${signingInput}.${base64url(signature)}`;
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

function errorDetail(err: unknown): string {
  return redactUnknown(err);
}

async function defaultCreateAccessToken(
  jwt: string,
  installationId: number,
): Promise<InstallationTokenResponse> {
  const octokit = createOctokit({ token: jwt });
  const { data } = await octokit.apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  return {
    token: data.token,
    expires_at: data.expires_at,
    permissions: data.permissions as Record<string, string | undefined> | undefined,
    repository_selection: data.repository_selection,
  };
}

/**
 * Exchange App JWT for an installation access token. Token is returned in memory only.
 */
export async function mintInstallationToken(
  credentials: InstallationCredentials,
  deps: MintInstallationTokenDeps = {},
): Promise<InstallationAccess> {
  const now = deps.now ?? Date.now;
  const createJwt = deps.createJwt ?? createAppJwt;
  const createAccessToken = deps.createAccessToken ?? defaultCreateAccessToken;
  const jwt = createJwt(credentials.appId, credentials.privateKey, now());

  let response: InstallationTokenResponse;
  try {
    response = await createAccessToken(jwt, credentials.installationId);
  } catch (err) {
    if (err instanceof AuthError || err instanceof GitHubApiError) {
      throw err;
    }
    const status = httpStatus(err);
    if (status === 404) {
      throw new GitHubApiError(
        `GitHub App installation ${credentials.installationId} was not found for this App. Confirm ${INSTALLATION_ID_ENV}. ${appInstallHint()}`,
      );
    }
    throw new GitHubApiError(
      `Failed to create installation access token: ${errorDetail(err)}`,
    );
  }

  const permissions: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.permissions ?? {})) {
    if (typeof value === "string") {
      permissions[key] = value;
    }
  }

  return {
    token: response.token,
    expiresAt: response.expires_at,
    permissions,
    repositorySelection: response.repository_selection ?? "selected",
  };
}

async function defaultGetRepo(
  token: string,
  repo: GitHubRepoRef,
): Promise<"ok" | "not_found" | "error"> {
  try {
    const octokit = createOctokit({ token });
    await octokit.repos.get({ owner: repo.owner, repo: repo.repo });
    return "ok";
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404 || status === 403) {
      return "not_found";
    }
    return "error";
  }
}

/**
 * Installation-token Checks:write probe. Do not use the user-to-server listing API.
 */
export async function checkInstallationChecksWrite(
  access: InstallationAccess,
  repo: GitHubRepoRef,
  deps: CheckInstallationChecksWriteDeps = {},
): Promise<boolean | null> {
  if (access.permissions.checks !== "write") {
    return false;
  }
  const getRepo =
    deps.getRepo ?? ((target) => defaultGetRepo(access.token, target));
  const result = await getRepo(repo);
  if (result === "ok") {
    return true;
  }
  if (result === "not_found") {
    return false;
  }
  return null;
}

export function createInstallationCheckChecksWrite(
  access: InstallationAccess,
  deps: CheckInstallationChecksWriteDeps = {},
): (
  accessToken: string,
  repo: GitHubRepoRef,
) => Promise<boolean | null> {
  return async (_accessToken, repo) =>
    checkInstallationChecksWrite(access, repo, deps);
}

export interface InstallationAuthResult {
  accessToken: string;
  access: InstallationAccess;
  credentials: InstallationCredentials;
  checkChecksWrite: (
    accessToken: string,
    repo: GitHubRepoRef,
  ) => Promise<boolean | null>;
}

/**
 * Load credentials, mint an installation token, and build a Checks:write checker.
 */
export async function createInstallationAuth(
  env: NodeJS.ProcessEnv = process.env,
  deps: MintInstallationTokenDeps & CheckInstallationChecksWriteDeps = {},
): Promise<InstallationAuthResult> {
  const credentials = loadInstallationCredentials(env);
  const access = await mintInstallationToken(credentials, deps);
  return {
    accessToken: access.token,
    access,
    credentials,
    checkChecksWrite: createInstallationCheckChecksWrite(access, deps),
  };
}
