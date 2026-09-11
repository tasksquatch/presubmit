import type { CredentialStore, StoredCredentials } from "./store.js";
import { KEYRING_ACCOUNT, KEYRING_SERVICE } from "./store.js";

const UNAVAILABLE_MESSAGE =
  "OS credential store unavailable. On Linux install libsecret-1-0 and enable Secret Service; otherwise check Keychain / Credential Manager.";

type KeyringModule = typeof import("@napi-rs/keyring");

async function loadKeyring(): Promise<KeyringModule> {
  try {
    return await import("@napi-rs/keyring");
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
}

/**
 * OS credential store backed by @napi-rs/keyring (macOS Keychain, Windows
 * Credential Manager, Linux Secret Service).
 *
 * Requires @napi-rs/keyring >= 2.0.0 so NoEntry is distinct from locked,
 * inaccessible, or ambiguous store failures (1.x mapped all errors to empty).
 */
export function createKeyringStore(
  service = KEYRING_SERVICE,
  account = KEYRING_ACCOUNT,
): CredentialStore {
  return {
    async load(): Promise<StoredCredentials | null> {
      const { AsyncEntry } = await loadKeyring();
      const entry = new AsyncEntry(service, account);
      // 2.x: undefined means NoEntry only; locked/inaccessible/ambiguous reject.
      const raw = await entry.getPassword();
      if (raw == null || raw === "") {
        return null;
      }
      return JSON.parse(raw) as StoredCredentials;
    },

    async save(credentials: StoredCredentials): Promise<void> {
      const { AsyncEntry } = await loadKeyring();
      const entry = new AsyncEntry(service, account);
      await entry.setPassword(JSON.stringify(credentials));
    },

    async clear(): Promise<void> {
      const { AsyncEntry } = await loadKeyring();
      const entry = new AsyncEntry(service, account);
      // 2.x: false means already absent; true means deleted; failures reject.
      await entry.deleteCredential();
    },
  };
}

/** Probe whether @napi-rs/keyring can be loaded (native addon available). */
export async function isKeyringAvailable(): Promise<boolean> {
  try {
    const keyring = await loadKeyring();
    return typeof keyring.AsyncEntry === "function";
  } catch {
    return false;
  }
}
