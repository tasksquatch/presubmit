import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./memory-store.js";
import type { OAuthClient } from "./oauth-client.js";
import {
  isAccessTokenExpired,
  refreshStoredCredentials,
} from "./refresh.js";

function mockOAuth(partial: Partial<OAuthClient>): OAuthClient {
  return {
    createDeviceCode: vi.fn(),
    exchangeDeviceCode: vi.fn(),
    refreshToken: vi.fn(),
    revokeToken: vi.fn().mockResolvedValue(false),
    ...partial,
  };
}

describe("isAccessTokenExpired", () => {
  it("is false when no expiry is stored", () => {
    expect(isAccessTokenExpired({ accessToken: "x" }, 1_000)).toBe(false);
  });

  it("is true when expiry is within skew", () => {
    expect(
      isAccessTokenExpired(
        { accessToken: "x", expiresAt: new Date(1_000).toISOString() },
        1_000,
        60_000,
      ),
    ).toBe(true);
  });

  it("is false when expiry is far in the future", () => {
    expect(
      isAccessTokenExpired(
        {
          accessToken: "x",
          expiresAt: new Date(Date.UTC(2099, 0, 1)).toISOString(),
        },
        Date.now(),
      ),
    ).toBe(false);
  });
});

describe("refreshStoredCredentials", () => {
  it("persists rotated access and refresh tokens", async () => {
    const store = createMemoryStore({
      accessToken: "old",
      refreshToken: "refresh-old",
      login: "octocat",
      githubUserId: 1,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const oauth = mockOAuth({
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: "2099-01-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2099-06-01T00:00:00.000Z",
      }),
    });

    const updated = await refreshStoredCredentials({
      clientId: "Iv1.test",
      oauth,
      store,
      credentials: (await store.load())!,
    });

    expect(updated.accessToken).toBe("new-access");
    expect(updated.refreshToken).toBe("new-refresh");
    expect(await store.load()).toEqual(updated);
  });

  it("throws when refresh token is missing", async () => {
    const store = createMemoryStore({ accessToken: "only" });
    await expect(
      refreshStoredCredentials({
        clientId: "Iv1.test",
        oauth: mockOAuth({}),
        store,
        credentials: { accessToken: "only" },
      }),
    ).rejects.toThrow(/No refresh token/);
  });

  it("surfaces refresh failures without clearing the store", async () => {
    const store = createMemoryStore({
      accessToken: "old",
      refreshToken: "refresh-old",
      login: "octocat",
    });
    const oauth = mockOAuth({
      refreshToken: vi.fn().mockRejectedValue(new Error("invalid_grant")),
    });

    await expect(
      refreshStoredCredentials({
        clientId: "Iv1.test",
        oauth,
        store,
        credentials: (await store.load())!,
      }),
    ).rejects.toThrow(/invalid_grant/);

    expect(await store.load()).toMatchObject({ accessToken: "old" });
  });
});
