import { describe, expect, it } from 'vitest';
import {
  buildFrozenManifest,
  ManifestError,
  parseManifest,
  serializeManifest,
  validateManifest,
  type FrozenManifest,
} from './manifest.js';
import type { NonReidentificationReport } from './NonReidentificationControl.js';

const NOW = new Date('2026-08-03T11:00:00Z');

const passingControl: NonReidentificationReport = {
  passed: true,
  checks: [
    { name: 'substitution', passed: true, violations: [] },
    { name: 'clear-empty', passed: true, violations: [] },
    { name: 'formats', passed: true, violations: [] },
    { name: 'no-residual-id', passed: true, violations: [] },
  ],
  author: 'qa-bot',
  checkedAt: NOW.toISOString(),
};

function buildValid(): FrozenManifest {
  return buildFrozenManifest({
    version: '1.4.0',
    source: { orgId: '00DXXXXXXXXXXXX', orgAlias: 'recette', decisionDate: '2026-08-01' },
    saltFingerprint: 'abcdef012345',
    rulesVersion: '1.0.0',
    volumetry: {
      budgetMax: 2500,
      measured: { Account: 12, Contact: 20 },
      measuredAt: '2026-08-03T09:00:00.000Z',
    },
    nonReidentification: passingControl,
    author: 'stephane',
    now: () => NOW,
  });
}

describe('buildFrozenManifest', () => {
  it('contains every required field (spec §4)', () => {
    const manifest = buildValid();
    expect(manifest.version).toBe('1.4.0');
    expect(manifest.status).toBe('frozen');
    expect(manifest.frozenAt).toBe(NOW.toISOString());
    expect(manifest.source).toEqual({
      orgId: '00DXXXXXXXXXXXX',
      orgAlias: 'recette',
      decisionDate: '2026-08-01',
    });
    expect(manifest.saltFingerprint).toBe('abcdef012345');
    expect(manifest.rulesVersion).toBe('1.0.0');
    expect(manifest.volumetry.measured).toEqual({ Account: 12, Contact: 20 });
    expect(manifest.controls.nonReidentification.passed).toBe(true);
    // Dry-run load is the load phase's extension point: null at freeze time.
    expect(manifest.controls.dryRunLoad).toBeNull();
    expect(manifest.controls.author).toBe('stephane');
    expect(manifest.controls.date).toBe(NOW.toISOString());
  });

  it('rejects non-semver version, bad fingerprint, missing source', () => {
    expect(() => buildFrozenManifest({ ...baseInput(), version: '1.4' })).toThrow(ManifestError);
    expect(() => buildFrozenManifest({ ...baseInput(), saltFingerprint: 'xyz' })).toThrow(
      /saltFingerprint/,
    );
    expect(() =>
      buildFrozenManifest({
        ...baseInput(),
        source: { orgId: '', decisionDate: '2026-08-01' },
      }),
    ).toThrow(/source/);
  });

  function baseInput() {
    return {
      version: '1.0.0',
      source: { orgId: '00DXXXXXXXXXXXX', decisionDate: '2026-08-01' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: { budgetMax: 2500, measured: {}, measuredAt: NOW.toISOString() },
      nonReidentification: passingControl,
      author: 'stephane',
      now: () => NOW,
    };
  }
});

describe('manifest serialization', () => {
  it('serializes to JSON and parses back losslessly', () => {
    const manifest = buildValid();
    const roundTripped = parseManifest(JSON.parse(serializeManifest(manifest)));
    expect(roundTripped).toEqual(manifest);
  });

  it('never contains the salt itself — only its fingerprint', () => {
    const serialized = serializeManifest(buildValid());
    expect(serialized).toContain('abcdef012345');
    expect(serialized).not.toContain('test-salt');
  });

  it('validateManifest rejects non-object payloads', () => {
    expect(() => parseManifest(['nope'])).toThrow(ManifestError);
    const manifest = buildValid();
    manifest.status = 'draft' as unknown as 'frozen';
    expect(() => validateManifest(manifest)).toThrow(/frozen/);
  });
});
