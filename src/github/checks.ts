import type { Octokit } from "@octokit/rest";
import type { GitHubRepoRef } from "../git/remote.js";
import { appInstallHint, PRESUBMIT_APP_NAME } from "./app-info.js";

export class GitHubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export type CheckConclusion = "success" | "failure" | "cancelled";

export interface CheckRunOutput {
  title: string;
  summary: string;
  /** Truncated failure details; omitted on success and when opt-out is set. */
  text?: string;
}

export interface CreateInProgressCheckRunParams {
  owner: string;
  repo: string;
  name: string;
  headSha: string;
}

export interface CompleteCheckRunParams {
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: CheckConclusion;
  output: CheckRunOutput;
}

export interface ChecksClient {
  verifyAppAccess(owner: string, repo: string): Promise<void>;
  createInProgressCheckRun(
    params: CreateInProgressCheckRunParams,
  ): Promise<number>;
  completeCheckRun(params: CompleteCheckRunParams): Promise<void>;
}

/**
 * Verify the user token can write Checks for the repo via App installation visibility.
 */
export async function verifyAppAccess(
  accessToken: string,
  repo: GitHubRepoRef,
  checkChecksWrite: (
    accessToken: string,
    repo: GitHubRepoRef,
  ) => Promise<boolean | null>,
): Promise<void> {
  const result = await checkChecksWrite(accessToken, repo);
  const hint = appInstallHint();
  if (result === true) {
    return;
  }
  if (result === false) {
    throw new GitHubApiError(
      `${PRESUBMIT_APP_NAME} App is not installed (or lacks Checks: write) for ${repo.owner}/${repo.repo}. ${hint}`,
    );
  }
  throw new GitHubApiError(
    `Could not verify App installation / Checks write for ${repo.owner}/${repo.repo}. Confirm you are logged in and the App is installed. ${hint}`,
  );
}

export async function createInProgressCheckRun(
  octokit: Octokit,
  params: CreateInProgressCheckRunParams,
): Promise<number> {
  try {
    const { data } = await octokit.checks.create({
      owner: params.owner,
      repo: params.repo,
      name: params.name,
      head_sha: params.headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    });
    return data.id;
  } catch (err) {
    throw wrapApiError("Failed to create Check Run", err);
  }
}

export async function completeCheckRun(
  octokit: Octokit,
  params: CompleteCheckRunParams,
): Promise<void> {
  try {
    await octokit.checks.update({
      owner: params.owner,
      repo: params.repo,
      check_run_id: params.checkRunId,
      status: "completed",
      conclusion: params.conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: params.output.title,
        summary: params.output.summary,
        ...(params.output.text !== undefined ? { text: params.output.text } : {}),
      },
    });
  } catch (err) {
    throw wrapApiError("Failed to complete Check Run", err);
  }
}

function wrapApiError(prefix: string, err: unknown): GitHubApiError {
  const detail =
    err instanceof Error
      ? err.message
      : typeof err === "object" &&
          err !== null &&
          "message" in err &&
          typeof (err as { message: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);
  return new GitHubApiError(`${prefix}: ${detail}`);
}

/**
 * Octokit-backed Checks client used by `presubmit run`.
 */
export function createChecksClient(
  octokit: Octokit,
  options: {
    accessToken: string;
    checkChecksWrite: (
      accessToken: string,
      repo: GitHubRepoRef,
    ) => Promise<boolean | null>;
  },
): ChecksClient {
  return {
    async verifyAppAccess(owner, repo) {
      await verifyAppAccess(options.accessToken, { owner, repo }, options.checkChecksWrite);
    },
    async createInProgressCheckRun(params) {
      return createInProgressCheckRun(octokit, params);
    },
    async completeCheckRun(params) {
      return completeCheckRun(octokit, params);
    },
  };
}
