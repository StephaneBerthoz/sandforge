import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

/** Configuration for the encryption algorithm */
export interface EncryptionConfig {
  algorithm: string;
  keyLength: number;
  ivLength: number;
  tagLength: number;
}

/** AES-256-GCM algorithm identifier */
const ALGORITHM = 'aes-256-gcm' as const;

/** Default AES-256-GCM configuration */
const DEFAULT_CONFIG: EncryptionConfig = {
  algorithm: ALGORITHM,
  keyLength: 32,
  ivLength: 12,
  tagLength: 16,
};

/** Length of the random PBKDF2 salt in bytes */
const PBKDF2_SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';

/**
 * Generate a cryptographically random salt for PBKDF2 key derivation.
 * @returns A random salt as a hex-encoded string
 */
export function generateSalt(): string {
  return randomBytes(PBKDF2_SALT_LENGTH).toString('hex');
}

/**
 * Provides AES-256-GCM encryption and decryption at rest.
 * Derives the encryption key from a master key via PBKDF2.
 * The salt must be a per-installation random value stored externally
 * (e.g. in VSCode globalState or SecretStorage).
 */
export class EncryptionManager {
  private readonly key: Buffer;
  private readonly config: EncryptionConfig;

  /**
   * @param masterKey - The master secret used for key derivation
   * @param salt - A per-installation random salt (hex string). Generate via {@link generateSalt}
   *               and persist in VSCode globalState or SecretStorage.
   */
  constructor(masterKey: string, salt: string) {
    this.config = DEFAULT_CONFIG;
    this.key = pbkdf2Sync(
      masterKey,
      salt,
      PBKDF2_ITERATIONS,
      this.config.keyLength,
      PBKDF2_DIGEST
    );
  }

  /**
   * Encrypt a plaintext string using AES-256-GCM.
   * Returns a base64 string encoding: IV (12 bytes) + auth tag (16 bytes) + ciphertext.
   */
  encrypt(data: string): string {
    const iv = randomBytes(this.config.ivLength);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const combined = Buffer.concat([iv, tag, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Decrypt a base64-encoded AES-256-GCM ciphertext.
   * Expects the format: base64(IV + auth tag + ciphertext).
   */
  decrypt(data: string): string {
    const combined = Buffer.from(data, 'base64');
    const minLength = this.config.ivLength + this.config.tagLength;

    if (combined.length < minLength) {
      throw new Error('Encrypted data is too short to contain IV and auth tag');
    }

    const iv = combined.subarray(0, this.config.ivLength);
    const tag = combined.subarray(
      this.config.ivLength,
      this.config.ivLength + this.config.tagLength
    );
    const ciphertext = combined.subarray(
      this.config.ivLength + this.config.tagLength
    );

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Check if a string looks like encrypted data produced by this manager.
   * Validates that it is valid base64 and has at least IV + tag length bytes.
   */
  isEncrypted(data: string): boolean {
    if (!data || data.length === 0) {
      return false;
    }

    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    if (!base64Regex.test(data)) {
      return false;
    }

    try {
      const decoded = Buffer.from(data, 'base64');
      const minLength = this.config.ivLength + this.config.tagLength;
      return decoded.length >= minLength;
    } catch {
      return false;
    }
  }
}
