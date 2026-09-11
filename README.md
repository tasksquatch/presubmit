# @tasksquatch/presubmit

Run a repository's local checks and publish a GitHub Check Run named **Local Presubmit** for checked-out HEAD. Each consuming repository supplies its own check command; the default is `just presubmit-local`.

## Installation

Requires Node.js 22 or later. Install the public Git release over HTTPS:

```bash
npm install --save-dev git+https://github.com/tasksquatch/presubmit.git#v0.1.2
```

Commit the generated lockfile and use `npm ci` in automation. For stricter pinning, replace the tag with its reviewed full commit SHA. Use `npx --no-install presubmit` so a missing dependency cannot cause an unexpected download. Git installation runs the package's build script; install only reviewed versions.

Public HTTPS Git downloads do not require GitHub credentials. Publishing Check Runs still requires authentication. This package is distributed through Git releases; GitHub Packages npm downloads require authentication even for public packages.

On Ubuntu, install the credential-store runtime library:

```bash
sudo apt-get update
sudo apt-get install -y libsecret-1-0
```

Interactive authentication also needs a working Secret Service session on Linux, Keychain on macOS, or Credential Manager on Windows. Building keytar from source may require platform development tools and libsecret development headers on Linux. CLI help/version and `run --no-publish` do not need credential-store access.

### Running in CI

Presubmit's OS credential-store integration is intended for local developer computers, where an interactive user can log in and access a keychain. CI runners generally do not have that session. Installing `libsecret-1-0` alone does not configure authentication, and the CLI does not automatically use GitHub Actions' `GITHUB_TOKEN`.

To run checks in CI without publishing a separate Check Run, use `--no-publish`. For example, after checking out the repository and setting up Node.js 22 or later:

```yaml
- name: Install credential-store runtime dependency
  run: |
    sudo apt-get update
    sudo apt-get install -y libsecret-1-0
- run: npm ci
- run: npx --no-install presubmit run --no-publish
```

The library installation is a conservative Ubuntu setup step; `--no-publish` does not access the credential store. If keytar must build from source, also install `libsecret-1-dev` and the platform build tools. Install the configured runner (such as `just`) and its check dependencies separately. The normal clean-worktree and pushed-commit gates still apply: run from the repository root, ensure the checkout is clean, and fetch the remote-tracking refs needed to verify HEAD. Pull-request merge checkouts may need additional Git setup to satisfy those gates.

For CI publication using the current authentication flow, you must additionally provision a working Secret Service/keychain session and valid GitHub App user credentials through the supported login flow. A fresh hosted runner is not ready for this by default. Prefer `--no-publish` and let the CI job report its own result; unattended token-based publication would require a separate authentication integration.

## Commands

| Command | Behavior |
|---------|----------|
| `presubmit run` | Run local checks and publish a result for checked-out HEAD |
| `presubmit login` | Authenticate using GitHub App OAuth device flow |
| `presubmit logout` | Delete credentials from the local OS store |
| `presubmit auth status` | Show identity, expiry, and repository access diagnostics |
| `presubmit doctor` | Diagnose Git, authentication, App access, runner, and configuration |

Install the **Tasksquatch Presubmit** GitHub App on the repositories where you intend to publish results, with Checks write permission. Obtain the installation link from the App owner. The CLI embeds a public OAuth client ID; it contains no App private key or client secret. `PRESUBMIT_GITHUB_CLIENT_ID` can override the client ID for testing. Client secret and private-key environment variables are unsupported.

**Logout does not revoke authorization at GitHub.** To revoke it, open GitHub **Settings → Applications → Authorized GitHub Apps**, select the App, and revoke authorization. See [reviewing authorized integrations](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps).

### Run options

| Option | Behavior |
|--------|----------|
| `--sha <revision>` | Assert that the revision resolves to checked-out HEAD; a different commit is rejected |
| `--no-publish` | Run checks without authentication or GitHub publication; integrity gates still apply |
| `--skip-integrity` | For testing: bypass clean-worktree and pushed-commit gates; SHA equality still applies |

By default the worktree must be clean and HEAD must be present in local remote-tracking refs. Keep those refs current; these checks are local safeguards, not independent proof of remote state. To test another commit, check it out first.

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
```

`maxLogLines` remains a deprecated compatibility setting for local capture only (default 100; integer 0–65536). It never enables uploads. Each retained stdout, stderr, and combined output tail is capped at 64 KiB, while full output streams to the terminal.

GitHub receives only the check name, commit, developer identity, duration, CLI version, and conclusion. Runner logs and runner-start error details are never attached to Check Runs. Terminal output may still contain sensitive information; treat externally collected terminal/CI logs accordingly. Do not put secrets in check names or other published metadata.

## Trust and security

Local Presubmit records developer attestation. The machine, configuration, executable, and token are under developer control. A successful check is not independent verification; use trusted hosted validation for security-sensitive decisions and releases.

The configured command executes with your local user privileges and inherited environment. It is not sandboxed. Run untrusted contributions only in an isolated environment without sensitive credentials or access to private systems. Review dependency and runner changes before executing them.

Tokens are stored through the OS credential store. Keep the GitHub App limited to Checks write, metadata read, and selected repositories. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Exit codes

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

The package tarball contains compiled runtime code and documentation, not the test suite. Publish new immutable version tags; do not move existing release tags.

## License

[MIT](LICENSE), Copyright (c) 2026 Tasksquatch.
