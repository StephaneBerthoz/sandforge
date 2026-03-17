import { extractErrorMessage } from '../common/extractErrorMessage.js';
/** Secret storage adapter interface — wraps VSCode SecretStorage */
export interface SecretStorageAdapter {
  /** Retrieve a secret by key */
  get(key: string): Promise<string | undefined>;
  /** Store a secret value */
  store(key: string, value: string): Promise<void>;
  /** Delete a secret by key */
  delete(key: string): Promise<void>;
}

/**
 * Manages encrypted secrets using VSCode's SecretStorage API.
 * Stores: OAuth tokens, API keys, passwords.
 */
export class SecretVault {
  private storage: SecretStorageAdapter;
  private prefix: string;
  private logWarning?: (msg: string) => void;

  constructor(storage: SecretStorageAdapter, prefix: string = 'sandforge', logWarning?: (msg: string) => void) {
    this.storage = storage;
    this.prefix = prefix;
    this.logWarning = logWarning;
  }

  /** Store a secret string */
  async storeSecret(key: string, value: string): Promise<void> {
    await this.storage.store(this.prefixKey(key), value);
  }

  /** Retrieve a secret string */
  async getSecret(key: string): Promise<string | undefined> {
    return this.storage.get(this.prefixKey(key));
  }

  /** Delete a secret */
  async deleteSecret(key: string): Promise<void> {
    await this.storage.delete(this.prefixKey(key));
  }

  /** Store a JSON-serializable object as a secret */
  async storeObject<T>(key: string, value: T): Promise<void> {
    await this.storeSecret(key, JSON.stringify(value));
  }

  /** Retrieve a JSON object from secrets. Logs a warning if the stored value is corrupted. */
  async getObject<T>(key: string): Promise<T | undefined> {
    const raw = await this.getSecret(key);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      this.logWarning?.(`[SecretVault] Failed to parse JSON for key "${key}": ${msg}`);
      return undefined;
    }
  }

  /** Check if a secret exists */
  async hasSecret(key: string): Promise<boolean> {
    const value = await this.storage.get(this.prefixKey(key));
    return value !== undefined;
  }

  /** Build the full prefixed key for storage */
  private prefixKey(key: string): string {
    return `${this.prefix}.${key}`;
  }
}
