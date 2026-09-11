import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./memory-store.js";
import type { OAuthClient } from "./oauth-client.js";
import { revokeAndClear } from "./revoke.js";

describe("revokeAndClear", () => {
  it("clears the store even when revoke returns false", async () => {
    const store = createMemoryStore({
      accessToken: "ghu_x",
      login: "octocat",
    });
    const oauth: OAuthClient = {
      createDeviceCode: vi.fn(),
      exchangeDeviceCode: vi.fn(),
      refreshToken: vi.fn(),
      revokeToken: vi.fn().mockResolvedValue(false),
    };

    const result = await revokeAndClear({
      clientId: "Iv1.test",
      oauth,
      store,
      credentials: (await store.load())!,
    });

    expect(result.revoked).toBe(false);
    expect(await store.load()).toBeNull();
    expect(oauth.revokeToken).toHaveBeenCalledWith("Iv1.test", "ghu_x");
  });

  it("clears the store when revoke throws", async () => {
    const store = createMemoryStore({ accessToken: "ghu_x" });
    const oauth: OAuthClient = {
      createDeviceCode: vi.fn(),
      exchangeDeviceCode: vi.fn(),
      refreshToken: vi.fn(),
      revokeToken: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const result = await revokeAndClear({
      clientId: "Iv1.test",
      oauth,
      store,
      credentials: (await store.load())!,
    });

    expect(result.revoked).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("reports revoked=true when revoke succeeds", async () => {
    const store = createMemoryStore({ accessToken: "ghu_x" });
    const oauth: OAuthClient = {
      createDeviceCode: vi.fn(),
      exchangeDeviceCode: vi.fn(),
      refreshToken: vi.fn(),
      revokeToken: vi.fn().mockResolvedValue(true),
    };

    const result = await revokeAndClear({
      clientId: "Iv1.test",
      oauth,
      store,
      credentials: (await store.load())!,
    });

    expect(result.revoked).toBe(true);
    expect(await store.load()).toBeNull();
  });
});
