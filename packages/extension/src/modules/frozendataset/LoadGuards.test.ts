import { describe, expect, it, vi } from 'vitest';
import {
  assertLoadGuards,
  CustomMetadataCalloutMockDetector,
  LoadGuardError,
  datasetRecordCount,
  type LoadGuardInput,
} from './LoadGuards.js';
import type { FrozenDataset } from './types.js';
import { buildFrozenManifest } from './manifest.js';

function makeDataset(recordCount = 1): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Account',
        records: Array.from({ length: recordCount }, (_, i) => ({
          referenceId: `Account-${String(i + 1).padStart(6, '0')}`,
          fields: { Name: `Anon ${i}` },
        })),
      },
    ],
    recordTypes: {},
    personContactSidecar: [],
  };
}

function makeInput(overrides?: Partial<LoadGuardInput>): LoadGuardInput {
  return {
    orgId: '00D-target',
    orgTier: 'development',
    dataset: makeDataset(),
    mockDetector: { areCalloutsMocked: vi.fn().mockResolvedValue(true) },
    ...overrides,
  };
}

describe('assertLoadGuards', () => {
  it('passes on a sandbox with mocked callouts and a non-empty dataset', async () => {
    await expect(assertLoadGuards(makeInput())).resolves.toBeUndefined();
    await expect(assertLoadGuards(makeInput({ orgTier: 'scratch' }))).resolves.toBeUndefined();
  });

  it('refuses a non-sandbox org (production and staging tiers)', async () => {
    for (const orgTier of ['production', 'staging'] as const) {
      const error = await assertLoadGuards(makeInput({ orgTier })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LoadGuardError);
      expect((error as LoadGuardError).code).toBe('non-sandbox');
      // Remediation is a config deployment on the target — never DML on the source.
      expect((error as Error).message).toMatch(/sandbox-only/);
      expect((error as Error).message).toMatch(/never run DML against a shared or source org/i);
    }
  });

  it('refuses a configured protected environment', async () => {
    const error = await assertLoadGuards(
      makeInput({ protectedOrgIds: ['00D-shared', '00D-target'] }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('protected-environment');
    expect((error as Error).message).toContain('protectedOrgIds');
  });

  it('refuses the manifest source org — the source is never a target', async () => {
    const manifest = buildFrozenManifest({
      version: '1.0.0',
      source: { orgId: '00D-target', decisionDate: '2026-01-15T00:00:00.000Z' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: {
        budgetMax: 2500,
        measured: { Account: 1 },
        measuredAt: '2026-01-15T00:00:00.000Z',
      },
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'tester',
        checkedAt: '2026-01-15T00:00:00.000Z',
      },
      author: 'tester',
    });
    const error = await assertLoadGuards(makeInput({ manifest })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('source-is-target');
  });

  it('refuses unmocked callouts with a deploy-config remediation', async () => {
    const error = await assertLoadGuards(
      makeInput({ mockDetector: { areCalloutsMocked: vi.fn().mockResolvedValue(false) } }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('unmocked-callouts');
    expect((error as Error).message).toMatch(/deploy the mock configuration/i);
    expect((error as Error).message).toMatch(/never edit data on the source org/i);
  });

  it('refuses an empty dataset', async () => {
    const error = await assertLoadGuards(makeInput({ dataset: makeDataset(0) })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('empty-dataset');
  });
});

describe('CustomMetadataCalloutMockDetector', () => {
  it('returns true when a metadata record flags IsMocked', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: 'm001' }]);
    const detector = new CustomMetadataCalloutMockDetector(
      { query },
      { metadataTypeApiName: 'Callout_Mock__mdt', isMockedFieldApiName: 'IsMocked__c' },
    );
    await expect(detector.areCalloutsMocked('00D-target')).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      '00D-target',
      'SELECT Id FROM Callout_Mock__mdt WHERE IsMocked__c = true LIMIT 1',
    );
  });

  it('returns false when no record matches or the metadata type is not deployed', async () => {
    const emptyQuery = vi.fn().mockResolvedValue([]);
    const detector = new CustomMetadataCalloutMockDetector(
      { query: emptyQuery },
      { metadataTypeApiName: 'Callout_Mock__mdt', isMockedFieldApiName: 'IsMocked__c' },
    );
    await expect(detector.areCalloutsMocked('00D-target')).resolves.toBe(false);

    const failingQuery = vi.fn().mockRejectedValue(new Error('sObject type is not supported'));
    const failingDetector = new CustomMetadataCalloutMockDetector(
      { query: failingQuery },
      { metadataTypeApiName: 'Callout_Mock__mdt', isMockedFieldApiName: 'IsMocked__c' },
    );
    await expect(failingDetector.areCalloutsMocked('00D-target')).resolves.toBe(false);
  });
});

describe('datasetRecordCount', () => {
  it('sums records across objects', () => {
    expect(datasetRecordCount(makeDataset(3))).toBe(3);
  });
});
