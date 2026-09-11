import { describe, expect, it, vi } from "vitest";
import { OAuthError } from "./github-oauth.js";
import { runDeviceFlow } from "./device-flow.js";
import type { OAuthClient } from "./oauth-client.js";

function mockOAuth(partial: Partial<OAuthClient>): OAuthClient {
  return {
    createDeviceCode: vi.fn(),
    exchangeDeviceCode: vi.fn(),
    refreshToken: vi.fn(),
    revokeToken: vi.fn().mockResolvedValue(false),
    ...partial,
  };
}

describe("runDeviceFlow", () => {
  it("stores tokens and user after successful poll", async () => {
    const oauth = mockOAuth({
      createDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 1,
      }),
      exchangeDeviceCode: vi
        .fn()
        .mockRejectedValueOnce(
          new OAuthError("pending", "authorization_pending"),
        )
        .mockResolvedValueOnce({
          accessToken: "ghu_access",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "ghr_refresh",
          refreshTokenExpiresAt: "2099-06-01T00:00:00.000Z",
        }),
    });

    const prompts: Array<{ userCode: string }> = [];
    const credentials = await runDeviceFlow({
      clientId: "Iv1.test",
      oauth,
      sleep: async () => undefined,
      fetchUser: async () => ({ id: 42, login: "octocat" }),
      onPrompt: (p) => prompts.push(p),
    });

    expect(prompts[0]?.userCode).toBe("ABCD-1234");
    expect(credentials).toEqual({
      accessToken: "ghu_access",
      expiresAt: "2099-01-01T00:00:00.000Z",
      refreshToken: "ghr_refresh",
      refreshTokenExpiresAt: "2099-06-01T00:00:00.000Z",
      githubUserId: 42,
      login: "octocat",
    });
  });

  it("propagates access_denied", async () => {
    const oauth = mockOAuth({
      createDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 1,
      }),
      exchangeDeviceCode: vi
        .fn()
        .mockRejectedValue(new OAuthError("denied", "access_denied")),
    });

    await expect(
      runDeviceFlow({
        clientId: "Iv1.test",
        oauth,
        sleep: async () => undefined,
        fetchUser: async () => ({ id: 1, login: "x" }),
        onPrompt: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("propagates expired_token", async () => {
    const oauth = mockOAuth({
      createDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 1,
      }),
      exchangeDeviceCode: vi
        .fn()
        .mockRejectedValue(new OAuthError("expired", "expired_token")),
    });

    await expect(
      runDeviceFlow({
        clientId: "Iv1.test",
        oauth,
        sleep: async () => undefined,
        fetchUser: async () => ({ id: 1, login: "x" }),
        onPrompt: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("increases interval on slow_down then succeeds", async () => {
    const sleeps: number[] = [];
    const oauth = mockOAuth({
      createDeviceCode: vi.fn().mockResolvedValue({
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      }),
      exchangeDeviceCode: vi
        .fn()
        .mockRejectedValueOnce(new OAuthError("slow", "slow_down"))
        .mockResolvedValueOnce({ accessToken: "ghu_ok" }),
    });

    const credentials = await runDeviceFlow({
      clientId: "Iv1.test",
      oauth,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchUser: async () => ({ id: 7, login: "slow" }),
      onPrompt: () => undefined,
    });

    expect(sleeps[0]).toBe(5_000);
    expect(sleeps[1]).toBe(10_000);
    expect(credentials.accessToken).toBe("ghu_ok");
  });
});
