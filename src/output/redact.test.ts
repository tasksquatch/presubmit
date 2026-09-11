import { describe, expect, it } from "vitest";
import { redactSecrets, redactUnknown } from "./redact.js";

function armoredKey(body: string): string {
  const kind = "RSA PRIVATE KEY";
  return `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
}

describe("redactSecrets", () => {
  it("redacts PEM armor without leaving key material", () => {
    const body = "not-a-real-key";
    const redacted = redactSecrets(`failed: ${armoredKey(body)}`);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain(body);
    expect(redacted).not.toContain(`BEGIN ${"RSA PRIVATE KEY"}`);
  });

  it("redacts custom PEM labels the vendor detector may miss", () => {
    const body = "vendor-key-material";
    const pem = `-----BEGIN FOO PRIVATE KEY-----\n${body}\n-----END FOO PRIVATE KEY-----`;
    const redacted = redactSecrets(`failed: ${pem}`);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain(body);
    expect(redacted).not.toContain("BEGIN FOO PRIVATE KEY");
  });

  it("redacts JWT-shaped strings", () => {
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJpc3MiOiIxIn0", "signaturepart"].join(
      ".",
    );
    const redacted = redactSecrets(`auth failed ${jwt}`);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("redacts GitHub token prefixes including App installation tokens", () => {
    expect(redactSecrets("ghu_shorttoken")).toBe("[redacted]");
    expect(redactSecrets("ghp_shorttoken")).toBe("[redacted]");
    const assignment = redactSecrets("token=ghs_shorttoken");
    expect(assignment).toContain("[redacted]");
    expect(assignment).not.toContain("ghs_shorttoken");
  });

  it("redacts AWS access keys and npm tokens", () => {
    const aws = redactSecrets("key AKIAIOSFODNN7EXAMPLE extra");
    expect(aws).toContain("[redacted]");
    expect(aws).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const npmTok = `npm_${"a".repeat(36)}`;
    const npm = redactSecrets(`registry ${npmTok}`);
    expect(npm).toContain("[redacted]");
    expect(npm).not.toContain(npmTok);
  });

  it("leaves emails, IPv4, and git SHAs intact", () => {
    expect(redactSecrets("user@example.com failed")).toBe(
      "user@example.com failed",
    );
    expect(redactSecrets("ECONNREFUSED 127.0.0.1")).toBe(
      "ECONNREFUSED 127.0.0.1",
    );
    const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(redactSecrets(`commit ${sha}`)).toBe(`commit ${sha}`);
    const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(redactSecrets(`digest ${digest}`)).toBe(`digest ${digest}`);
  });

  it("leaves ordinary GitHub API messages intact", () => {
    expect(redactSecrets("Not Found")).toBe("Not Found");
    expect(redactSecrets("Bad credentials")).toBe("Bad credentials");
  });
});

describe("redactUnknown", () => {
  it("redacts Error messages", () => {
    expect(redactUnknown(new Error("got ghs_shorttoken"))).toBe("got [redacted]");
  });
});
