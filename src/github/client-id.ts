/**
 * Compiled-in GitHub App Client ID for Tasksquatch Presubmit (public OAuth client id).
 * Override with PRESUBMIT_GITHUB_CLIENT_ID for testing.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Iv23ligEpH8T5I1IzlRy";

/** Sentinel used before an App Client ID was embedded; still rejected if seen. */
export const UNCONFIGURED_CLIENT_ID = "REPLACE_ME";

export const CLIENT_ID_ENV = "PRESUBMIT_GITHUB_CLIENT_ID";

/** Unsupported secret env vars — never read for auth. */
export const FORBIDDEN_SECRET_ENVS = [
  "PRESUBMIT_GITHUB_CLIENT_SECRET",
] as const;

export type ClientIdSource = "default" | "env";

export interface ResolvedClientId {
  clientId: string;
  source: ClientIdSource;
}

/**
 * Resolve the GitHub App Client ID.
 * `PRESUBMIT_GITHUB_CLIENT_ID` overrides the compiled default for testing.
 * Client secret env vars are never used. Installation auth uses
 * `PRESUBMIT_GITHUB_PRIVATE_KEY` only with `--auth installation`.
 */
export function resolveClientId(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedClientId {
  const override = env[CLIENT_ID_ENV]?.trim();
  if (override) {
    return { clientId: override, source: "env" };
  }
  return { clientId: DEFAULT_GITHUB_CLIENT_ID, source: "default" };
}

/**
 * Returns names of forbidden secret env vars that are set.
 * The CLI must not read their values for authentication.
 */
export function detectForbiddenSecretEnvs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return FORBIDDEN_SECRET_ENVS.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

/** True when the Client ID is missing or still the pre-registration placeholder. */
export function isClientIdConfigured(clientId: string): boolean {
  const trimmed = clientId.trim();
  return trimmed !== "" && trimmed !== UNCONFIGURED_CLIENT_ID;
}
