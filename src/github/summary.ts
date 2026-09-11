import { redactSecrets } from "../output/index.js";
import type { CheckConclusion, CheckRunOutput } from "./checks.js";

export type AttestationMode = "local-developer" | "orchestrator";

/** GitHub Checks API limit for `output.text`. */
export const GITHUB_CHECK_OUTPUT_TEXT_MAX = 65535;

export interface BuildCheckOutputParams {
  checkName: string;
  conclusion: CheckConclusion;
  headSha: string;
  login?: string;
  durationMs: number;
  cliVersion: string;
  /** Check Run attestation label. Derived from publish auth mode. */
  attestation: AttestationMode;
  /** Optional `- **Result:**` line (failure, spawn error, cancelled). */
  resultLine?: string;
  /** Prepared `output.text`; omit or leave undefined to skip. */
  text?: string;
}

const LOCAL_DEVELOPER_DISCLAIMER =
  "_Local Presubmit records that this developer machine ran the configured checks for this commit. It is not independent hosted verification._";

const ORCHESTRATOR_DISCLAIMER =
  "_Local Presubmit records an installation-auth run from automation for this commit. It is not independent GitHub-hosted verification. The Check Run uses the configured check name; this line discloses the auth path._";

const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]|${String.fromCharCode(155)}[[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
);

/**
 * Strip CSI / ANSI color sequences from captured runner output.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * Build a GitHub Check Run `output.text` body: ANSI-stripped, redacted, fenced,
 * and capped to the Checks API character limit.
 */
export function prepareFailureOutputText(raw: string): string {
  const cleaned = redactSecrets(stripAnsi(raw));
  const source =
    cleaned.trim().length === 0 ? "No captured runner output." : cleaned;
  return fenceAndCap(source);
}

function fenceAndCap(source: string): string {
  let ticks = "```";
  while (source.includes(ticks)) {
    ticks += "`";
  }
  const prefix = `${ticks}text\n`;
  const suffix = `\n${ticks}`;
  const budget = GITHUB_CHECK_OUTPUT_TEXT_MAX - prefix.length - suffix.length;
  if (budget <= 0) {
    return prefix.slice(0, GITHUB_CHECK_OUTPUT_TEXT_MAX);
  }
  if (source.length <= budget) {
    return prefix + source + suffix;
  }
  const noticePrefix = "[truncated to last ";
  const noticeSuffix = " characters]\n";
  const noticeOverhead = noticePrefix.length + noticeSuffix.length + String(budget).length;
  const inner = Math.max(0, budget - noticeOverhead);
  const sliced = source.slice(-inner);
  const notice = `${noticePrefix}${sliced.length}${noticeSuffix}`;
  const body = notice + source.slice(-(budget - notice.length));
  const text = prefix + body + suffix;
  return text.length <= GITHUB_CHECK_OUTPUT_TEXT_MAX
    ? text
    : text.slice(0, GITHUB_CHECK_OUTPUT_TEXT_MAX);
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
    params.resultLine ? `- **Result:** ${params.resultLine}` : null,
    "",
    disclaimer,
  ].filter((line): line is string => line !== null);

  const output: CheckRunOutput = {
    title,
    summary: lines.join("\n"),
  };
  if (params.text !== undefined && params.text.length > 0) {
    output.text = params.text;
  }

  return output;
}
