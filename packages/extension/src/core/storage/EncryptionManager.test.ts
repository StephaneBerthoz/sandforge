import { describe, it, expect } from 'vitest';
import { EncryptionManager, generateSalt } from './EncryptionManager';

describe('EncryptionManager', () => {
  const masterKey = 'test-master-key-2024';
  const testSalt = generateSalt();

  describe('encrypt + decrypt roundtrip', () => {
    it('should encrypt and decrypt a simple string', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const plaintext = 'Hello, SandForge!';

      const encrypted = manager.encrypt(plaintext);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt an empty string', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const plaintext = '';

      const encrypted = manager.encrypt(plaintext);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt a JSON object string', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const obj = { token: 'abc123', orgId: '00D000000000001' };
      const plaintext = JSON.stringify(obj);

      const encrypted = manager.encrypt(plaintext);
      const decrypted = manager.decrypt(encrypted);

      expect(JSON.parse(decrypted)).toEqual(obj);
    });

    it('should encrypt and decrypt unicode content', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const plaintext = 'Données sensibles: émojis 🔥 et accents éàü';

      const encrypted = manager.encrypt(plaintext);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt a long string', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const plaintext = 'x'.repeat(10_000);

      const encrypted = manager.encrypt(plaintext);
      const decrypted = manager.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for the same plaintext (random IV)', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const plaintext = 'Same input, different output';

      const encrypted1 = manager.encrypt(plaintext);
      const encrypted2 = manager.encrypt(plaintext);

      expect(encrypted1).not.toBe(encrypted2);

      expect(manager.decrypt(encrypted1)).toBe(plaintext);
      expect(manager.decrypt(encrypted2)).toBe(plaintext);
    });
  });

  describe('decrypt — error cases', () => {
    it('should fail to decrypt with a different master key', () => {
      const manager1 = new EncryptionManager('key-one', testSalt);
      const manager2 = new EncryptionManager('key-two', testSalt);
      const plaintext = 'secret data';

      const encrypted = manager1.encrypt(plaintext);

      expect(() => manager2.decrypt(encrypted)).toThrow();
    });

    it('should throw on corrupted ciphertext', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const plaintext = 'data to corrupt';

      const encrypted = manager.encrypt(plaintext);
      const buffer = Buffer.from(encrypted, 'base64');
      buffer[buffer.length - 1] ^= 0xff;
      const corrupted = buffer.toString('base64');

      expect(() => manager.decrypt(corrupted)).toThrow();
    });

    it('should throw on data that is too short', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const tooShort = Buffer.alloc(10).toString('base64');

      expect(() => manager.decrypt(tooShort)).toThrow(
        'Encrypted data is too short to contain IV and auth tag',
      );
    });

    it('should throw on tampered auth tag', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const encrypted = manager.encrypt('sensitive');

      const buffer = Buffer.from(encrypted, 'base64');
      buffer[12] ^= 0xff;
      const tampered = buffer.toString('base64');

      expect(() => manager.decrypt(tampered)).toThrow();
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted data', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const encrypted = manager.encrypt('test');

      expect(manager.isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for empty string', () => {
      const manager = new EncryptionManager(masterKey, testSalt);

      expect(manager.isEncrypted('')).toBe(false);
    });

    it('should return false for plain text', () => {
      const manager = new EncryptionManager(masterKey, testSalt);

      expect(manager.isEncrypted('Hello, World!')).toBe(false);
    });

    it('should return false for short base64 string', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const shortBase64 = Buffer.from('abc').toString('base64');

      expect(manager.isEncrypted(shortBase64)).toBe(false);
    });

    it('should return true for base64 string with sufficient length', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const validLength = Buffer.alloc(28).toString('base64');

      expect(manager.isEncrypted(validLength)).toBe(true);
    });

    it('should return false for strings with invalid base64 characters', () => {
      const manager = new EncryptionManager(masterKey, testSalt);

      expect(manager.isEncrypted('not-valid-base64!@#$%')).toBe(false);
    });
  });

  describe('key derivation consistency', () => {
    it('should produce consistent encryption with the same master key', () => {
      const manager1 = new EncryptionManager(masterKey, testSalt);
      const manager2 = new EncryptionManager(masterKey, testSalt);
      const plaintext = 'cross-instance test';

      const encrypted = manager1.encrypt(plaintext);
      const decrypted = manager2.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should derive different keys from different master keys', () => {
      const manager1 = new EncryptionManager('key-alpha', testSalt);
      const manager2 = new EncryptionManager('key-beta', testSalt);
      const plaintext = 'isolation test';

      const encrypted = manager1.encrypt(plaintext);

      expect(() => manager2.decrypt(encrypted)).toThrow();
    });
  });

  describe('generateSalt', () => {
    it('should produce a 64-character hex string (32 bytes)', () => {
      const salt = generateSalt();
      expect(salt).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(salt)).toBe(true);
    });

    it('should produce unique salts on each call', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1).not.toBe(salt2);
    });

    it('should derive different keys when using different salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const manager1 = new EncryptionManager(masterKey, salt1);
      const manager2 = new EncryptionManager(masterKey, salt2);
      const plaintext = 'salt isolation test';

      const encrypted = manager1.encrypt(plaintext);
      expect(() => manager2.decrypt(encrypted)).toThrow();
    });
  });

  describe('output format', () => {
    it('should produce valid base64 output', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const encrypted = manager.encrypt('format test');

      const base64Regex = /^[A-Za-z0-9+/]+=*$/;
      expect(base64Regex.test(encrypted)).toBe(true);
    });

    it('should produce output longer than IV + tag combined', () => {
      const manager = new EncryptionManager(masterKey, testSalt);
      const encrypted = manager.encrypt('a');

      const decoded = Buffer.from(encrypted, 'base64');
      const minLength = 12 + 16;
      expect(decoded.length).toBeGreaterThan(minLength);
    });
  });
});
