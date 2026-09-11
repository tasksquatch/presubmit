import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const DEFAULT_CONFIG_FILENAME = ".presubmit.yaml";

/** Supported `.presubmit.yaml` schema version. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface PresubmitConfig {
  /** Schema version (currently only `1`). */
  version: number;
  /** GitHub Check Run name. */
  checkName: string;
  /** Executable used to run local checks (e.g. `just`). */
  runner: string;
  /** Arguments passed to the runner (e.g. `presubmit-local`). */
  runnerArgs: string[];
  /** Require a clean git worktree before publishing. */
  requireCleanWorktree: boolean;
  /** Require HEAD to be pushed to the remote before publishing. */
  requirePushedCommit: boolean;
  /** Deprecated: max lines retained locally; never uploaded. */
  maxLogLines: number;
}

export const DEFAULT_CONFIG: PresubmitConfig = {
  version: SUPPORTED_SCHEMA_VERSION,
  checkName: "Local Presubmit",
  runner: "just",
  runnerArgs: ["presubmit-local"],
  requireCleanWorktree: true,
  requirePushedCommit: true,
  maxLogLines: 100,
};

interface RawPresubmitConfig {
  version?: number;
  schemaVersion?: number;
  schema_version?: number;
  checkName?: string;
  check_name?: string;
  runner?: string;
  runnerArgs?: string[];
  runner_args?: string[];
  requireCleanWorktree?: boolean;
  require_clean_worktree?: boolean;
  requirePushedCommit?: boolean;
  require_pushed_commit?: boolean;
  maxLogLines?: number;
  max_log_lines?: number;
}

function resolveVersion(raw: RawPresubmitConfig): number {
  const value = raw.version ?? raw.schemaVersion ?? raw.schema_version;
  if (value === undefined) {
    return SUPPORTED_SCHEMA_VERSION;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `Invalid .presubmit.yaml schema version ${String(value)}; expected integer >= 1.`,
    );
  }
  if (value !== SUPPORTED_SCHEMA_VERSION) {
    throw new ConfigError(
      `Unsupported .presubmit.yaml schema version ${value}; supported version is ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  return value;
}

function normalize(raw: RawPresubmitConfig): PresubmitConfig {
  const maxLogLines = raw.maxLogLines ?? raw.max_log_lines ?? DEFAULT_CONFIG.maxLogLines;
  if (!Number.isInteger(maxLogLines) || maxLogLines < 0 || maxLogLines > 65536) {
    throw new ConfigError("maxLogLines must be an integer between 0 and 65536.");
  }
  return {
    version: resolveVersion(raw),
    checkName: raw.checkName ?? raw.check_name ?? DEFAULT_CONFIG.checkName,
    runner: raw.runner ?? DEFAULT_CONFIG.runner,
    runnerArgs:
      raw.runnerArgs ?? raw.runner_args ?? [...DEFAULT_CONFIG.runnerArgs],
    requireCleanWorktree:
      raw.requireCleanWorktree ??
      raw.require_clean_worktree ??
      DEFAULT_CONFIG.requireCleanWorktree,
    requirePushedCommit:
      raw.requirePushedCommit ??
      raw.require_pushed_commit ??
      DEFAULT_CONFIG.requirePushedCommit,
    maxLogLines,
  };
}

/**
 * Load `.presubmit.yaml` from `cwd`, or return defaults when the file is absent.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  filename: string = DEFAULT_CONFIG_FILENAME,
): Promise<{ config: PresubmitConfig; path: string | null }> {
  const configPath = path.join(cwd, filename);
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = parseYaml(text) as RawPresubmitConfig | null;
    if (parsed === null || typeof parsed !== "object") {
      return { config: { ...DEFAULT_CONFIG, runnerArgs: [...DEFAULT_CONFIG.runnerArgs] }, path: configPath };
    }
    return { config: normalize(parsed), path: configPath };
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        config: { ...DEFAULT_CONFIG, runnerArgs: [...DEFAULT_CONFIG.runnerArgs] },
        path: null,
      };
    }
    throw err;
  }
}
