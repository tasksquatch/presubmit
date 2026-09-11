import { describe, expect, it } from "vitest";
import { ExitCode } from "./index.js";

describe("ExitCode", () => {
  it("exposes stable numeric codes", () => {
    expect(ExitCode.Success).toBe(0);
    expect(ExitCode.ChecksFailed).toBe(1);
    expect(ExitCode.ConfigError).toBe(2);
    expect(ExitCode.AuthError).toBe(3);
    expect(ExitCode.GitError).toBe(4);
    expect(ExitCode.GitHubError).toBe(5);
    expect(ExitCode.Cancelled).toBe(6);
  });
});
