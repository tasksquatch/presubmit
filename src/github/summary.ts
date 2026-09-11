import type { CheckConclusion, CheckRunOutput } from "./checks.js";

export type AttestationMode = "local-developer" | "orchestrator";

export interface BuildCheckOutputParams {
  checkName: string;
  conclusion: CheckConclusion;
  headSha: string;
  login?: string;
  durationMs: number;
  cliVersion: string;
  /** Check Run attestation label. Derived from publish auth mode. */
  attestation: AttestationMode;
}

const LOCAL_DEVELOPER_DISCLAIMER =
  "_Local Presubmit records that this developer machine ran the configured checks for this commit. It is not independent hosted verification._";

const ORCHESTRATOR_DISCLAIMER =
  "_Local Presubmit records an installation-auth run from automation for this commit. It is not independent GitHub-hosted verification. Operators may require this labeled check as a merge gate._";

/**
 * Build Check Run title/summary/text without claiming independent verification.
 */
export function buildCheckOutput(params: BuildCheckOutputParams): CheckRunOutput {
  const verb =
    params.conclusion === "success"
      ? "passed"
      : params.conclusion === "failure"
        ? "failed"
        : "cancelled";
  const title = `${params.checkName} ${verb}`;
  const durationSec = (params.durationMs / 1000).toFixed(1);
  const showDeveloper =
    params.attestation === "local-developer" && Boolean(params.login);
  const disclaimer =
    params.attestation === "orchestrator"
      ? ORCHESTRATOR_DISCLAIMER
      : LOCAL_DEVELOPER_DISCLAIMER;
  const lines = [
    `### ${title}`,
    "",
    `- **Commit:** \`${params.headSha}\``,
    `- **Attestation:** \`${params.attestation}\``,
    showDeveloper ? `- **Developer:** @${params.login}` : null,
    `- **Duration:** ${durationSec}s`,
    `- **CLI:** @tasksquatch/presubmit@${params.cliVersion}`,
    "",
    disclaimer,
  ].filter((line): line is string => line !== null);

  const output: CheckRunOutput = {
    title,
    summary: lines.join("\n"),
  };

  return output;
}
