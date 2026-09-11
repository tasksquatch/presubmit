import type { CredentialStore, StoredCredentials } from "./store.js";

/**
 * In-memory credential store for unit tests.
 */
export function createMemoryStore(
  initial: StoredCredentials | null = null,
): CredentialStore {
  let current = initial;

  return {
    async load(): Promise<StoredCredentials | null> {
      return current;
    },

    async save(credentials: StoredCredentials): Promise<void> {
      current = { ...credentials };
    },

    async clear(): Promise<void> {
      current = null;
    },
  };
}
