import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  completeCheckRun,
  createChecksClient,
  createInProgressCheckRun,
  GitHubApiError,
  verifyAppAccess,
} from "./checks.js";
import { buildCheckOutput } from "./summary.js";

function mockOctokit(partial: {
  create?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}): Octokit {
  return {
    checks: {
      create: partial.create ?? vi.fn(),
      update: partial.update ?? vi.fn(),
    },
  } as unknown as Octokit;
}

describe("verifyAppAccess", () => {
  it("resolves when Checks write is available", async () => {
    await expect(
      verifyAppAccess("tok", { owner: "o", repo: "r" }, async () => true),
    ).resolves.toBeUndefined();
  });

  it("throws actionable error when App not installed", async () => {
    await expect(
      verifyAppAccess("tok", { owner: "o", repo: "r" }, async () => false),
    ).rejects.toThrow(/not installed/);
    await expect(
      verifyAppAccess("tok", { owner: "o", repo: "r" }, async () => false),
    ).rejects.toThrow(/https:\/\/github\.com\/tasksquatch\/presubmit/);
  });

  it("throws when verification is indeterminate", async () => {
    await expect(
      verifyAppAccess("tok", { owner: "o", repo: "r" }, async () => null),
    ).rejects.toThrow(/Could not verify/);
  });
});

describe("createInProgressCheckRun / completeCheckRun", () => {
  it("creates an in_progress check and returns id", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 55 } });
    const id = await createInProgressCheckRun(mockOctokit({ create }), {
      owner: "example-org",
      repo: "example-repo",
      name: "Local Presubmit",
      headSha: "abc",
    });
    expect(id).toBe(55);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "in_progress",
        head_sha: "abc",
        name: "Local Presubmit",
      }),
    );
  });

  it("completes a check with conclusion and output", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });
    await completeCheckRun(mockOctokit({ update }), {
      owner: "o",
      repo: "r",
      checkRunId: 9,
      conclusion: "failure",
      output: { title: "failed", summary: "sum" },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 9,
        status: "completed",
        conclusion: "failure",
        output: { title: "failed", summary: "sum" },
      }),
    );
  });

  it("wraps API errors as GitHubApiError", async () => {
    const create = vi.fn().mockRejectedValue(new Error("403 Forbidden"));
    await expect(
      createInProgressCheckRun(mockOctokit({ create }), {
        owner: "o",
        repo: "r",
        name: "Local Presubmit",
        headSha: "abc",
      }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe("createChecksClient", () => {
  it("delegates verify/create/complete", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const update = vi.fn().mockResolvedValue({ data: {} });
    const client = createChecksClient(mockOctokit({ create, update }), {
      accessToken: "tok",
      checkChecksWrite: async () => true,
    });
    await client.verifyAppAccess("o", "r");
    await client.createInProgressCheckRun({
      owner: "o",
      repo: "r",
      name: "Local Presubmit",
      headSha: "sha",
    });
    await client.completeCheckRun({
      owner: "o",
      repo: "r",
      checkRunId: 1,
      conclusion: "success",
      output: { title: "ok", summary: "s" },
    });
    expect(create).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });
});

describe("buildCheckOutput", () => {
  it("includes provenance without claiming independent verification as a proof claim beyond disclosure", () => {
    const out = buildCheckOutput({
      checkName: "Local Presubmit",
      conclusion: "success",
      headSha: "deadbeef",
      login: "dev",
      durationMs: 1500,
      cliVersion: "0.1.3",
    });
    expect(out.title).toBe("Local Presubmit passed");
    expect(out.summary).toContain("deadbeef");
    expect(out.summary).toContain("@dev");
    expect(out.summary).toContain("0.1.3");
    expect(out.summary).toMatch(/not independent hosted verification/i);
    expect(out).not.toHaveProperty("text");
  });

  it("publishes structured output on failure", () => {
    const out = buildCheckOutput({
      checkName: "Local Presubmit",
      conclusion: "failure",
      headSha: "sha",
      durationMs: 10,
      cliVersion: "0.1.3",
    });
    expect(out.title).toContain("failed");
    expect(out).not.toHaveProperty("text");
  });
});
