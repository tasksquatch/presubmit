import { describe, expect, it, vi } from "vitest";
import { createAuthSession } from "../auth/session.js";
import { createMemoryStore } from "../auth/memory-store.js";
import type { OAuthClient } from "../auth/oauth-client.js";
import { authStatusCommand } from "./auth-status.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { ExitCode } from "../output/index.js";

function mockOAuth(partial: Partial<OAuthClient> = {}): OAuthClient {
  return {
    createDeviceCode: vi.fn().mockResolvedValue({
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 1,
    }),
    exchangeDeviceCode: vi.fn().mockResolvedValue({
      accessToken: "ghu_access",
      expiresAt: "2099-01-01T00:00:00.000Z",
      refreshToken: "ghr_refresh",
    }),
    refreshToken: vi.fn(),
    revokeToken: vi.fn().mockResolvedValue(false),
    ...partial,
  };
}

describe("auth commands", () => {
  it("loginCommand returns Success on device-flow login", async () => {
    const store = createMemoryStore();
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      fetchUser: async () => ({ id: 1, login: "octocat" }),
      sleep: async () => undefined,
    });

    const code = await loginCommand({ session });
    expect(code).toBe(ExitCode.Success);
    expect(await store.load()).toMatchObject({ login: "octocat" });
  });

  it("logoutCommand clears credentials", async () => {
    const store = createMemoryStore({ accessToken: "ghu_x", login: "octocat" });
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
    });

    const code = await logoutCommand({ session });
    expect(code).toBe(ExitCode.Success);
    expect(await store.load()).toBeNull();
  });

  it("authStatusCommand returns AuthError when logged out", async () => {
    const session = createAuthSession({
      store: createMemoryStore(),
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
    });

    const code = await authStatusCommand({ session });
    expect(code).toBe(ExitCode.AuthError);
  });

  it("authStatusCommand returns Success when logged in", async () => {
    const store = createMemoryStore({
      accessToken: "ghu_ok",
      expiresAt: "2099-01-01T00:00:00.000Z",
      login: "octocat",
      githubUserId: 1,
    });
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      resolveRepo: async () => null,
    });

    const code = await authStatusCommand({ session });
    expect(code).toBe(ExitCode.Success);
  });
});
