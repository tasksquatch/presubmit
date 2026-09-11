import { Octokit } from "@octokit/rest";

export interface CreateOctokitOptions {
  /** GitHub user access token from the credential store. */
  token: string;
  /** Optional base URL (e.g. GitHub Enterprise). */
  baseUrl?: string;
}

/**
 * Centralized Octokit factory. Prefer this over raw REST calls elsewhere.
 */
export function createOctokit(options: CreateOctokitOptions): Octokit {
  return new Octokit({
    auth: options.token,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
}
