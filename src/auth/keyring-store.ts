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

function isNoEntryError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("no entry") ||
    message.includes("noent") ||
    message.includes("not found") ||
    message.includes("password not found")
  );
}

/**
 * OS credential store backed by @napi-rs/keyring (macOS Keychain, Windows
 * Credential Manager, Linux Secret Service).
 */
export function createKeyringStore(
  service = KEYRING_SERVICE,
  account = KEYRING_ACCOUNT,
): CredentialStore {
  return {
    async load(): Promise<StoredCredentials | null> {
      const { AsyncEntry } = await loadKeyring();
      const entry = new AsyncEntry(service, account);
      try {
        const raw = await entry.getPassword();
        if (!raw) {
          return null;
        }
        return JSON.parse(raw) as StoredCredentials;
      } catch (err) {
        if (isNoEntryError(err)) {
          return null;
        }
        throw err;
      }
    },

    async save(credentials: StoredCredentials): Promise<void> {
      const { AsyncEntry } = await loadKeyring();
      const entry = new AsyncEntry(service, account);
      await entry.setPassword(JSON.stringify(credentials));
    },

    async clear(): Promise<void> {
      const { AsyncEntry } = await loadKeyring();
      const entry = new AsyncEntry(service, account);
      try {
        await entry.deletePassword();
      } catch (err) {
        if (isNoEntryError(err)) {
          return;
        }
        throw err;
      }
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
