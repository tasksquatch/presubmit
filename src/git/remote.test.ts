import { describe, expect, it } from "vitest";
import { parseGitHubRemoteUrl } from "./remote.js";

describe("parseGitHubRemoteUrl", () => {
  it("parses SSH remotes", () => {
    expect(parseGitHubRemoteUrl("git@github.com:example-org/example-repo.git")).toEqual({
      owner: "example-org",
      repo: "example-repo",
    });
  });

  it("parses HTTPS remotes", () => {
    expect(
      parseGitHubRemoteUrl("https://github.com/example-org/presubmit.git"),
    ).toEqual({ owner: "example-org", repo: "presubmit" });
  });

  it("parses ssh:// remotes", () => {
    expect(
      parseGitHubRemoteUrl("ssh://git@github.com/example-org/example-repo"),
    ).toEqual({ owner: "example-org", repo: "example-repo" });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemoteUrl("git@gitlab.com:org/repo.git")).toBeNull();
  });
});
