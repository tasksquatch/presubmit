import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.js";

describe("createMemoryStore", () => {
  it("starts empty and supports save/load/clear", async () => {
    const store = createMemoryStore();
    expect(await store.load()).toBeNull();

    await store.save({
      accessToken: "token-1",
      login: "octocat",
      githubUserId: 1,
    });

    const loaded = await store.load();
    expect(loaded).toEqual({
      accessToken: "token-1",
      login: "octocat",
      githubUserId: 1,
    });

    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("can be seeded with initial credentials", async () => {
    const store = createMemoryStore({
      accessToken: "seed",
      refreshToken: "refresh",
    });
    expect(await store.load()).toMatchObject({ accessToken: "seed" });
  });
});
