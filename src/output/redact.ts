import { compilePolicy } from "flare-redact";

/**
 * Credential-shaped detectors only. PII (email, cards, IBAN) and entropy
 * guessing stay off so Check Run failure tails remain actionable.
 */
const CREDENTIAL_DETECTORS: readonly string[] = [
  "private_key",
  "aws_access_key",
  "aws_secret_key",
  "github_token",
  "gitlab_token",
  "slack_token",
  "stripe_key",
  "anthropic_key",
  "openai_key",
  "google_api_key",
  "sendgrid_key",
  "twilio_key",
  "npm_token",
  "jwt",
  "bearer_token",
  "basic_auth",
  "url_credentials",
  "generic_assignment",
  "digitalocean_token",
  "sentry_dsn",
  "new_relic_key",
  "discord_bot_token",
  "telegram_bot_token",
  "shopify_token",
  "square_token",
  "azure_storage_key",
  "discord_webhook",
  "huggingface_token",
  "vault_token",
  "groq_key",
  "xai_key",
  "perplexity_key",
  "openrouter_key",
  "replicate_token",
  "databricks_token",
  "airtable_pat",
  "postman_key",
  "linear_key",
  "figma_token",
  "notion_token",
  "doppler_token",
  "supabase_key",
  "netlify_token",
  "stripe_webhook_secret",
  "gcp_service_account",
  "gcp_refresh_token",
  "mailgun_key",
];

const credentialRedactor = compilePolicy({
  only: [...CREDENTIAL_DETECTORS],
  mask: "[redacted]",
  redactKeys: false,
});

/** GitHub App installation / user-to-server prefixes often missed by vendor detectors. */
const GITHUB_TOKEN_PATTERN =
  /\b(?:ghs_|ghu_|gho_|ghr_|ghp_|github_pat_)[A-Za-z0-9_]+/g;

/**
 * Replace credential-shaped secrets in user-facing text.
 * Best-effort; emails and IPs are intentionally left intact.
 */
export function redactSecrets(text: string): string {
  return credentialRedactor.redact(text).replace(GITHUB_TOKEN_PATTERN, "[redacted]");
}

export function redactUnknown(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}
