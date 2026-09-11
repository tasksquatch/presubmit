export interface StoredCredentials {
  accessToken: string;
  /** ISO-8601 expiry of the access token, when known. */
  expiresAt?: string;
  refreshToken?: string;
  /** ISO-8601 expiry of the refresh token, when known. */
  refreshTokenExpiresAt?: string;
  githubUserId?: number;
  login?: string;
}

/**
 * Credential store abstraction. Production uses the OS keychain via
 * @napi-rs/keyring; tests use an in-memory fake.
 */
export interface CredentialStore {
  load(): Promise<StoredCredentials | null>;
  save(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

export const KEYRING_SERVICE = "tasksquatch-presubmit";
export const KEYRING_ACCOUNT = "github";
