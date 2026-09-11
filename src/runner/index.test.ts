import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runChecks, type SpawnFn } from "./index.js";

function fakeChild(options: {
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  failSpawn?: Error;
}): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];

  queueMicrotask(() => {
    if (options.failSpawn) {
      child.emit("error", options.failSpawn);
      return;
    }
    if (options.stdout) {
      stdout.write(options.stdout);
    }
    if (options.stderr) {
      stderr.write(options.stderr);
    }
    stdout.end();
    stderr.end();
    child.emit("close", options.exitCode ?? 0, options.signal ?? null);
  });

  return child;
}

describe("runChecks", () => {
  it("streams output, preserves exit code, and captures logs", async () => {
    const spawnFn: SpawnFn = (cmd, args, opts) => {
      expect(cmd).toBe("just");
      expect(args).toEqual(["presubmit-local"]);
      expect(opts.cwd).toBe("/repo");
      return fakeChild({
        exitCode: 0,
        stdout: "ok line\n",
        stderr: "note\n",
      });
    };

    const result = await runChecks({
      cwd: "/repo",
      runner: "just",
      runnerArgs: ["presubmit-local"],
      spawnFn,
    });

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toContain("ok line");
    expect(result.stderr).toContain("note");
    expect(result.capturedLog).toContain("ok line");
  });

  it("returns nonzero exit codes", async () => {
    const result = await runChecks({
      cwd: "/repo",
      runner: "just",
      runnerArgs: ["presubmit-local"],
      spawnFn: () => fakeChild({ exitCode: 7, stderr: "boom\n" }),
    });
    expect(result.exitCode).toBe(7);
    expect(result.cancelled).toBe(false);
  });

  it("truncates captured logs to maxLogLines", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n") + "\n";
    const result = await runChecks({
      cwd: "/repo",
      runner: "just",
      runnerArgs: ["x"],
      maxLogLines: 5,
      spawnFn: () => fakeChild({ exitCode: 1, stdout: lines }),
    });
    const captured = result.capturedLog.split("\n");
    expect(captured.length).toBeLessThanOrEqual(5);
    expect(result.capturedLog).toContain("line-19");
    expect(result.capturedLog).not.toContain("line-0");
  });

  it("forwards SIGINT to the child and marks cancelled", async () => {
    const signalProcess = new EventEmitter();
    let childRef: ChildProcess | undefined;

    const spawnFn: SpawnFn = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      child.stdout = stdout;
      child.stderr = stderr;
      child.pid = 99;
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        queueMicrotask(() => child.emit("close", 1, signal ?? "SIGINT"));
        return true;
      }) as unknown as ChildProcess["kill"];
      childRef = child;
      return child;
    };

    const pending = runChecks({
      cwd: "/repo",
      runner: "just",
      runnerArgs: ["x"],
      spawnFn,
      signalProcess,
    });

    // Allow spawn to attach handlers, then signal.
    await Promise.resolve();
    signalProcess.emit("SIGINT");
    const result = await pending;

    expect(childRef?.kill).toHaveBeenCalledWith("SIGINT");
    expect(result.cancelled).toBe(true);
  });

  it("propagates spawn errors", async () => {
    const spawnFn: SpawnFn = () =>
      fakeChild({ failSpawn: new Error("ENOENT just") });
    await expect(
      runChecks({
        cwd: "/repo",
        runner: "just",
        runnerArgs: ["x"],
        spawnFn,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

it("bounds all captures for long output while streaming it completely", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const huge = "😀".repeat(40000) + "tail";
    const result = await runChecks({ cwd: "/repo", runner: "x", runnerArgs: [], spawnFn: () => fakeChild({ stdout: huge, stderr: huge, exitCode: 9 }) });
    for (const text of [result.stdout, result.stderr, result.capturedLog]) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
      expect(text).not.toContain("\uFFFD");
      expect(text).toContain("tail");
    }
    expect(Buffer.concat(out.mock.calls.map(([c]) => Buffer.from(c))).toString()).toBe(huge);
    expect(Buffer.concat(err.mock.calls.map(([c]) => Buffer.from(c))).toString()).toBe(huge);
    expect(result.exitCode).toBe(9);
  } finally { out.mockRestore(); err.mockRestore(); }
});

it("decodes split UTF-8 separately for interleaved streams", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await runChecks({ cwd: "/repo", runner: "x", runnerArgs: [], spawnFn: () => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => {
        const bytes = Buffer.from("😀");
        (child.stdout as PassThrough).write(bytes.subarray(0, 2));
        (child.stderr as PassThrough).write("note\n");
        (child.stdout as PassThrough).write(bytes.subarray(2));
        child.emit("close", 0, null);
      });
      return child;
    } });
    expect(result.stdout).toBe("😀");
    expect(result.stderr).toBe("note\n");
    expect(result.capturedLog).toBe("note\n😀");
  } finally { out.mockRestore(); err.mockRestore(); }
});
