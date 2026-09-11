import type { CredentialStore, StoredCredentials } from "./store.js";
import { KEYTAR_ACCOUNT, KEYTAR_SERVICE } from "./store.js";
async function loadKeytar() {
  try {
    return (await import("keytar")).default;
  } catch {
    throw new Error("OS credential store unavailable. On Linux install libsecret-1-0 and enable Secret Service; otherwise check Keychain / Credential Manager and reinstall keytar.");
  }
}

/**
 * OS credential store backed by keytar (macOS Keychain, Windows Credential
 * Manager, Linux Secret Service).
 */
export function createKeytarStore(
  service = KEYTAR_SERVICE,
  account = KEYTAR_ACCOUNT,
): CredentialStore {
  return {
    async load(): Promise<StoredCredentials | null> {
      const keytar = await loadKeytar();
      const raw = await keytar.getPassword(service, account);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as StoredCredentials;
    },

    async save(credentials: StoredCredentials): Promise<void> {
      const keytar = await loadKeytar();
      await keytar.setPassword(service, account, JSON.stringify(credentials));
    },

    async clear(): Promise<void> {
      const keytar = await loadKeytar();
      await keytar.deletePassword(service, account);
    },
  };
}

/** Probe whether keytar can be loaded (native addon available). */
export async function isKeytarAvailable(): Promise<boolean> {
  try {
    const keytar = await loadKeytar();
    return typeof keytar.getPassword === "function";
  } catch {
    return false;
  }
}
