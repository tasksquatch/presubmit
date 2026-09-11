/** Display name of the org GitHub App used by Local Presubmit. */
export const PRESUBMIT_APP_NAME = "Tasksquatch Presubmit";

/**
 * Guidance URL for App installation and Local Presubmit setup.
 * (Private App install links are org-specific; this repo documents how to install.)
 */
export const PRESUBMIT_APP_INSTALL_URL =
  "https://github.com/tasksquatch/presubmit";

/**
 * Actionable install hint for missing App / Checks: write.
 */
export function appInstallHint(): string {
  return `Install the ${PRESUBMIT_APP_NAME} GitHub App on this repository (Checks: write). See ${PRESUBMIT_APP_INSTALL_URL}`;
}
