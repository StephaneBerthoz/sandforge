/**
 * Salesforce 15/18-character ID checksum utilities.
 *
 * The 18-character ID is the 15-character case-sensitive ID plus a
 * 3-character case checksum: the ID is split into three 5-character
 * blocks; within each block every uppercase letter sets one bit (the
 * leftmost character of a block is bit 0, value 1); the resulting 5-bit
 * number (0-31) indexes into 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'.
 *
 * The checksum is the ONLY reliable discriminator for "this string is a
 * Salesforce ID": length alone false-positives on 18-char business
 * identifiers, and the pod marker (chars 4-5) differs between record IDs
 * and RecordType IDs from the same org.
 */

/** Alphabet indexed by the 5-bit checksum value. */
const CHECKSUM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** Characters allowed in the 15-char body of a Salesforce ID. */
const ID_BODY_REGEX = /^[a-zA-Z0-9]{15}$/;

/** Full 18-char shape: 15-char body + 3-char checksum. */
const ID_18_REGEX = /^[a-zA-Z0-9]{18}$/;

/**
 * Compute the 3-character checksum suffix for a 15-character ID body.
 *
 * @param id15 - The 15-character case-sensitive ID.
 * @returns The 3-character suffix that makes the ID an 18-char ID.
 * @throws {Error} When the input is not a 15-char alphanumeric string.
 */
export function computeChecksumSuffix(id15: string): string {
  if (!ID_BODY_REGEX.test(id15)) {
    throw new Error(`Not a 15-character Salesforce ID body: ${JSON.stringify(id15)}`);
  }
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const c = id15.charAt(block * 5 + i);
      if (c >= 'A' && c <= 'Z') {
        flags += 1 << i;
      }
    }
    suffix += CHECKSUM_ALPHABET.charAt(flags);
  }
  return suffix;
}

/** Convert a 15-character Salesforce ID to its 18-character form. */
export function to18(id15: string): string {
  return id15 + computeChecksumSuffix(id15);
}

/**
 * True when `value` is an 18-character string whose last three characters
 * are the valid case checksum of the first fifteen. This is the
 * discriminant used by the dead-ID sweep (spec §3): it catches record IDs
 * AND RecordType IDs regardless of pod marker.
 */
export function isValidSalesforceId18(value: string): boolean {
  if (!ID_18_REGEX.test(value)) {
    return false;
  }
  const body = value.slice(0, 15);
  const suffix = value.slice(15);
  return computeChecksumSuffix(body) === suffix;
}

/**
 * True when `value` looks like a Salesforce ID in either form. The
 * 15-char form carries no checksum so only the charset is verified;
 * prefer {@link isValidSalesforceId18} wherever a reliable discriminant
 * is required.
 */
export function isSalesforceId(value: string): boolean {
  if (ID_BODY_REGEX.test(value)) {
    return true;
  }
  return isValidSalesforceId18(value);
}
