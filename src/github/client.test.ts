import { describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { createOctokit } from "./client.js";

describe("createOctokit", () => {
  it("returns an Octokit instance configured with the token", () => {
    const client = createOctokit({ token: "ghu_test" });
    expect(client).toBeInstanceOf(Octokit);
  });
});
