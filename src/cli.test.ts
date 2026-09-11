import { describe, expect, it } from "vitest";
import { createProgram } from "./cli.js";

describe("createProgram", () => {
  it("registers the five MVP commands", () => {
    const program = createProgram();
    const topLevel = program.commands.map((c) => c.name()).sort();
    expect(topLevel).toEqual(["auth", "doctor", "login", "logout", "run"]);

    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
    const authSubs = auth!.commands.map((c) => c.name());
    expect(authSubs).toContain("status");
  });
});
