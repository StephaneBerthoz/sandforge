import { describe, it, expect } from 'vitest';

import { PROTOCOL_VERSION, isVersionCompatible } from './protocolVersion.js';

/**
 * The version is the one thing host and webview compare before trusting each
 * other's messages. A policy that says yes to everything lets an old webview
 * post envelopes the new host misreads; one that says no to everything puts a
 * reload banner on every panel after every update.
 */
describe('bridge protocol version', () => {
  it('is a positive whole number', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('accepts an envelope stamped with the current version', () => {
    expect(isVersionCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it('refuses an envelope from an older or newer side', () => {
    expect(isVersionCompatible(PROTOCOL_VERSION - 1)).toBe(false);
    expect(isVersionCompatible(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('refuses a version that is not a real number', () => {
    expect(isVersionCompatible(Number.NaN)).toBe(false);
    expect(isVersionCompatible(0)).toBe(false);
  });
});
