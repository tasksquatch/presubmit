import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_ID_ENV,
  DEFAULT_GITHUB_CLIENT_ID,
  detectForbiddenSecretEnvs,
  isClientIdConfigured,
  resolveClientId,
  UNCONFIGURED_CLIENT_ID,
} from "./client-id.js";

describe("resolveClientId", () => {
  afterEach(() => {
    delete process.env[CLIENT_ID_ENV];
  });

  it("returns the compiled default when env is unset", () => {
    delete process.env[CLIENT_ID_ENV];
    const resolved = resolveClientId({});
    expect(resolved).toEqual({
      clientId: DEFAULT_GITHUB_CLIENT_ID,
      source: "default",
    });
  });

  it("prefers PRESUBMIT_GITHUB_CLIENT_ID when set", () => {
    const resolved = resolveClientId({
      [CLIENT_ID_ENV]: "Iv1.test-client-id",
    });
    expect(resolved).toEqual({
      clientId: "Iv1.test-client-id",
      source: "env",
    });
  });
});

describe("isClientIdConfigured", () => {
  it("rejects empty and REPLACE_ME placeholders", () => {
    expect(isClientIdConfigured("")).toBe(false);
    expect(isClientIdConfigured(UNCONFIGURED_CLIENT_ID)).toBe(false);
  });

  it("accepts the compiled default Client ID", () => {
    expect(isClientIdConfigured(DEFAULT_GITHUB_CLIENT_ID)).toBe(true);
  });
});

describe("detectForbiddenSecretEnvs", () => {
  it("reports client secret env vars when set", () => {
    const found = detectForbiddenSecretEnvs({
      PRESUBMIT_GITHUB_CLIENT_SECRET: "nope",
      PRESUBMIT_GITHUB_PRIVATE_KEY: "installation-ok",
    });
    expect(found).toEqual(["PRESUBMIT_GITHUB_CLIENT_SECRET"]);
  });

  it("ignores empty forbidden env vars", () => {
    expect(
      detectForbiddenSecretEnvs({
        PRESUBMIT_GITHUB_CLIENT_SECRET: "",
      }),
    ).toEqual([]);
  });

  it("does not treat Client ID override as forbidden", () => {
    expect(
      detectForbiddenSecretEnvs({
        [CLIENT_ID_ENV]: "Iv1.ok",
      }),
    ).toEqual([]);
  });
});
