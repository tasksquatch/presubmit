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

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const C1_CSI = String.fromCharCode(155);
const ST = `(?:${BEL}|${ESC}\\\\|${String.fromCharCode(156)})`;

/**
 * CSI (including private-mode `?`), OSC (BEL / ST terminated), and C1 CSI.
 * Adapted from the MIT-licensed ansi-regex coverage of those families.
 */
const ANSI_ESCAPE = new RegExp(
  `[${ESC}${C1_CSI}][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${ST})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

/**
 * Strip ANSI / OSC control sequences from captured runner output.
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

function longestBacktickRun(source: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "`") {
      run++;
      if (run > max) {
        max = run;
      }
    } else {
      run = 0;
    }
  }
  return max;
}

function fenceAndCap(source: string): string {
  const ticks = "`".repeat(Math.max(3, longestBacktickRun(source) + 1));
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
