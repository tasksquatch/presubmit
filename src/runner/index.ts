/**
 * Runner for spawning the opaque local check command
 * (default: `just presubmit-local`).
 */

import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface RunChecksOptions {
  cwd: string;
  runner: string;
  runnerArgs: string[];
  /** Deprecated: max lines retained locally, never uploaded. */
  maxLogLines?: number;
  /** Injectable spawn for tests. */
  spawnFn?: SpawnFn;
  /** Process to attach signal handlers to (defaults to `process`). */
  signalProcess?: NodeJS.EventEmitter;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunChecksResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Combined local output tail (at most 64 KiB), never uploaded. */
  capturedLog: string;
  cancelled: boolean;
}

export const MAX_CAPTURE_BYTES = 64 * 1024;

/** Keep a UTF-8 tail without retaining large input buffers or partial code points. */
class OutputTail {
  private value = "";

  push(text: string): void {
    const bytes = Buffer.from(text);
    const previous = Buffer.from(this.value);
    const tail = bytes.length >= MAX_CAPTURE_BYTES
      ? bytes.subarray(bytes.length - MAX_CAPTURE_BYTES)
      : Buffer.concat([previous.subarray(Math.max(0, previous.length - (MAX_CAPTURE_BYTES - bytes.length))), bytes]);
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    this.value = tail.subarray(start).toString("utf8");
  }

  text(): string { return this.value; }
}

/**
 * Spawn the configured runner, stream output live, capture bounded logs,
 * and forward SIGINT/SIGTERM to the child.
 */
export async function runChecks(
  options: RunChecksOptions,
): Promise<RunChecksResult> {
  const maxLogLines = options.maxLogLines ?? 100;
  const spawnFn = options.spawnFn ?? spawn;
  const signalTarget = options.signalProcess ?? process;

  const child = spawnFn(options.runner, options.runnerArgs, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutTail = new OutputTail();
  const stderrTail = new OutputTail();
  const combinedTail = new OutputTail();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let cancelled = false;

  const onStdout = (chunk: Buffer): void => {
    const text = stdoutDecoder.write(chunk);
    stdoutTail.push(text);
    combinedTail.push(text);
    process.stdout.write(chunk);
  };
  const onStderr = (chunk: Buffer): void => {
    const text = stderrDecoder.write(chunk);
    stderrTail.push(text);
    combinedTail.push(text);
    process.stderr.write(chunk);
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  const forwardSignal = (signal: NodeJS.Signals): void => {
    cancelled = true;
    if (child.pid !== undefined) {
      try {
        child.kill(signal);
      } catch {
        // Child may have already exited.
      }
    }
  };

  const onSigInt = (): void => forwardSignal("SIGINT");
  const onSigTerm = (): void => forwardSignal("SIGTERM");

  signalTarget.on("SIGINT", onSigInt);
  signalTarget.on("SIGTERM", onSigTerm);

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (code, signal) => {
        if (signal) {
          cancelled = true;
          resolve(code ?? 1);
          return;
        }
        resolve(code ?? 0);
      });
    });

    const outEnd = stdoutDecoder.end();
    const errEnd = stderrDecoder.end();
    stdoutTail.push(outEnd);
    stderrTail.push(errEnd);
    combinedTail.push(outEnd + errEnd);
    const lines = combinedTail.text().replace(/\r?\n$/, "").split(/\r?\n/);
    return {
      exitCode,
      stdout: stdoutTail.text(),
      stderr: stderrTail.text(),
      capturedLog: maxLogLines > 0 ? lines.slice(-maxLogLines).join("\n") : "",
      cancelled,
    };
  } finally {
    signalTarget.off("SIGINT", onSigInt);
    signalTarget.off("SIGTERM", onSigTerm);
  }
}
