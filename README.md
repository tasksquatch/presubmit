# @tasksquatch/presubmit

Run a repository's local checks and publish a GitHub Check Run named **Local Presubmit** for checked-out HEAD. Each consuming repository supplies its own check command; the default is `just presubmit-local`.

## Installation

Requires Node.js 24 or later. Install from the npm registry:

```bash
npm install --save-dev @tasksquatch/presubmit@0.1.3
```

Commit the generated lockfile and use `npm ci` in automation. Use `npx --no-install presubmit` so a missing dependency cannot cause an unexpected download. Install only reviewed versions.

For stricter pinning when you cannot use the registry, install a reviewed commit over HTTPS:

```bash
npm install --save-dev git+https://github.com/tasksquatch/presubmit.git#<full-commit-sha>
```

Git installation runs the package's build script. Public HTTPS Git downloads do not require GitHub credentials. Publishing Check Runs still requires authentication.

On Ubuntu, install the credential-store runtime library:

```bash
sudo apt-get update
sudo apt-get install -y libsecret-1-0
```

Interactive authentication also needs a working Secret Service session on Linux, Keychain on macOS, or Credential Manager on Windows. On Linux, a Secret Service provider typically needs the `libsecret-1-0` runtime library. CLI help/version and `run --no-publish` do not need credential-store access.

### Running in CI

Presubmit's OS credential-store integration is intended for local developer computers, where an interactive user can log in and access a keychain. CI runners generally do not have that session. Installing `libsecret-1-0` alone does not configure authentication, and the CLI does not automatically use GitHub Actions' `GITHUB_TOKEN`.

To run checks in CI without publishing a separate Check Run, use `--no-publish`. For example, after checking out the repository and setting up Node.js 24 or later:

```yaml
- run: npm ci
- run: npx --no-install presubmit run --no-publish
```

`--no-publish` does not access the credential store, so CI does not need `libsecret` or a Secret Service session for that path. Install the configured runner (such as `just`) and its check dependencies separately. Without `--integrity pre-push`, the default `developer` profile still applies: run from the repository root, ensure the checkout is clean, and fetch the remote-tracking refs needed to verify HEAD. Pull-request merge checkouts may need additional Git setup to satisfy those gates. To fail-fast before push, use `--no-publish --integrity pre-push` (see [Automation contract](#automation-contract)).

To publish a Check Run from automation without device-flow or a keyring, use GitHub App **installation** authentication:

```bash
export PRESUBMIT_GITHUB_APP_ID="<app-id>"
export PRESUBMIT_GITHUB_INSTALLATION_ID="<installation-id>"
export PRESUBMIT_GITHUB_PRIVATE_KEY_PATH=/path/to/presubmit-app.pem
# Or: PRESUBMIT_GITHUB_PRIVATE_KEY with the PEM contents (overrides the path).
npx --no-install presubmit run --auth installation --integrity post-push
```

`--auth installation` is explicit. Default `presubmit run` still uses device-flow credentials from the OS keyring; leftover installation env vars do not change that path. Diagnose installation credentials with `presubmit doctor --auth installation` or `presubmit auth status --auth installation`. `presubmit doctor` / `auth status` without `--auth` use installation diagnostics automatically when the App ID, installation ID, and private key (or key path) are all set.

## Commands

| Command | Behavior |
|---------|----------|
| `presubmit run` | Run local checks and publish a result for checked-out HEAD |
| `presubmit login` | Authenticate using GitHub App OAuth device flow |
| `presubmit logout` | Delete credentials from the local OS store |
| `presubmit auth status` | Show identity, expiry, and repository access diagnostics |
| `presubmit doctor` | Diagnose Git, authentication, App access, runner, and configuration |

Install the **Tasksquatch Presubmit** GitHub App on the repositories where you intend to publish results, with Checks write permission. Obtain the installation link from the App owner. Human `presubmit login` / default `presubmit run` use the embedded public OAuth client ID and the OS keyring; that path does not read an App private key. `PRESUBMIT_GITHUB_CLIENT_ID` can override the client ID for testing. `PRESUBMIT_GITHUB_CLIENT_SECRET` is unsupported and ignored. Installation auth (`--auth installation`) uses `PRESUBMIT_GITHUB_APP_ID`, `PRESUBMIT_GITHUB_INSTALLATION_ID`, and `PRESUBMIT_GITHUB_PRIVATE_KEY` or `PRESUBMIT_GITHUB_PRIVATE_KEY_PATH`. The configured check recipe never inherits those variables or the installation access token.

**Logout does not revoke authorization at GitHub.** To revoke it, open GitHub **Settings → Applications → Authorized GitHub Apps**, select the App, and revoke authorization. See [reviewing authorized integrations](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps).

### Run options

| Option | Behavior |
|--------|----------|
| `--sha <revision>` | Assert that the revision resolves to checked-out HEAD; a different commit is rejected |
| `--no-publish` | Run checks without authentication or GitHub publication; integrity gates still apply |
| `--no-failure-output` | Do not attach truncated runner output to failing Check Runs. YAML `publishFailureOutput: false` is the repo-wide equivalent. Default is to attach a size-capped tail |
| `--integrity <profile>` | `developer` (default): honor yaml clean + pushed gates. `pre-push`: fail-fast without requiring remote. `post-push`: fetch remote-tracking refs and require one to contain HEAD. See [Automation contract](#automation-contract) |
| `--auth <mode>` | `device` (default): OS keyring session. `installation`: GitHub App installation token from env |
| `--skip-integrity` | For testing: bypass clean-worktree and pushed-commit gates; SHA equality still applies. Not an automation profile |

`presubmit doctor` and `presubmit auth status` also accept `--auth`. Their default is `auto` (installation diagnostics when installation env is complete or partial; otherwise device-flow). Pass `--auth device` or `--auth installation` to force one path.

By default (`--integrity developer`) the worktree must be clean and HEAD must be present in local remote-tracking refs. Keep those refs current; these checks are local safeguards, not independent proof of remote state. To test another commit, check it out first.

## Automation contract

Unattended callers should pin to this CLI surface. Human `presubmit run` invocation, auth, and integrity profiles are unchanged; failing Check Runs now attach a truncated runner tail by default (see below).

| Mode | Invocation | Auth | Integrity |
|------|------------|------|-----------|
| Human / default | `presubmit run` | device (keyring) | `developer`: honor yaml `requireCleanWorktree` and `requirePushedCommit` |
| Automation fail-fast | `presubmit run --no-publish --integrity pre-push` | none | yaml clean-worktree; do **not** require the commit on the remote |
| Automation attest | `presubmit run --auth installation --integrity post-push [--sha <head>]` | installation env (below) | HEAD equals intended SHA; fetch remote-tracking refs and require one of them to contain HEAD |

`--skip-integrity` is a testing escape hatch, not an automation profile. SHA equality (`--sha` must resolve to checked-out HEAD) always applies.

Auth rules:

- `--no-publish` never authenticates and does not read the credential store or installation env.
- Failing Check Runs include a size-capped, redacted, ANSI-stripped runner tail in `output.text` unless `--no-failure-output` or yaml `publishFailureOutput: false`. Success and cancelled Check Runs omit that tail. `--no-publish` still skips the Check Run entirely.
- Publishing with `--auth installation` requires `PRESUBMIT_GITHUB_APP_ID`, `PRESUBMIT_GITHUB_INSTALLATION_ID`, and `PRESUBMIT_GITHUB_PRIVATE_KEY` or `PRESUBMIT_GITHUB_PRIVATE_KEY_PATH`. `PRESUBMIT_GITHUB_PRIVATE_KEY` overrides the path when both are set.
- Default `presubmit run` uses device-flow credentials from the OS keyring. Leftover installation env vars do not change that path.
- `--integrity pre-push` cannot publish a Check Run (GitHub needs the SHA on the remote). Use `--no-publish`, or `--integrity post-push` after push. That combination exits **4**.

Both auth modes publish the configured check name (default `Local Presubmit`). GitHub branch protection keys on that name, so a successful laptop run and a successful installation-auth run satisfy the same required check. Check Run summaries include `- **Attestation:** \`local-developer\`` or `- **Attestation:** \`orchestrator\`` as disclosure of the auth path, not as a second required-check identity. The developer `@login` line is omitted in orchestrator mode.

`--integrity post-push` runs `git fetch --prune --no-tags` on the repo remote, then requires some `refs/remotes/<remote>/*` ref to contain HEAD (including detached HEAD). That is a refreshed local remote-tracking check, not a GitHub API membership query; Check Run creation still fails if GitHub does not have the SHA.

Exit codes are part of this contract:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Checks failed |
| 2 | Configuration or runner-start error |
| 3 | Authentication error |
| 4 | Git or repository-state error |
| 5 | GitHub publication or API error |
| 6 | Interrupted or cancelled |

## Configuration

Run from the repository root. Optional `.presubmit.yaml` defaults:

```yaml
version: 1
checkName: Local Presubmit
runner: just
runnerArgs:
  - presubmit-local
requireCleanWorktree: true
requirePushedCommit: true
publishFailureOutput: true
```

`maxLogLines` remains a deprecated compatibility setting for local capture only (default 100; integer 0–65536). It never enables uploads by itself. Each retained stdout, stderr, and combined output tail is capped at 64 KiB, while full output streams to the terminal. On a **failing** published Check Run, that local `capturedLog` tail is also sent as Check Run `output.text` after ANSI stripping, credential-shaped redaction, fencing, and a 65535-character cap. Set `publishFailureOutput: false` (or pass `--no-failure-output`) to keep failure Check Runs metadata-only. Success Check Runs stay metadata-only.

GitHub always receives the check name, commit, attestation mode (`local-developer` or `orchestrator`), optional developer identity, duration, CLI version, and conclusion. Failure, cancellation, and runner-start errors also include a short result line. Failing Check Runs also receive truncated runner output (or a runner-start error) in `output.text` unless opted out. Redaction is best-effort and format-based (tokens, PEMs, JWTs, assignment-style secrets). Emails, IP addresses, and similar PII are left intact so logs stay actionable. Recipe output may still contain secrets the scanner does not recognize. Terminal output may still contain sensitive information; treat externally collected terminal/CI logs accordingly. Do not put secrets in check names or other published metadata.

## Trust and security

Local Presubmit records attestation, not independent GitHub-hosted verification. Device-flow and installation-auth publishes use the **same** configured check name (default `Local Presubmit`); GitHub required checks match that name, not the summary attestation line. The summary labels the auth path `local-developer` or `orchestrator`. Do not treat laptop attestation as a security gate for releases. The machine, configuration, executable, and token remain under the runner's control.

The configured command executes with your local user privileges and inherited environment, except that Presubmit strips App private-key, App ID, installation ID, and client-secret variables before spawning the recipe. The installation access token is held in memory only and is never exported to the child. The recipe is not otherwise sandboxed. Run untrusted contributions only in an isolated environment without sensitive credentials or access to private systems. Review dependency and runner changes before executing them.

Failing Check Run `output.text` is stored on GitHub (world-readable on public repositories). Presubmit redacts credential-shaped strings before publish; this is not a guarantee that the tail is free of secrets.

The OAuth client ID embedded in the CLI is public by design (not a secret). Only run `presubmit login` from a reviewed install of `@tasksquatch/presubmit`. On GitHub’s consent screen, confirm the App is **Tasksquatch Presubmit**. Unofficial forks or lookalike CLIs can reuse the same public client ID to solicit authorization for this App.

Tokens are stored through the OS credential store. `presubmit logout` clears local credentials only; revoke GitHub authorization separately as described under [Commands](#commands). Keep the GitHub App limited to Checks write, metadata read, and selected repositories. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Publishing / provenance

Package releases are published to the npmjs registry (`@tasksquatch/presubmit`) from GitHub Actions using [trusted publishing](https://docs.npmjs.com/trusted-publishers/) with automatic provenance. Maintainers publish by pushing an immutable version tag (for example `v0.1.3`) after configuring the npm Trusted Publisher for workflow `.github/workflows/publish.yml`. Do not move existing release tags. Prefer reviewing provenance attestations for installs once a registry release exists.

## Exit codes

The codes below match the [Automation contract](#automation-contract) table.

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Checks failed |
| 2 | Configuration or runner-start error |
| 3 | Authentication error |
| 4 | Git or repository-state error |
| 5 | GitHub publication or API error |
| 6 | Interrupted or cancelled |

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

The package tarball contains compiled runtime code and documentation, not the test suite.

## License

[MIT](LICENSE), Copyright (c) 2026 Tasksquatch.
