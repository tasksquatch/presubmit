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

  it("registers --auth on run, doctor, and auth status", () => {
    const program = createProgram();
    const run = program.commands.find((c) => c.name() === "run");
    const doctor = program.commands.find((c) => c.name() === "doctor");
    const auth = program.commands.find((c) => c.name() === "auth");
    const status = auth?.commands.find((c) => c.name() === "status");
    expect(run?.options.some((o) => o.long === "--auth")).toBe(true);
    expect(doctor?.options.some((o) => o.long === "--auth")).toBe(true);
    expect(status?.options.some((o) => o.long === "--auth")).toBe(true);

    const runAuth = run?.options.find((o) => o.long === "--auth");
    expect(runAuth?.argChoices).toEqual(["device", "installation"]);
    const doctorAuth = doctor?.options.find((o) => o.long === "--auth");
    expect(doctorAuth?.argChoices).toEqual(["auto", "device", "installation"]);
  });
});
