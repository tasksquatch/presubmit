import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../github/checks.js";
import { AuthError } from "./session.js";
import {
  APP_ID_ENV,
  checkInstallationChecksWrite,
  createAppJwt,
  createInstallationAuth,
  detectInstallationEnv,
  INSTALLATION_ID_ENV,
  loadInstallationCredentials,
  mintInstallationToken,
  missingInstallationCredentialsMessage,
  PRIVATE_KEY_ENV,
  PRIVATE_KEY_PATH_ENV,
  resolveDiagnosticAuthMode,
} from "./installation.js";

const { privateKey: testPem, publicKey: testPublicPem } = generateKeyPairSync(
  "rsa",
  {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  },
);

function decodeJwtPayload(jwt: string): {
  iat: number;
  exp: number;
  iss: number;
} {
  const payload = jwt.split(".")[1];
  expect(payload).toBeDefined();
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
    iat: number;
    exp: number;
    iss: number;
  };
}

describe("detectInstallationEnv", () => {
  it("reports none when no installation vars are set", () => {
    expect(detectInstallationEnv({})).toEqual({
      presence: "none",
      present: [],
      missing: [
        APP_ID_ENV,
        INSTALLATION_ID_ENV,
        `${PRIVATE_KEY_ENV} or ${PRIVATE_KEY_PATH_ENV}`,
      ],
    });
  });

  it("reports partial when only some vars are set", () => {
    const detected = detectInstallationEnv({
      [APP_ID_ENV]: "123",
    });
    expect(detected.presence).toBe("partial");
    expect(detected.present).toEqual([APP_ID_ENV]);
    expect(detected.missing).toContain(INSTALLATION_ID_ENV);
  });

  it("reports complete when app, installation, and key are set", () => {
    const detected = detectInstallationEnv({
      [APP_ID_ENV]: "123",
      [INSTALLATION_ID_ENV]: "456",
      [PRIVATE_KEY_ENV]: testPem,
    });
    expect(detected.presence).toBe("complete");
    expect(detected.missing).toEqual([]);
  });

  it("treats empty strings as unset", () => {
    expect(
      detectInstallationEnv({
        [APP_ID_ENV]: "  ",
        [INSTALLATION_ID_ENV]: "",
      }).presence,
    ).toBe("none");
  });
});

describe("resolveDiagnosticAuthMode", () => {
  it("uses device when auto and no installation env", () => {
    expect(resolveDiagnosticAuthMode("auto", {}).mode).toBe("device");
  });

  it("uses installation when auto and complete env", () => {
    expect(
      resolveDiagnosticAuthMode("auto", {
        [APP_ID_ENV]: "1",
        [INSTALLATION_ID_ENV]: "2",
        [PRIVATE_KEY_ENV]: "x",
      }).mode,
    ).toBe("installation");
  });

  it("uses installation when auto and partial env so diagnostics fail", () => {
    expect(
      resolveDiagnosticAuthMode("auto", { [APP_ID_ENV]: "1" }).mode,
    ).toBe("installation");
  });

  it("honors explicit device even when installation env is present", () => {
    expect(
      resolveDiagnosticAuthMode("device", {
        [APP_ID_ENV]: "1",
        [INSTALLATION_ID_ENV]: "2",
        [PRIVATE_KEY_ENV]: "x",
      }).mode,
    ).toBe("device");
  });

  it("honors explicit installation even when env is empty", () => {
    expect(resolveDiagnosticAuthMode("installation", {}).mode).toBe(
      "installation",
    );
  });
});

describe("loadInstallationCredentials", () => {
  it("throws AuthError listing missing variables", () => {
    expect(() => loadInstallationCredentials({})).toThrow(AuthError);
    expect(() => loadInstallationCredentials({})).toThrow(
      missingInstallationCredentialsMessage([
        APP_ID_ENV,
        INSTALLATION_ID_ENV,
        `${PRIVATE_KEY_ENV} or ${PRIVATE_KEY_PATH_ENV}`,
      ]),
    );
  });

  it("rejects non-positive app id", () => {
    expect(() =>
      loadInstallationCredentials({
        [APP_ID_ENV]: "0",
        [INSTALLATION_ID_ENV]: "2",
        [PRIVATE_KEY_ENV]: testPem,
      }),
    ).toThrow(/positive integer/);
  });

  it("prefers inline PRIVATE_KEY over PRIVATE_KEY_PATH", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-pem-"));
    const keyPath = path.join(dir, "app.pem");
    await writeFile(keyPath, "path-key", "utf8");
    const creds = loadInstallationCredentials({
      [APP_ID_ENV]: "12",
      [INSTALLATION_ID_ENV]: "34",
      [PRIVATE_KEY_ENV]: testPem,
      [PRIVATE_KEY_PATH_ENV]: keyPath,
    });
    expect(creds.appId).toBe(12);
    expect(creds.installationId).toBe(34);
    expect(creds.keySource).toBe("env");
    expect(creds.privateKey).toMatch(/PRIVATE KEY/);
  });

  it("loads PEM from path when inline key is unset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-pem-"));
    const keyPath = path.join(dir, "app.pem");
    await writeFile(keyPath, testPem, "utf8");
    const creds = loadInstallationCredentials({
      [APP_ID_ENV]: "12",
      [INSTALLATION_ID_ENV]: "34",
      [PRIVATE_KEY_PATH_ENV]: keyPath,
    });
    expect(creds.keySource).toBe("path");
    expect(creds.privateKey).toMatch(/PRIVATE KEY/);
  });

  it("normalizes escaped newlines in inline PEM", () => {
    const escaped = testPem.replace(/\n/g, "\\n");
    const creds = loadInstallationCredentials({
      [APP_ID_ENV]: "1",
      [INSTALLATION_ID_ENV]: "2",
      [PRIVATE_KEY_ENV]: escaped,
    });
    expect(creds.privateKey).toContain("\n");
    expect(creds.privateKey).not.toContain("\\n");
  });

  it("throws when the private key path cannot be read", () => {
    expect(() =>
      loadInstallationCredentials({
        [APP_ID_ENV]: "1",
        [INSTALLATION_ID_ENV]: "2",
        [PRIVATE_KEY_PATH_ENV]: "/no/such/presubmit-app.pem",
      }),
    ).toThrow(/Unable to read GitHub App private key file/);
  });
});

describe("createAppJwt", () => {
  it("signs an RS256 JWT with skewed iat and sub-10-minute exp", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const jwt = createAppJwt(99, testPem, now);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64).toBeDefined();
    expect(payloadB64).toBeDefined();
    expect(sigB64).toBeDefined();
    const header = JSON.parse(
      Buffer.from(headerB64!, "base64url").toString("utf8"),
    ) as { alg: string; typ: string };
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decodeJwtPayload(jwt);
    expect(payload.iss).toBe(99);
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
    expect(
      verify(
        "sha256",
        Buffer.from(`${headerB64}.${payloadB64}`),
        testPublicPem,
        Buffer.from(sigB64!, "base64url"),
      ),
    ).toBe(true);
  });

  it("throws AuthError for an unparseable PEM", () => {
    expect(() => createAppJwt(1, "not-a-key")).toThrow(AuthError);
    expect(() => createAppJwt(1, "not-a-key")).toThrow(/Could not parse/);
  });
});

describe("mintInstallationToken", () => {
  const credentials = {
    appId: 1,
    installationId: 2,
    privateKey: testPem,
    keySource: "env" as const,
  };

  it("returns token, expiry, and permissions from the GitHub response", async () => {
    const access = await mintInstallationToken(credentials, {
      createAccessToken: async () => ({
        token: "install-token",
        expires_at: "2099-01-01T00:00:00.000Z",
        permissions: { checks: "write", metadata: "read" },
        repository_selection: "selected",
      }),
    });
    expect(access).toEqual({
      token: "install-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: { checks: "write", metadata: "read" },
      repositorySelection: "selected",
    });
  });

  it("maps 404 to a missing-installation GitHubApiError", async () => {
    await expect(
      mintInstallationToken(credentials, {
        createAccessToken: async () => {
          const err = new Error("Not Found") as Error & { status: number };
          err.status = 404;
          throw err;
        },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as Error).message).toMatch(/installation 2 was not found/);
      expect((err as Error).message).not.toContain(testPem);
      return true;
    });
  });

  it("wraps other API failures as GitHubApiError without leaking the PEM", async () => {
    await expect(
      mintInstallationToken(credentials, {
        createAccessToken: async () => {
          throw new Error(`Bad credentials ${credentials.privateKey}`);
        },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as Error).message).toMatch(/Failed to create installation access token/);
      expect((err as Error).message).not.toContain(credentials.privateKey);
      expect((err as Error).message).toContain("[redacted]");
      return true;
    });
  });
});

describe("checkInstallationChecksWrite", () => {
  const access = {
    token: "install-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    permissions: { checks: "write" },
    repositorySelection: "selected",
  };
  const repo = { owner: "example-org", repo: "example-repo" };

  it("returns false when Checks is not write", async () => {
    await expect(
      checkInstallationChecksWrite(
        { ...access, permissions: { checks: "read" } },
        repo,
        { getRepo: async () => "ok" },
      ),
    ).resolves.toBe(false);
  });

  it("returns true when Checks write is present and the repo is reachable", async () => {
    await expect(
      checkInstallationChecksWrite(access, repo, { getRepo: async () => "ok" }),
    ).resolves.toBe(true);
  });

  it("returns false when the installation cannot see the repo", async () => {
    await expect(
      checkInstallationChecksWrite(access, repo, {
        getRepo: async () => "not_found",
      }),
    ).resolves.toBe(false);
  });

  it("returns null when repo lookup is indeterminate", async () => {
    await expect(
      checkInstallationChecksWrite(access, repo, {
        getRepo: async () => "error",
      }),
    ).resolves.toBe(null);
  });
});

describe("createInstallationAuth", () => {
  it("loads credentials, mints a token, and returns a Checks:write checker", async () => {
    const getRepo = vi.fn(async () => "ok" as const);
    const result = await createInstallationAuth(
      {
        [APP_ID_ENV]: "9",
        [INSTALLATION_ID_ENV]: "8",
        [PRIVATE_KEY_ENV]: testPem,
      },
      {
        createAccessToken: async () => ({
          token: "install-token",
          expires_at: "2099-01-01T00:00:00.000Z",
          permissions: { checks: "write" },
          repository_selection: "all",
        }),
        getRepo,
      },
    );
    expect(result.accessToken).toBe("install-token");
    expect(result.credentials.appId).toBe(9);
    await expect(
      result.checkChecksWrite("ignored", {
        owner: "example-org",
        repo: "example-repo",
      }),
    ).resolves.toBe(true);
    expect(getRepo).toHaveBeenCalled();
  });
});
