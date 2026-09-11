export const CLIENT_SECRET_ENV = "PRESUBMIT_GITHUB_CLIENT_SECRET";

/** Env vars that must never be inherited by the configured check recipe. */
export const SCRUBBED_PRESUBMIT_ENVS = [
  "PRESUBMIT_GITHUB_PRIVATE_KEY",
  "PRESUBMIT_GITHUB_PRIVATE_KEY_PATH",
  "PRESUBMIT_GITHUB_APP_ID",
  "PRESUBMIT_GITHUB_INSTALLATION_ID",
  CLIENT_SECRET_ENV,
] as const;

/**
 * Copy `env` without Presubmit App secrets. Does not mutate the input.
 * Does not strip `GITHUB_TOKEN` / `GH_TOKEN`.
 */
export function scrubPresubmitSecrets(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const blocked = new Set(
    SCRUBBED_PRESUBMIT_ENVS.map((name) => name.toLowerCase()),
  );
  for (const key of Object.keys(next)) {
    if (blocked.has(key.toLowerCase())) {
      delete next[key];
    }
  }
  return next;
}
