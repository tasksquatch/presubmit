import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommand } from "./run.js";
import { ExitCode } from "../output/index.js";
import type { RepoState } from "../git/discovery.js";
import { GitIntegrityError } from "../git/integrity.js";
import type { GitExec } from "../git/exec.js";
import type { AuthSession } from "../auth/index.js";
import type { ChecksClient } from "../github/index.js";
import type { RunChecksResult } from "../runner/index.js";

const cleanState: RepoState = {
  root: "/repo",
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "feature",
  remoteName: "origin",
  repo: { owner: "example-org", repo: "example-repo" },
};

function mockSession(login = "dev"): AuthSession {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    ensureAccessToken: vi.fn().mockResolvedValue({
      accessToken: "tok",
      login,
    }),
    getAuthStatus: vi.fn(),
  } as unknown as AuthSession;
}

function mockChecks(overrides: Partial<ChecksClient> = {}): ChecksClient {
  return {
    verifyAppAccess: vi.fn().mockResolvedValue(undefined),
    createInProgressCheckRun: vi.fn().mockResolvedValue(42),
    completeCheckRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function okRun(partial: Partial<RunChecksResult> = {}): RunChecksResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    capturedLog: "",
    cancelled: false,
    ...partial,
  };
}

describe("runCommand integrity wiring", () => {
  it("returns GitError when integrity fails, even with publish=false", async () => {
    const exec: GitExec = async (args) => {
      if (args[0] === "status") {
        return " M file.ts\n";
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };

    const code = await runCommand({
      cwd: "/repo",
      publish: false,
      discover: async () => cleanState,
      exec,
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.GitError);
  });

  it("bypasses integrity with skipIntegrity", async () => {
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      publish: false,
      discover: async () => cleanState,
      exec: async () => {
        throw new GitIntegrityError("should not run");
      },
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.Success);
  });

  it("returns GitError when discovery fails", async () => {
    const code = await runCommand({
      cwd: "/repo",
      discover: async () => {
        throw new Error("boom");
      },
    });
    expect(code).toBe(ExitCode.GitError);
  });

  it("passes sha override through to integrity", async () => {
    const override = cleanState.headSha;
    const seen: string[] = [];
    const exec: GitExec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        seen.push(args[2] ?? "");
        return override;
      }
      if (args[0] === "status") {
        return "";
      }
      if (args.includes("@{u}")) {
        return "origin/feature";
      }
      if (args[0] === "merge-base") {
        return "";
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };

    const code = await runCommand({
      cwd: "/repo",
      sha: "aaaa",
      skipIntegrity: false,
      publish: false,
      discover: async () => cleanState,
      exec,
      runChecksFn: async () => okRun(),
    });
    expect(seen[0]).toContain("aaaa");
    expect(code).toBe(ExitCode.Success);
  });
});

describe("runCommand Check Run lifecycle", () => {
  it("publishes success and returns 0", async () => {
    const checks = mockChecks();
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      discover: async () => cleanState,
      session: mockSession(),
      checksClient: checks,
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.Success);
    expect(checks.verifyAppAccess).toHaveBeenCalledWith(
      "example-org",
      "example-repo",
    );
    expect(checks.createInProgressCheckRun).toHaveBeenCalled();
    expect(checks.completeCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success" }),
    );
    const output = vi.mocked(checks.completeCheckRun).mock.calls[0]?.[0].output;
    expect(output?.summary).toContain("**Attestation:** `local-developer`");
    expect(output?.summary).toMatch(/Developer/);
  });

  it("returns ChecksFailed and completes failure", async () => {
    const checks = mockChecks();
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      discover: async () => cleanState,
      session: mockSession(),
      checksClient: checks,
      runChecksFn: async () =>
        okRun({ exitCode: 1, capturedLog: "test failed" }),
    });
    expect(code).toBe(ExitCode.ChecksFailed);
    expect(checks.completeCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "failure",
        output: expect.not.objectContaining({ text: expect.anything() }),
      }),
    );
  });

  it("returns Cancelled and completes cancelled", async () => {
    const checks = mockChecks();
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      discover: async () => cleanState,
      session: mockSession(),
      checksClient: checks,
      runChecksFn: async () => okRun({ exitCode: 1, cancelled: true }),
    });
    expect(code).toBe(ExitCode.Cancelled);
    expect(checks.completeCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "cancelled" }),
    );
  });

  it("returns GitHubError when publish fails after local success", async () => {
    const checks = mockChecks({
      completeCheckRun: vi
        .fn()
        .mockRejectedValue(new Error("API down")),
    });
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      discover: async () => cleanState,
      session: mockSession(),
      checksClient: checks,
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.GitHubError);
  });

  it("skips Checks APIs with --no-publish and still reports local failure", async () => {
    const checks = mockChecks();
    const spawn = vi.fn(async () => okRun({ exitCode: 2 }));
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      publish: false,
      discover: async () => cleanState,
      checksClient: checks,
      runChecksFn: spawn,
    });
    expect(code).toBe(ExitCode.ChecksFailed);
    expect(checks.verifyAppAccess).not.toHaveBeenCalled();
    expect(checks.createInProgressCheckRun).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalled();
  });

  it("does not spawn when Checks write is missing", async () => {
    const { GitHubApiError } = await import("../github/index.js");
    const checks = mockChecks({
      verifyAppAccess: vi
        .fn()
        .mockRejectedValue(new GitHubApiError("not installed")),
    });

    const spawn = vi.fn(async () => okRun());
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      discover: async () => cleanState,
      session: mockSession(),
      checksClient: checks,
      runChecksFn: spawn,
    });
    expect(code).toBe(ExitCode.GitHubError);
    expect(spawn).not.toHaveBeenCalled();
    expect(checks.createInProgressCheckRun).not.toHaveBeenCalled();
  });

  it("returns ConfigError for unsupported schema version", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-run-"));
    await writeFile(path.join(dir, ".presubmit.yaml"), "version: 99\n", "utf8");
    const code = await runCommand({
      cwd: dir,
      publish: false,
      discover: async () => cleanState,
      skipIntegrity: true,
    });
    expect(code).toBe(ExitCode.ConfigError);
  });
});

describe("createProgram run options", () => {
  it("registers sha, no-publish, and skip-integrity options", async () => {
    const { createProgram } = await import("../cli.js");
    const program = createProgram();
    const run = program.commands.find((c) => c.name() === "run");
    expect(run).toBeDefined();
    const names = run!.options.map((o) => o.long ?? o.short);
    expect(names).toEqual(
      expect.arrayContaining([
        "--sha",
        "--no-publish",
        "--skip-integrity",
        "--integrity",
        "--auth",
      ]),
    );
    const integrity = run!.options.find((o) => o.long === "--integrity");
    expect(integrity?.argChoices).toEqual(["developer", "pre-push", "post-push"]);
  });
});


describe("runCommand installation auth", () => {
  it("skips device-flow session when auth is installation", async () => {
    const session = mockSession();
    const checks = mockChecks();
    const code = await runCommand({
      cwd: "/repo",
      auth: "installation",
      skipIntegrity: true,
      discover: async () => cleanState,
      session,
      checksClient: checks,
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.Success);
    expect(session.ensureAccessToken).not.toHaveBeenCalled();
    expect(checks.verifyAppAccess).toHaveBeenCalled();
    expect(checks.createInProgressCheckRun).toHaveBeenCalled();
  });

  it("returns AuthError when installation credentials are missing", async () => {
    const session = mockSession();
    const runner = vi.fn(async () => okRun());
    const code = await runCommand({
      cwd: "/repo",
      auth: "installation",
      skipIntegrity: true,
      discover: async () => cleanState,
      session,
      env: {},
      runChecksFn: runner,
    });
    expect(code).toBe(ExitCode.AuthError);
    expect(session.ensureAccessToken).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns GitHubError when installation token mint fails", async () => {
    const { GitHubApiError } = await import("../github/index.js");
    const session = mockSession();
    const code = await runCommand({
      cwd: "/repo",
      auth: "installation",
      skipIntegrity: true,
      discover: async () => cleanState,
      session,
      installationAuth: async () => {
        throw new GitHubApiError("installation 2 was not found");
      },
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.GitHubError);
    expect(session.ensureAccessToken).not.toHaveBeenCalled();
  });

  it("redacts token material in installation auth failures", async () => {
    const { GitHubApiError } = await import("../github/index.js");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });
    try {
      const code = await runCommand({
        cwd: "/repo",
        auth: "installation",
        skipIntegrity: true,
        discover: async () => cleanState,
        installationAuth: async () => {
          throw new GitHubApiError("mint failed ghp_shorttoken");
        },
        runChecksFn: async () => okRun(),
      });
      expect(code).toBe(ExitCode.GitHubError);
      const text = errors.join("\n");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("ghp_shorttoken");
    } finally {
      spy.mockRestore();
    }
  });

  it("redacts token material when Check Run completion fails", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });
    try {
      const checks = mockChecks({
        completeCheckRun: vi
          .fn()
          .mockRejectedValue(new Error("update failed ghp_shorttoken")),
      });
      const code = await runCommand({
        cwd: "/repo",
        auth: "installation",
        skipIntegrity: true,
        discover: async () => cleanState,
        checksClient: checks,
        runChecksFn: async () => okRun(),
      });
      expect(code).toBe(ExitCode.GitHubError);
      const text = errors.join("\n");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("ghp_shorttoken");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mint installation tokens when publish is disabled", async () => {
    const installationAuth = vi.fn();
    const session = mockSession();
    const code = await runCommand({
      cwd: "/repo",
      auth: "installation",
      publish: false,
      skipIntegrity: true,
      discover: async () => cleanState,
      session,
      installationAuth,
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.Success);
    expect(installationAuth).not.toHaveBeenCalled();
    expect(session.ensureAccessToken).not.toHaveBeenCalled();
  });

  it("omits developer login from Check Run output in installation mode", async () => {
    const checks = mockChecks();
    await runCommand({
      cwd: "/repo",
      auth: "installation",
      skipIntegrity: true,
      discover: async () => cleanState,
      checksClient: checks,
      runChecksFn: async () => okRun(),
    });
    const output = vi.mocked(checks.completeCheckRun).mock.calls[0]?.[0].output;
    expect(output?.summary).not.toMatch(/Developer/);
    expect(output?.summary).toContain("**Attestation:** `orchestrator`");
  });

  it("forwards env to the runner so secrets can be scrubbed", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const code = await runCommand({
      cwd: "/repo",
      publish: false,
      skipIntegrity: true,
      discover: async () => cleanState,
      env: { PRESUBMIT_GITHUB_PRIVATE_KEY: "pem-secret", PATH: "/bin" },
      runChecksFn: async (opts) => {
        seen = opts.env;
        return okRun();
      },
    });
    expect(code).toBe(ExitCode.Success);
    expect(seen?.PRESUBMIT_GITHUB_PRIVATE_KEY).toBe("pem-secret");
  });
});

describe("publication privacy", () => {
  it.each(["failure", "cancelled", "spawn-error"])("never uploads diagnostic output for %s", async (scenario) => {
    const marker = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
    const checks = mockChecks();
    const code = await runCommand({
      cwd: "/repo", skipIntegrity: true, discover: async () => cleanState,
      session: mockSession(), checksClient: checks,
      runChecksFn: async () => {
        if (scenario === "spawn-error") throw new Error(marker);
        return okRun({ exitCode: 1, cancelled: scenario === "cancelled", stdout: marker, stderr: marker, capturedLog: marker });
      },
    });
    expect(code).toBe(scenario === "spawn-error" ? ExitCode.ConfigError : scenario === "cancelled" ? ExitCode.Cancelled : ExitCode.ChecksFailed);
    const calls = vi.mocked(checks.completeCheckRun).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].output).not.toHaveProperty("text");
    expect(JSON.stringify(calls)).not.toContain(marker);
  });

  it.each([false, true])("rejects SHA mismatch before auth, publication or execution (skip=%s)", async (skipIntegrity) => {
    const checks = mockChecks();
    const session = mockSession();
    const runner = vi.fn(async () => okRun());
    const code = await runCommand({
      cwd: "/repo", sha: "bbbb", skipIntegrity, discover: async () => cleanState,
      session, checksClient: checks, exec: async () => "b".repeat(40), runChecksFn: runner,
    });
    expect(code).toBe(ExitCode.GitError);
    expect(session.ensureAccessToken).not.toHaveBeenCalled();
    expect(checks.createInProgressCheckRun).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("runCommand integrity profiles", () => {
  it("fail-fast pre-push succeeds without a remote-tracking SHA", async () => {
    const exec: GitExec = async (args) => {
      if (args[0] === "status") {
        return "";
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const runner = vi.fn(async () => okRun());
    const code = await runCommand({
      cwd: "/repo",
      publish: false,
      integrity: "pre-push",
      discover: async () => cleanState,
      exec,
      runChecksFn: runner,
    });
    expect(code).toBe(ExitCode.Success);
    expect(runner).toHaveBeenCalled();
  });

  it("rejects pre-push with publish before auth or Checks", async () => {
    const checks = mockChecks();
    const session = mockSession();
    const runner = vi.fn(async () => okRun());
    const discover = vi.fn(async () => cleanState);
    const code = await runCommand({
      cwd: "/repo",
      integrity: "pre-push",
      discover,
      session,
      checksClient: checks,
      runChecksFn: runner,
    });
    expect(code).toBe(ExitCode.GitError);
    expect(discover).not.toHaveBeenCalled();
    expect(session.ensureAccessToken).not.toHaveBeenCalled();
    expect(checks.createInProgressCheckRun).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("publishes orchestrator attestation with installation + post-push", async () => {
    const checks = mockChecks();
    const code = await runCommand({
      cwd: "/repo",
      auth: "installation",
      integrity: "post-push",
      skipIntegrity: true,
      discover: async () => cleanState,
      checksClient: checks,
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.Success);
    const output = vi.mocked(checks.completeCheckRun).mock.calls[0]?.[0].output;
    expect(output?.summary).toContain("**Attestation:** `orchestrator`");
    expect(output?.summary).not.toMatch(/Developer/);
  });

  it("still bypasses clean and pushed gates with skipIntegrity", async () => {
    const code = await runCommand({
      cwd: "/repo",
      skipIntegrity: true,
      integrity: "post-push",
      publish: false,
      discover: async () => cleanState,
      exec: async () => {
        throw new GitIntegrityError("should not run");
      },
      runChecksFn: async () => okRun(),
    });
    expect(code).toBe(ExitCode.Success);
  });
});
