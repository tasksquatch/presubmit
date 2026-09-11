import { describe, expect, it } from "vitest";
import type { GitExec } from "./exec.js";
import { discoverRepoState, GitDiscoveryError } from "./discovery.js";
import {
  enforceIntegrityGates,
  GitIntegrityError,
  resolveIntegrityRequirements,
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

describe("resolveIntegrityRequirements", () => {
  const yamlOn = { requireCleanWorktree: true, requirePushedCommit: true };
  const yamlOff = { requireCleanWorktree: false, requirePushedCommit: false };

  it("honors yaml for developer", () => {
    expect(resolveIntegrityRequirements(yamlOn, "developer")).toEqual(yamlOn);
    expect(resolveIntegrityRequirements(yamlOff, "developer")).toEqual(yamlOff);
  });

  it("forces requirePushedCommit false for pre-push", () => {
    expect(resolveIntegrityRequirements(yamlOn, "pre-push")).toEqual({
      requireCleanWorktree: true,
      requirePushedCommit: false,
    });
  });

  it("forces requirePushedCommit true for post-push", () => {
    expect(resolveIntegrityRequirements(yamlOff, "post-push")).toEqual({
      requireCleanWorktree: false,
      requirePushedCommit: true,
    });
  });
});

describe("integrity profiles", () => {
  it("allows an unpushed SHA with pre-push", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
    ]);

    const result = await enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: true, requirePushedCommit: true },
      profile: "pre-push",
      exec,
    });
    expect(result.skipped).toBe(false);
    expect(result.effectiveSha).toBe(baseState.headSha);
  });

  it("still requires a pushed SHA with post-push even when yaml disables it", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => a[0] === "fetch",
        result: "",
      },
      {
        match: (a) => a[0] === "for-each-ref",
        result: "",
      },
    ]);

    await expect(
      enforceIntegrityGates({
        state: baseState,
        config: { requireCleanWorktree: true, requirePushedCommit: false },
        profile: "post-push",
        exec,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitIntegrityError);
      expect((err as Error).message).toMatch(/git push/i);
      return true;
    });
  });

  it("refreshes remote-tracking refs and accepts detached HEAD on post-push", async () => {
    const seen: string[][] = [];
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => {
          if (a[0] === "fetch") {
            seen.push(a);
            return true;
          }
          return false;
        },
        result: "",
      },
      {
        match: (a) => a[0] === "for-each-ref",
        result: "refs/remotes/origin/feature\n",
      },
    ]);

    const result = await enforceIntegrityGates({
      state: { ...baseState, branch: "HEAD" },
      config: { requireCleanWorktree: true, requirePushedCommit: false },
      profile: "post-push",
      exec,
    });
    expect(result.skipped).toBe(false);
    expect(seen).toEqual([["fetch", "--prune", "--no-tags", "origin"]]);
  });

  it("fails post-push when fetch fails", async () => {
    const exec = scriptedExec([
      {
        match: (a) => a[0] === "status" && a.includes("--porcelain"),
        result: "",
      },
      {
        match: (a) => a[0] === "fetch",
        error: new Error("could not fetch"),
      },
    ]);

    await expect(
      enforceIntegrityGates({
        state: baseState,
        config: { requireCleanWorktree: false, requirePushedCommit: false },
        profile: "post-push",
        exec,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitIntegrityError);
      expect((err as Error).message).toMatch(/fetch/i);
      return true;
    });
  });

  it("does not fetch for the developer profile", async () => {
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
      profile: "developer",
      exec,
    });
    expect(result.skipped).toBe(false);
  });

  it("keeps developer pushed-commit behavior when yaml requires it", async () => {
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
        profile: "developer",
        exec,
      }),
    ).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it("still requires a clean worktree on pre-push when yaml requires it", async () => {
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
        profile: "pre-push",
        exec,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitIntegrityError);
      expect((err as Error).message).toMatch(/dirty/i);
      return true;
    });
  });
});

describe("SHA attestation", () => {
  it.each([
    { skipIntegrity: false, profile: "developer" as const },
    { skipIntegrity: true, profile: "developer" as const },
    { skipIntegrity: false, profile: "pre-push" as const },
    { skipIntegrity: true, profile: "pre-push" as const },
    { skipIntegrity: false, profile: "post-push" as const },
    { skipIntegrity: true, profile: "post-push" as const },
  ])(
    "rejects a different commit with skipIntegrity=$skipIntegrity profile=$profile",
    async ({ skipIntegrity, profile }) => {
      await expect(
        enforceIntegrityGates({
          state: baseState,
          config: { requireCleanWorktree: false, requirePushedCommit: false },
          shaOverride: "bbbb",
          skipIntegrity,
          profile,
          exec: async () => "b".repeat(40),
        }),
      ).rejects.toThrow(/checked-out HEAD/);
    },
  );

  it.each(["aaaa", baseState.headSha])("accepts a matching revision %s", async (shaOverride) => {
    await expect(enforceIntegrityGates({
      state: baseState,
      config: { requireCleanWorktree: false, requirePushedCommit: false },
      shaOverride,
      exec: async () => baseState.headSha,
    })).resolves.toMatchObject({ effectiveSha: baseState.headSha });
  });
});
