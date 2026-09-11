import { afterEach, describe, expect, it, vi } from "vitest";

// A throwing import models hosts without the native credential-store library.
afterEach(() => {
  vi.doUnmock("@napi-rs/keyring");
  vi.resetModules();
});

describe("lazy credential store", () => {
  it("loads the native module only when a store operation needs it", async () => {
    const getPassword = vi.fn().mockResolvedValue(null);
    const setPassword = vi.fn().mockResolvedValue(undefined);
    const deletePassword = vi.fn().mockResolvedValue(true);
    const AsyncEntry = vi.fn(function AsyncEntry() {
      return { getPassword, setPassword, deletePassword };
    });
    const factory = vi.fn(() => ({ AsyncEntry }));
    vi.doMock("@napi-rs/keyring", factory);
    const { createKeyringStore, isKeyringAvailable } = await import(
      "./keyring-store.js"
    );
    const store = createKeyringStore();
    expect(factory).not.toHaveBeenCalled();
    expect(await isKeyringAvailable()).toBe(true);
    expect(await store.load()).toBeNull();
    await store.save({ accessToken: "synthetic" });
    await store.clear();
    expect(setPassword).toHaveBeenCalled();
    expect(deletePassword).toHaveBeenCalled();
  });

  it("keeps help/version usable and reports actionable auth errors without native libraries", async () => {
    vi.doMock("@napi-rs/keyring", () => {
      throw new Error("missing native library");
    });
    const { createProgram } = await import("../cli.js");
    const program = createProgram();
    const output: string[] = [];
    program.configureOutput({ writeOut: (s) => output.push(s) }).exitOverride();
    expect(() => program.parse(["node", "cli", "--help"])).toThrow();
    expect(output.join("")).toContain("Usage:");
    output.length = 0;
    expect(() => program.parse(["node", "cli", "--version"])).toThrow();
    expect(output.join("")).toContain("0.1.2");
    const { createKeyringStore, isKeyringAvailable } = await import(
      "./keyring-store.js"
    );
    expect(await isKeyringAvailable()).toBe(false);
    await expect(createKeyringStore().load()).rejects.toThrow(/libsecret-1-0/);
    const { getDefaultStore } = await import("./session.js");
    await expect(getDefaultStore()).rejects.toThrow(/OS credential store/);
  });
});
