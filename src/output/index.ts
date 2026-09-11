/**
 * Stable CLI exit codes for Local Presubmit.
 */
export const ExitCode = {
  Success: 0,
  ChecksFailed: 1,
  ConfigError: 2,
  AuthError: 3,
  GitError: 4,
  GitHubError: 5,
  Cancelled: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function info(message: string): void {
  console.log(message);
}

export function warn(message: string): void {
  console.warn(message);
}

export function error(message: string): void {
  console.error(message);
}

export { redactSecrets, redactUnknown } from "./redact.js";
