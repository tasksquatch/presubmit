# Security policy

Please report suspected vulnerabilities using GitHub's **Security → Advisories → Report a vulnerability** on this repository when private vulnerability reporting is enabled. If it is unavailable, contact a maintainer privately to arrange a confidential reporting channel. Do not disclose credentials, private repository information, or exploit details in public issues.

Include affected versions, reproduction steps, and expected impact using synthetic data. Never send live credentials. If credentials have been exposed, revoke them at their issuer; deleting logs or local credentials does not revoke remote authorization.

Local Presubmit is developer attestation, not an independent security gate. Runner commands execute with the current user's permissions and environment. Use isolated environments for untrusted code and separate hosted validation for security-sensitive decisions.
