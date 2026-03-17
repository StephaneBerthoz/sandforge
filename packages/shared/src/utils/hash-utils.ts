/**
 * Non-cryptographic hash and checksum utilities.
 *
 * Provides FNV-1a hashing, short hash generation,
 * and simple checksum computation for data integrity.
 */

/** Computes a 32-bit FNV-1a hash of the input string. */
export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/** Generates a short hash string (8 hex chars) from the input. */
export function shortHash(input: string): string {
  return fnv1aHash(input).toString(16).padStart(8, '0');
}

/** Computes a simple checksum string for data integrity verification. */
export function checksum(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum = ((sum << 5) - sum + data.charCodeAt(i)) | 0;
  }
  return (sum >>> 0).toString(16).padStart(8, '0');
}

/** Verifies that the checksum of the given data matches the expected value. */
export function verifyChecksum(data: string, expected: string): boolean {
  return checksum(data) === expected;
}
