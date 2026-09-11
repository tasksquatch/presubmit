#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { authStatusCommand } from "./commands/auth-status.js";
import { doctorCommand } from "./commands/doctor.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { runCommand } from "./commands/run.js";
import type { AuthMode, AuthModeOption } from "./auth/index.js";
import { INTEGRITY_PROFILES, type IntegrityProfile } from "./git/index.js";
import { ExitCode } from "./output/index.js";
import { VERSION } from "./version.js";

function runAuthOption(): Option {
  return new Option(
    "--auth <mode>",
    "Authentication mode: device (default) or installation",
  )
    .choices(["device", "installation"])
    .default("device");
}

function diagnosticAuthOption(): Option {
  return new Option(
    "--auth <mode>",
    "Authentication mode: auto (default), device, or installation",
  )
    .choices(["auto", "device", "installation"])
    .default("auto");
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("presubmit")
    .description(
      "Local Presubmit — run repo checks and publish a GitHub Check Run for HEAD",
    )
    .version(VERSION);

  program
    .command("run")
    .description("Run local checks and publish a Local Presubmit Check Run")
    .option("--sha <sha>", "Assert commit SHA matches checked-out HEAD")
    .option("--no-publish", "Run checks without publishing a Check Run")
    .option(
      "--skip-integrity",
      "Skip clean-worktree and pushed-SHA gates (testing only)",
    )
    .addOption(
      new Option(
        "--integrity <profile>",
        "Integrity profile: developer (default), pre-push, or post-push",
      )
        .choices([...INTEGRITY_PROFILES])
        .default("developer"),
    )
    .addOption(runAuthOption())
    .action(async (opts: {
      sha?: string;
      publish?: boolean;
      skipIntegrity?: boolean;
      integrity?: IntegrityProfile;
      auth?: AuthMode;
    }) => {
      const code = await runCommand({
        sha: opts.sha,
        // Commander sets publish=false when --no-publish is passed.
        publish: opts.publish,
        skipIntegrity: opts.skipIntegrity,
        integrity: opts.integrity,
        auth: opts.auth,
      });
      process.exitCode = code;
    });

  program
    .command("login")
    .description("Authenticate via GitHub App device flow")
    .action(async () => {
      const code = await loginCommand();
      process.exitCode = code;
    });

  program
    .command("logout")
    .description("Clear local credentials (GitHub authorization is not revoked)")
    .action(async () => {
      const code = await logoutCommand();
      process.exitCode = code;
    });

  const auth = program
    .command("auth")
    .description("Authentication helpers");

  auth
    .command("status")
    .description("Show auth status for the current user and repository")
    .addOption(diagnosticAuthOption())
    .action(async (opts: { auth?: AuthModeOption }) => {
      const code = await authStatusCommand({ auth: opts.auth });
      process.exitCode = code;
    });

  program
    .command("doctor")
    .description("Diagnose Local Presubmit environment and configuration")
    .addOption(diagnosticAuthOption())
    .action(async (opts: { auth?: AuthModeOption }) => {
      const code = await doctorCommand({ auth: opts.auth });
      process.exitCode = code;
    });

  return program;
}

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return (
      realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    const base = path.basename(entry);
    return base === "presubmit" || base === "cli.js" || base === "cli.ts";
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = ExitCode.ConfigError;
  });
}
