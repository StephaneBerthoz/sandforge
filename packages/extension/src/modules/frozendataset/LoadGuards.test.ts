import { describe, expect, it, vi } from 'vitest';
import {
  assertLoadGuards,
  assertLoadTier,
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

  it('refuses a production org', async () => {
    const error = await assertLoadGuards(makeInput({ orgTier: 'production' })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('non-sandbox');
    // Remediation is a config deployment on the target — never DML on the source.
    expect((error as Error).message).toMatch(/sandboxes and Developer Edition orgs only/);
    expect((error as Error).message).toMatch(/never run DML against a shared or source org/i);
  });

  it('refuses a sandbox marked Staging as one, naming another sandbox or the box that marks it', async () => {
    // Said "loads go into sandboxes … only", it sent the user looking for an
    // org type the sandbox had all along: what refuses it is the mark.
    const error = await assertLoadGuards(makeInput({ orgTier: 'staging' })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('non-sandbox');
    expect((error as LoadGuardError).params).toMatchObject({ tier: 'staging' });
    expect((error as Error).message).toContain(
      'it is a sandbox marked Staging, which holds real data',
    );
    expect((error as Error).message).toContain(
      'pick another sandbox, or, if this one holds no real data, untick Staging in its Edit ' +
        'dialog on the Organizations page.',
    );
    expect((error as Error).message).not.toMatch(/sandboxes and Developer Edition orgs only/);
  });

  it('names the org in its English by the name the caller gives, its id kept for the panel', async () => {
    // A load refused into a sandbox marked Staging said the org's registered
    // id, where the person reads its alias everywhere else.
    for (const orgTier of ['staging', 'production'] as const) {
      const error = await assertLoadGuards(makeInput({ orgTier, orgName: 'UATSandbox' })).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toContain('UATSandbox');
      expect((error as Error).message).not.toContain('00D-target');
      expect((error as LoadGuardError).params).toMatchObject({ orgId: '00D-target' });
    }
    const protectedOrg = await assertLoadGuards(
      makeInput({ orgName: 'UATSandbox', protectedOrgIds: ['00D-target'] }),
    ).catch((e: unknown) => e);
    expect((protectedOrg as Error).message).toContain('protected environment UATSandbox');
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
    // Named beside the English, for the panel to word it: refused as the
    // English alone, the first load into the source read "manifest
    // source.orgId" in every locale.
    expect((error as LoadGuardError).params).toEqual({ orgId: '00D-target' });
  });

  it('names the org each refusal is of, and its tier where the tier is why', async () => {
    const tier = await assertLoadGuards(makeInput({ orgTier: 'production' })).catch(
      (e: unknown) => e,
    );
    expect((tier as LoadGuardError).params).toEqual({ orgId: '00D-target', tier: 'production' });
    const protectedOrg = await assertLoadGuards(
      makeInput({ protectedOrgIds: ['00D-target'] }),
    ).catch((e: unknown) => e);
    expect((protectedOrg as LoadGuardError).params).toEqual({ orgId: '00D-target' });
    const unmocked = await assertLoadGuards(
      makeInput({ mockDetector: { areCalloutsMocked: vi.fn().mockResolvedValue(false) } }),
    ).catch((e: unknown) => e);
    expect((unmocked as LoadGuardError).params).toEqual({ orgId: '00D-target' });
    const empty = await assertLoadGuards(makeInput({ dataset: makeDataset(0) })).catch(
      (e: unknown) => e,
    );
    expect((empty as LoadGuardError).params).toEqual({});
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

describe('assertLoadTier', () => {
  it('lets a sandbox, a scratch org or a Developer Edition org through, and refuses the rest as the entry guards do', () => {
    expect(() => assertLoadTier({ orgId: 'org-dev', orgTier: 'development' })).not.toThrow();
    expect(() => assertLoadTier({ orgId: 'org-scratch', orgTier: 'scratch' })).not.toThrow();
    for (const orgTier of ['production', 'staging'] as const) {
      const error = (() => {
        try {
          assertLoadTier({ orgId: 'org-x', orgTier });
          return undefined;
        } catch (err: unknown) {
          return err;
        }
      })();
      expect(error).toBeInstanceOf(LoadGuardError);
      expect(error).toMatchObject({
        code: 'non-sandbox',
        params: { orgId: 'org-x', tier: orgTier },
      });
    }
  });

  it('lets a replay of a checkpoint the host let into a sandbox marked Staging through, and never a production org', () => {
    expect(() =>
      assertLoadTier({ orgId: 'org-uat', orgTier: 'staging', stagingReplay: true }),
    ).not.toThrow();
    expect(() =>
      assertLoadTier({ orgId: 'org-prod', orgTier: 'production', stagingReplay: true }),
    ).toThrow(LoadGuardError);
  });

  it('passes the entry guards of a replay into a sandbox marked Staging, the others still judged', async () => {
    await expect(
      assertLoadGuards(makeInput({ orgTier: 'staging', stagingReplay: true })),
    ).resolves.toBeUndefined();
    await expect(
      assertLoadGuards(
        makeInput({ orgTier: 'staging', stagingReplay: true, protectedOrgIds: ['00D-target'] }),
      ),
    ).rejects.toMatchObject({ code: 'protected-environment' });
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
