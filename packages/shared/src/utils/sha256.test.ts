import { describe, it, expect } from 'vitest';

import { sha256Hex } from './sha256.js';

// The shared package has no @types/node dependency — declare the Node
// builtin this test compares with (vitest provides it at runtime).
declare function require(id: string): unknown;

const { createHash } = require('node:crypto') as {
  createHash(algorithm: 'sha256'): {
    update(text: string, encoding: 'utf8'): { digest(encoding: 'hex'): string };
  };
};

/** What Node's own SHA-256 answers for the UTF-8 bytes of `text`. */
const nodeSha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('answers the digests FIPS 180-4 gives for its examples, and for nothing', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('answers what Node answers on each side of a block, where the padding takes a block of its own', () => {
    // 55 bytes leave room for the length in the block; 56 do not.
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(nodeSha256(text));
    }
  });

  it('hashes the UTF-8 bytes of a text, not its UTF-16 code units', () => {
    for (const text of ['é', 'Données réelles', '組織の項目', '🙂 emoji', '\u0000￿']) {
      expect(sha256Hex(text)).toBe(nodeSha256(text));
    }
  });

  it('answers what Node answers for texts drawn at random', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 200; round++) {
      const length = next() % 300;
      const text = Array.from({ length }, () => String.fromCodePoint(32 + (next() % 0x2fff))).join(
        '',
      );
      expect(sha256Hex(text)).toBe(nodeSha256(text));
    }
  });
});
