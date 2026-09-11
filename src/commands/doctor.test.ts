import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "./doctor.js";
import { ExitCode } from "../output/index.js";
import type { AuthSession } from "../auth/index.js";
import type { RepoState } from "../git/discovery.js";
import {
  PRESUBMIT_APP_INSTALL_URL,
  PRESUBMIT_APP_NAME,
} from "../github/app-info.js";
import { DEFAULT_CONFIG } from "../config/load.js";

const cleanState: RepoState = {
  root: "/repo",
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "feature",
  remoteName: "origin",
  repo: { owner: "example-org", repo: "example-repo" },
};

function mockSession(
  partial: {
    loggedIn?: boolean;
    accessTokenValid?: boolean;
    login?: string;
    ensureFails?: boolean;
  } = {},
): AuthSession {
  const loggedIn = partial.loggedIn ?? true;
  const accessTokenValid = partial.accessTokenValid ?? true;
  return {
    login: vi.fn(),
    logout: vi.fn(),
    ensureAccessToken: vi.fn().mockImplementation(async () => {
      if (partial.ensureFails) {
        throw new Error("ensure failed");
      }
      return { accessToken: "tok", login: partial.login ?? "dev" };
    }),
    getAuthStatus: vi.fn().mockResolvedValue({
      loggedIn,
      login: partial.login ?? "dev",
      accessTokenValid,
      clientId: "Iv1.test",
      clientIdSource: "env",
      message: loggedIn ? "Authenticated." : "Not logged in.",
      checksWriteAvailable: null,
    }),
  } as unknown as AuthSession;
}

function captureStd(): { errors: string[]; warns: string[]; infos: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errors.push(String(msg ?? ""));
  });
  vi.spyOn(console, "warn").mockImplementation((msg?: unknown) => {
    warns.push(String(msg ?? ""));
  });
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    infos.push(String(msg ?? ""));
  });
  return { errors, warns, infos };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const healthyBase = {
  env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.doctor-test" },
  isGitAvailable: async () => true,
  isKeyringAvailable: async () => true,
  isCommandAvailable: async () => true,
  session: mockSession(),
  checkChecksWrite: async () => true as boolean | null,
  discover: async () => cleanState,
  exec: async (args: string[]) => {
    if (args[0] === "status") {
      return "";
    }
    if (args.includes("@{u}")) {
      return "origin/feature";
    }
    if (args[0] === "merge-base") {
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return "ok";
    }
    return "";
  },
  loadConfigFn: async () => ({
    config: { ...DEFAULT_CONFIG, runnerArgs: [...DEFAULT_CONFIG.runnerArgs] },
    path: null,
  }),
};

describe("doctorCommand", () => {
  it("succeeds when the full chain is healthy", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand(healthyBase);
    expect(code).toBe(ExitCode.Success);
    expect(errors.some((e) => e.startsWith("[fail]"))).toBe(false);
  });

  it("fails when not a git repo", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      discover: async () => {
        throw new Error("Not a git repository");
      },
    });
    expect(code).toBe(ExitCode.GitError);
    expect(errors.join("\n")).toMatch(/git-repo.*fail|\[fail\] git-repo/i);
  });

  it("fails when remote is not GitHub", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      discover: async () => ({ ...cleanState, repo: null }),
    });
    expect(code).toBe(ExitCode.GitError);
    expect(errors.join("\n")).toMatch(/github-remote/);
    expect(errors.join("\n")).toMatch(/github\.com/i);
  });

  it("fails when not logged in and instructs presubmit login", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      session: mockSession({ loggedIn: false }),
    });
    expect(code).toBe(ExitCode.AuthError);
    expect(errors.join("\n")).toMatch(/presubmit login/);
  });

  it("fails when Checks write is missing with App name and install URL", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      checkChecksWrite: async () => false,
    });
    expect(code).toBe(ExitCode.GitHubError);
    const text = errors.join("\n");
    expect(text).toContain(PRESUBMIT_APP_NAME);
    expect(text).toContain(PRESUBMIT_APP_INSTALL_URL);
  });

  it("fails on invalid .presubmit.yaml version", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-doctor-"));
    await writeFile(path.join(dir, ".presubmit.yaml"), "version: 99\n", "utf8");
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      cwd: dir,
      discover: async () => ({ ...cleanState, root: dir }),
      loadConfigFn: undefined,
    });
    expect(code).toBe(ExitCode.ConfigError);
    expect(errors.join("\n")).toMatch(/config/);
    expect(errors.join("\n")).toMatch(/Unsupported|schema|version/i);
  });

  it("fails when runner binary is missing", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      isCommandAvailable: async () => false,
    });
    expect(code).toBe(ExitCode.ConfigError);
    expect(errors.join("\n")).toMatch(/\[fail\] runner/);
    expect(errors.join("\n")).toMatch(/NOT FOUND/);
  });

  it("warns on dirty worktree but still succeeds", async () => {
    const { warns, errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      exec: async (args: string[]) => {
        if (args[0] === "status") {
          return " M dirty.ts\n";
        }
        if (args.includes("@{u}")) {
          return "origin/feature";
        }
        if (args[0] === "merge-base") {
          return "";
        }
        return "";
      },
    });
    expect(code).toBe(ExitCode.Success);
    expect(warns.join("\n")).toMatch(/worktree|dirty/i);
    expect(errors.some((e) => e.startsWith("[fail]"))).toBe(false);
  });

  it("warns on unpushed HEAD but still succeeds", async () => {
    const { warns } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      exec: async (args: string[]) => {
        if (args[0] === "status") {
          return "";
        }
        if (args.includes("@{u}")) {
          return "origin/feature";
        }
        if (args[0] === "merge-base") {
          throw new Error("not an ancestor");
        }
        return "";
      },
    });
    expect(code).toBe(ExitCode.Success);
    expect(warns.join("\n")).toMatch(/pushed-sha|push/i);
  });

  it("warns about forbidden secret envs without failing", async () => {
    const { warns } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      env: {
        PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.doctor-test",
        PRESUBMIT_GITHUB_CLIENT_SECRET: "should-be-ignored",
      },
    });
    expect(code).toBe(ExitCode.Success);
    expect(warns.join("\n")).toMatch(/CLIENT_SECRET/);
  });

  it("does not treat PRESUBMIT_GITHUB_PRIVATE_KEY as a forbidden unused secret", async () => {
    const { warns } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      auth: "device",
      env: {
        PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.doctor-test",
        PRESUBMIT_GITHUB_PRIVATE_KEY: "installation-key",
      },
    });
    expect(code).toBe(ExitCode.Success);
    expect(warns.join("\n")).not.toMatch(/PRIVATE_KEY/);
  });

  it("fails auto mode when installation env is incomplete", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      env: {
        PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.doctor-test",
        PRESUBMIT_GITHUB_APP_ID: "1",
      },
    });
    expect(code).toBe(ExitCode.AuthError);
    expect(errors.join("\n")).toMatch(/installation-credentials/);
    expect(errors.join("\n")).toMatch(/PRESUBMIT_GITHUB_INSTALLATION_ID/);
  });

  it("succeeds in installation mode without a keyring", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      auth: "installation",
      isKeyringAvailable: async () => false,
      env: {
        PRESUBMIT_GITHUB_APP_ID: "1",
        PRESUBMIT_GITHUB_INSTALLATION_ID: "2",
        PRESUBMIT_GITHUB_PRIVATE_KEY: "inline-pem",
      },
      mintInstallationTokenFn: async () => ({
        token: "install-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        permissions: { checks: "write" },
        repositorySelection: "all",
      }),
      checkInstallationChecksWrite: async () => true,
    });
    expect(code).toBe(ExitCode.Success);
    expect(errors.some((e) => e.startsWith("[fail]"))).toBe(false);
  });

  it("fails installation mode when credentials are missing", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      auth: "installation",
      isKeyringAvailable: async () => false,
      env: {},
    });
    expect(code).toBe(ExitCode.AuthError);
    expect(errors.join("\n")).toMatch(/installation-credentials/);
    expect(errors.join("\n")).toMatch(/PRESUBMIT_GITHUB_APP_ID/);
  });

  it("fails when installation lacks Checks write", async () => {
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      auth: "installation",
      env: {
        PRESUBMIT_GITHUB_APP_ID: "1",
        PRESUBMIT_GITHUB_INSTALLATION_ID: "2",
        PRESUBMIT_GITHUB_PRIVATE_KEY: "inline-pem",
      },
      mintInstallationTokenFn: async () => ({
        token: "install-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        permissions: { checks: "read" },
        repositorySelection: "selected",
      }),
      checkInstallationChecksWrite: async () => false,
    });
    expect(code).toBe(ExitCode.GitHubError);
    expect(errors.join("\n")).toContain(PRESUBMIT_APP_NAME);
    expect(errors.join("\n")).toContain(PRESUBMIT_APP_INSTALL_URL);
  });

  it("fails when the installation id is missing on GitHub", async () => {
    const { GitHubApiError } = await import("../github/index.js");
    const { errors } = captureStd();
    const code = await doctorCommand({
      ...healthyBase,
      auth: "installation",
      env: {
        PRESUBMIT_GITHUB_APP_ID: "1",
        PRESUBMIT_GITHUB_INSTALLATION_ID: "2",
        PRESUBMIT_GITHUB_PRIVATE_KEY: "inline-pem",
      },
      mintInstallationTokenFn: async () => {
        throw new GitHubApiError("installation 2 was not found for this App");
      },
    });
    expect(code).toBe(ExitCode.GitHubError);
    expect(errors.join("\n")).toMatch(/installation-token/);
    expect(errors.join("\n")).toMatch(/not found/);
  });
});
