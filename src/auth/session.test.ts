import { describe, expect, it, vi } from "vitest";
import { OAuthError } from "./github-oauth.js";
import { createMemoryStore } from "./memory-store.js";
import type { OAuthClient } from "./oauth-client.js";
import { AuthError, createAuthSession } from "./session.js";

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

describe("createAuthSession", () => {
  it("login saves credentials via device flow", async () => {
    const store = createMemoryStore();
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      fetchUser: async () => ({ id: 9, login: "octocat" }),
      sleep: async () => undefined,
    });

    const creds = await session.login();
    expect(creds.login).toBe("octocat");
    expect(await store.load()).toMatchObject({ login: "octocat", accessToken: "ghu_access" });
  });

  it("login fails when Client ID is REPLACE_ME", async () => {
    const session = createAuthSession({
      store: createMemoryStore(),
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "REPLACE_ME" },
    });
    await expect(session.login()).rejects.toBeInstanceOf(AuthError);
  });

  it("login succeeds with the compiled default Client ID", async () => {
    const store = createMemoryStore();
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: {},
      fetchUser: async () => ({ id: 9, login: "octocat" }),
      sleep: async () => undefined,
    });
    await session.login();
    expect(await store.load()).toMatchObject({ login: "octocat" });
  });

  it("logout clears store when logged in", async () => {
    const store = createMemoryStore({
      accessToken: "ghu_x",
      login: "octocat",
    });
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
    });

    const result = await session.logout();
    expect(result.cleared).toBe(true);
    expect(await store.load()).toBeNull();
  });

  it("logout is a no-op when already logged out", async () => {
    const session = createAuthSession({
      store: createMemoryStore(),
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
    });
    expect(await session.logout()).toEqual({ cleared: false, revoked: false });
  });

  it("ensureAccessToken refreshes an expired token", async () => {
    const store = createMemoryStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: "2000-01-01T00:00:00.000Z",
      login: "octocat",
      githubUserId: 1,
    });
    const oauth = mockOAuth({
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "fresh",
        refreshToken: "r2",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    });
    const session = createAuthSession({
      store,
      oauth,
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      isTTY: false,
    });

    const creds = await session.ensureAccessToken();
    expect(creds.accessToken).toBe("fresh");
    expect(creds.refreshToken).toBe("r2");
  });

  it("ensureAccessToken fails without TTY when refresh fails", async () => {
    const store = createMemoryStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const session = createAuthSession({
      store,
      oauth: mockOAuth({
        refreshToken: vi.fn().mockRejectedValue(new Error("bad refresh")),
      }),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      isTTY: false,
    });

    await expect(session.ensureAccessToken()).rejects.toBeInstanceOf(AuthError);
  });

  it("ensureAccessToken re-logins on TTY after refresh failure", async () => {
    const store = createMemoryStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const oauth = mockOAuth({
      refreshToken: vi.fn().mockRejectedValue(new Error("bad refresh")),
      exchangeDeviceCode: vi.fn().mockResolvedValue({
        accessToken: "from-login",
        expiresAt: "2099-01-01T00:00:00.000Z",
        refreshToken: "r-new",
      }),
    });
    const session = createAuthSession({
      store,
      oauth,
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      isTTY: true,
      fetchUser: async () => ({ id: 3, login: "retry" }),
      sleep: async () => undefined,
    });

    const creds = await session.ensureAccessToken();
    expect(creds.accessToken).toBe("from-login");
    expect(creds.login).toBe("retry");
  });

  it("getAuthStatus reports logged out", async () => {
    const session = createAuthSession({
      store: createMemoryStore(),
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
    });
    const status = await session.getAuthStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.message).toMatch(/Not logged in/);
  });

  it("getAuthStatus reports Checks write when resolvable", async () => {
    const store = createMemoryStore({
      accessToken: "ghu_ok",
      expiresAt: "2099-01-01T00:00:00.000Z",
      login: "octocat",
      githubUserId: 1,
      refreshToken: "r",
    });
    const session = createAuthSession({
      store,
      oauth: mockOAuth(),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      resolveRepo: async () => ({ owner: "example-org", repo: "example-repo" }),
      checkChecksWrite: async () => true,
    });

    const status = await session.getAuthStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.accessTokenValid).toBe(true);
    expect(status.checksWriteAvailable).toBe(true);
    expect(status.repo).toEqual({ owner: "example-org", repo: "example-repo" });
  });

  it("getAuthStatus reports Checks write false", async () => {
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
      resolveRepo: async () => ({ owner: "example-org", repo: "example-repo" }),
      checkChecksWrite: async () => false,
    });

    const status = await session.getAuthStatus();
    expect(status.checksWriteAvailable).toBe(false);
  });

  it("propagates device-flow denial from login", async () => {
    const session = createAuthSession({
      store: createMemoryStore(),
      oauth: mockOAuth({
        exchangeDeviceCode: vi
          .fn()
          .mockRejectedValue(new OAuthError("nope", "access_denied")),
      }),
      env: { PRESUBMIT_GITHUB_CLIENT_ID: "Iv1.test" },
      sleep: async () => undefined,
      fetchUser: async () => ({ id: 1, login: "x" }),
    });

    await expect(session.login()).rejects.toMatchObject({ code: "access_denied" });
  });
});
