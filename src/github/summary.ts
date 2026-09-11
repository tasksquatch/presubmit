import type { CheckConclusion, CheckRunOutput } from "./checks.js";

export interface BuildCheckOutputParams {
  checkName: string;
  conclusion: CheckConclusion;
  headSha: string;
  login?: string;
  durationMs: number;
  cliVersion: string;
}

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
  const lines = [
    `### ${title}`,
    "",
    `- **Commit:** \`${params.headSha}\``,
    params.login ? `- **Developer:** @${params.login}` : null,
    `- **Duration:** ${durationSec}s`,
    `- **CLI:** @tasksquatch/presubmit@${params.cliVersion}`,
    "",
    "_Local Presubmit records that this developer machine ran the configured checks for this commit. It is not independent hosted verification._",
  ].filter((line): line is string => line !== null);

  const output: CheckRunOutput = {
    title,
    summary: lines.join("\n"),
  };

  return output;
}
