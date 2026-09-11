import { describe, expect, it } from "vitest";
import type { GitExec } from "./exec.js";
import { discoverRepoState, GitDiscoveryError } from "./discovery.js";
import {
  enforceIntegrityGates,
  GitIntegrityError,
} from "./integrity.js";
import type { RepoState } from "./discovery.js";

function scriptedExec(
  handlers: Array<{
    match: (args: string[]) => boolean;
    result?: string;
    error?: Error;
  }>,
): GitExec {
  return async (args) => {
    for (const handler of handlers) {
      if (handler.match(args)) {
        if (handler.error) {
          throw handler.error;
        }
        return handler.result ?? "";
      }
    }
    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  };
}

const baseState: RepoState = {
  root: "/repo",
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "feature",
  remoteName: "origin",
  repo: { owner: "example-org", repo: "example-repo" },
};

describe("discoverRepoState", () => {
  it("resolves root, HEAD, branch, and owner/repo", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel",
        result: "/repo",
      },
      {
        match: (a) => a[0] === "rev-parse" && a[1] === "HEAD",
        result: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      {
        match: (a) => a[0] === "rev-parse" && a[1] === "--abbrev-ref",
        result: "main",
      },
      {
        match: (a) => a[0] === "remote" && a[1] === "-v",
        result:
          "origin\tgit@github.com:example-org/presubmit.git (fetch)\norigin\tgit@github.com:example-org/presubmit.git (push)\n",
      },
    ]);

    const state = await discoverRepoState("/somewhere", exec);
    expect(state).toEqual({
      root: "/repo",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      branch: "main",
      remoteName: "origin",
      repo: { owner: "example-org", repo: "presubmit" },
    });
  });

  it("throws when not a git repository", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel",
        error: new Error("not a git repo"),
      },
    ]);
    await expect(discoverRepoState("/tmp", exec)).rejects.toBeInstanceOf(
      GitDiscoveryError,
    );
  });
});

describe("enforceIntegrityGates", () => {
  it("rejects a dirty worktree with commit/stash guidance", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: " M src/cli.ts\n",
      },
    ]);

    await expect(
      enforceIntegrityGates({
        state: baseState,
        config: { requireCleanWorktree: true, requirePushedCommit: true },
        exec,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitIntegrityError);
      expect((err as Error).message).toMatch(/dirty/i);
      expect((err as Error).message).toMatch(/commit or stash/i);
      return true;
    });
  });

  it("rejects an unpushed SHA with git push guidance", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => a.includes("@{u}"),
        result: "origin/feature",
      },
      {
        match: (a) => a[0] === "merge-base" && a.includes("--is-ancestor"),
        error: new Error("not ancestor"),
      },
    ]);

    await expect(
      enforceIntegrityGates({
        state: baseState,
        config: { requireCleanWorktree: true, requirePushedCommit: true },
        exec,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitIntegrityError);
      expect((err as Error).message).toMatch(/git push/i);
      return true;
    });
  });

  it("passes when clean and SHA is ancestor of upstream", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => a.includes("@{u}"),
        result: "origin/feature",
      },
      {
        match: (a) => a[0] === "merge-base" && a.includes("--is-ancestor"),
        result: "",
      },
    ]);

    const result = await enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: true, requirePushedCommit: true },
      exec,
    });
    expect(result.effectiveSha).toBe(baseState.headSha);
    expect(result.skipped).toBe(false);
  });

  it("uses --sha as the effective SHA for the pushed check", async () => {
    const override = baseState.headSha;
    const seenAncestor: string[] = [];
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "rev-parse" && a[1] === "--verify",
        result: override,
      },
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => a.includes("@{u}"),
        result: "origin/feature",
      },
      {
        match: (a) => {
          if (a[0] === "merge-base" && a.includes("--is-ancestor")) {
            seenAncestor.push(a[2]);
            return true;
          }
          return false;
        },
        result: "",
      },
    ]);

    const result = await enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: true, requirePushedCommit: true },
      shaOverride: "aaaa",
      exec,
    });
    expect(result.effectiveSha).toBe(override);
    expect(seenAncestor).toEqual([override]);
  });

  it("skips gates when skipIntegrity is set", async () => {
    const exec = scriptedExec([]);
    const result = await enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: true, requirePushedCommit: true },
      skipIntegrity: true,
      exec,
    });
    expect(result.skipped).toBe(true);
    expect(result.effectiveSha).toBe(baseState.headSha);
  });

  it("still enforces gates when publish is disabled (caller responsibility)", async () => {
    // --no-publish must not skip integrity; enforceIntegrityGates has no publish flag.
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "?? dirty.txt\n",
      },
    ]);
    await expect(
      enforceIntegrityGates({
        state: baseState,
        config: { requireCleanWorktree: true, requirePushedCommit: false },
        exec,
      }),
    ).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it("falls back to origin/branch when upstream is unset", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => a.includes("@{u}"),
        error: new Error("no upstream"),
      },
      {
        match: (a) =>
          a[0] === "rev-parse" &&
          a[1] === "--verify" &&
          a[2] === "refs/remotes/origin/feature",
        result: "dddddddddddddddddddddddddddddddddddddddd",
      },
      {
        match: (a) => a[0] === "merge-base" && a.includes("--is-ancestor"),
        result: "",
      },
    ]);

    const result = await enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: true, requirePushedCommit: true },
      exec,
    });
    expect(result.skipped).toBe(false);
  });
});


describe("SHA attestation", () => {
  it.each([false, true])("rejects a different commit with skipIntegrity=%s", async (skipIntegrity) => {
    await expect(enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: false, requirePushedCommit: false },
      shaOverride: "bbbb",
      skipIntegrity,
      exec: async () => "b".repeat(40),
    })).rejects.toThrow(/checked-out HEAD/);
  });

  it.each(["aaaa", baseState.headSha])("accepts a matching revision %s", async (shaOverride) => {
    await expect(enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: false, requirePushedCommit: false },
      shaOverride,
      exec: async () => baseState.headSha,
    })).resolves.toMatchObject({ effectiveSha: baseState.headSha });
  });
});
