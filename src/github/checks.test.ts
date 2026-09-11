import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { VERSION } from "../version.js";
import {
  completeCheckRun,
  createChecksClient,
  createInProgressCheckRun,
  GitHubApiError,
  verifyAppAccess,
} from "./checks.js";
import { buildCheckOutput, GITHUB_CHECK_OUTPUT_TEXT_MAX, prepareFailureOutputText, stripAnsi } from "./summary.js";

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

  it("includes output.text when set and omits it when absent", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });
    await completeCheckRun(mockOctokit({ update }), {
      owner: "o",
      repo: "r",
      checkRunId: 9,
      conclusion: "failure",
      output: { title: "failed", summary: "sum", text: "tail" },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { title: "failed", summary: "sum", text: "tail" },
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
      cliVersion: VERSION,
      attestation: "local-developer",
    });
    expect(out.title).toBe("Local Presubmit passed");
    expect(out.summary).toContain("deadbeef");
    expect(out.summary).toContain("**Attestation:** `local-developer`");
    expect(out.summary).toContain("@dev");
    expect(out.summary).toContain(VERSION);
    expect(out.summary).toMatch(/not independent hosted verification/i);
    expect(out).not.toHaveProperty("text");
  });

  it("labels orchestrator attestation and omits the Developer line", () => {
    const out = buildCheckOutput({
      checkName: "Local Presubmit",
      conclusion: "success",
      headSha: "deadbeef",
      login: "dev",
      durationMs: 1500,
      cliVersion: VERSION,
      attestation: "orchestrator",
    });
    expect(out.summary).toContain("**Attestation:** `orchestrator`");
    expect(out.summary).not.toMatch(/Developer/);
    expect(out.summary).not.toContain("@dev");
    expect(out.summary).toMatch(/installation-auth run from automation/i);
    expect(out.summary).toMatch(/not independent GitHub-hosted verification/i);
    expect(out.summary).toMatch(/configured check name/i);
    expect(out).not.toHaveProperty("text");
  });

  it("publishes structured output on failure without text unless provided", () => {
    const out = buildCheckOutput({
      checkName: "Local Presubmit",
      conclusion: "failure",
      headSha: "sha",
      durationMs: 10,
      cliVersion: VERSION,
      attestation: "local-developer",
      resultLine: "Local checks failed (exit 1). Truncated runner output is attached.",
      text: "```text\ntest failed\n```",
    });
    expect(out.title).toContain("failed");
    expect(out.summary).toContain("**Attestation:** `local-developer`");
    expect(out.summary).toContain("**Result:** Local checks failed (exit 1)");
    expect(out.text).toContain("test failed");
  });

  it("omits text on success even if a result line is absent", () => {
    const out = buildCheckOutput({
      checkName: "Local Presubmit",
      conclusion: "success",
      headSha: "sha",
      durationMs: 10,
      cliVersion: VERSION,
      attestation: "local-developer",
    });
    expect(out).not.toHaveProperty("text");
  });
});

describe("prepareFailureOutputText", () => {
  it("strips ANSI, redacts secrets, and fences the body", () => {
    const text = prepareFailureOutputText(
      `${String.fromCharCode(27)}[31mfailed ghs_shorttoken${String.fromCharCode(27)}[0m`,
    );
    expect(text).toMatch(/^```text\n/);
    expect(text).toMatch(/\n```$/);
    expect(text).not.toContain("ghs_shorttoken");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(String.fromCharCode(27));
  });

  it("notes when capture is empty", () => {
    expect(prepareFailureOutputText("   ")).toContain("No captured runner output.");
  });

  it("caps published text to the GitHub Check Run limit", () => {
    const huge = "x".repeat(GITHUB_CHECK_OUTPUT_TEXT_MAX + 50_000);
    const text = prepareFailureOutputText(huge);
    expect(text.length).toBeLessThanOrEqual(GITHUB_CHECK_OUTPUT_TEXT_MAX);
    expect(text).toMatch(/truncated to last \d+ characters/);
  });

  it("neutralizes embedded fences", () => {
    const text = prepareFailureOutputText("```\nsecret\n```");
    expect(text.startsWith("````")).toBe(true);
  });

  it("builds a fence from the longest backtick run without quadratic scanning", () => {
    const run = "`".repeat(20);
    const text = prepareFailureOutputText(`before ${run} after`);
    expect(text.startsWith("`".repeat(21))).toBe(true);
    expect(text).toContain(run);
  });
});

describe("stripAnsi", () => {
  it("removes CSI color sequences", () => {
    expect(stripAnsi(`\u001b[31mred\u001b[0m`)).toBe("red");
  });

  it("removes private-mode CSI and OSC-8 hyperlinks", () => {
    const hideCursor = `\u001b[?25lvisible`;
    expect(stripAnsi(hideCursor)).toBe("visible");
    const link = `\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007`;
    expect(stripAnsi(link)).toBe("click");
  });
});
