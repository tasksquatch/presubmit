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

  it("redacts JWT-shaped strings", () => {
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJpc3MiOiIxIn0", "signaturepart"].join(
      ".",
    );
    const redacted = redactSecrets(`auth failed ${jwt}`);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("redacts GitHub token prefixes", () => {
    expect(redactSecrets("token=ghs_shorttoken")).toBe("token=[redacted]");
    expect(redactSecrets("ghu_shorttoken")).toBe("[redacted]");
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
