import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  SUPPORTED_SCHEMA_VERSION,
} from "./load.js";

describe("loadConfig", () => {
  it("returns defaults when .presubmit.yaml is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    const { config, path: configPath } = await loadConfig(dir);
    expect(configPath).toBeNull();
    expect(config.version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(config.checkName).toBe(DEFAULT_CONFIG.checkName);
    expect(config.runner).toBe("just");
    expect(config.runnerArgs).toEqual(["presubmit-local"]);
    expect(config.maxLogLines).toBe(100);
    expect(config.publishFailureOutput).toBe(true);
  });

  it("parses a YAML config file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `
version: 1
checkName: Custom Check
runner: just
runnerArgs:
  - presubmit-local
requireCleanWorktree: false
maxLogLines: 50
`,
      "utf8",
    );

    const { config, path: configPath } = await loadConfig(dir);
    expect(configPath).toBe(path.join(dir, ".presubmit.yaml"));
    expect(config.version).toBe(1);
    expect(config.checkName).toBe("Custom Check");
    expect(config.requireCleanWorktree).toBe(false);
    expect(config.maxLogLines).toBe(50);
    expect(config.requirePushedCommit).toBe(true);
  });

  it("parses publishFailureOutput false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `publishFailureOutput: false\n`,
      "utf8",
    );
    const { config } = await loadConfig(dir);
    expect(config.publishFailureOutput).toBe(false);
  });

  it("parses publish_failure_output snake_case", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `publish_failure_output: false\n`,
      "utf8",
    );
    const { config } = await loadConfig(dir);
    expect(config.publishFailureOutput).toBe(false);
  });

  it("rejects non-boolean publishFailureOutput", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `publishFailureOutput: "yes"\n`,
      "utf8",
    );
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it("defaults version to 1 when omitted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `checkName: No Version\n`,
      "utf8",
    );
    const { config } = await loadConfig(dir);
    expect(config.version).toBe(1);
  });

  it("accepts schemaVersion / schema_version aliases", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `schema_version: 1\ncheck_name: Snake\n`,
      "utf8",
    );
    const { config } = await loadConfig(dir);
    expect(config.version).toBe(1);
    expect(config.checkName).toBe("Snake");
  });

  it("rejects unsupported schema versions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `version: 99\n`,
      "utf8",
    );
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(dir)).rejects.toThrow(/Unsupported.*99/);
  });

  it("accepts snake_case keys", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, ".presubmit.yaml"),
      `
check_name: Snake Check
runner_args: [verify]
max_log_lines: 10
`,
      "utf8",
    );

    const { config } = await loadConfig(dir);
    expect(config.checkName).toBe("Snake Check");
    expect(config.runnerArgs).toEqual(["verify"]);
    expect(config.maxLogLines).toBe(10);
  });
});

it.each([-1, 1.5, 65537, '"100"'])("rejects invalid local capture limit %s", async (limit) => {
  const dir = await mkdtemp(path.join(tmpdir(), "presubmit-cfg-"));
  await writeFile(path.join(dir, ".presubmit.yaml"), `maxLogLines: ${limit}\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
});
