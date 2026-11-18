import { describe, it, expect, beforeEach } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier, RECOVERY_STEP_COUNT, recoveryAckKey } from '@sandforge/shared';
import { ConfigStore } from '../../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend';
import type { DetectedSandboxRefresh } from '../monitor/SandboxRefreshDetector';
import { detectorProgressSource, refreshKeyOf } from './recoveryProgress';

const BEFORE = '00Dxx00000AbCdE';
const AFTER = '00Dxx00000FgHiJ';

function sandbox(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'entry-uat',
    alias: 'UAT',
    username: 'admin@acme.test.uat',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: `${BEFORE}AAA`,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-11-01T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function refresh(overrides: Partial<DetectedSandboxRefresh> = {}): DetectedSandboxRefresh {
  return {
    orgId: 'entry-uat',
    detectedAt: '2026-11-18T08:12:00.000Z',
    evidence: 'connection',
    previousOrganizationId: BEFORE,
    organizationId: AFTER,
    ...overrides,
  };
}

describe('detectorProgressSource', () => {
  let configStore: ConfigStore;
  let orgs: Map<string, SalesforceOrg>;
  let refreshes: Map<string, DetectedSandboxRefresh[]>;

  const source = () =>
    detectorProgressSource({
      refreshesOf: (entryId) => refreshes.get(entryId) ?? [],
      orgOf: (entryId) => orgs.get(entryId),
      configStore,
    });

  beforeEach(() => {
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    orgs = new Map([['entry-uat', sandbox()]]);
    refreshes = new Map([['entry-uat', [refresh()]]]);
  });

  it('says a refreshed sandbox has every step still to do, as the detector alone knows it', () => {
    expect(source().progressOf('entry-uat')).toEqual({
      orgId: 'entry-uat',
      alias: 'UAT',
      detectedAt: '2026-11-18T08:12:00.000Z',
      done: 0,
      total: RECOVERY_STEP_COUNT,
    });
  });

  it('follows the newest refresh of the sandbox', () => {
    refreshes.set('entry-uat', [
      refresh({ detectedAt: '2026-11-18T08:12:00.000Z' }),
      refresh({
        detectedAt: '2026-10-02T07:00:00.000Z',
        previousOrganizationId: '00Dxx00000ZzZzZ',
      }),
    ]);
    expect(source().progressOf('entry-uat')?.detectedAt).toBe('2026-11-18T08:12:00.000Z');
  });

  it('says nothing of a sandbox no refresh was noticed on, nor of an entry no longer registered', () => {
    refreshes.set('entry-uat', []);
    expect(source().progressOf('entry-uat')).toBeUndefined();
    expect(source().progressOf('entry-gone')).toBeUndefined();
  });

  it('says nothing of an org that is not a sandbox, whatever was recorded of it', () => {
    orgs.set('entry-uat', sandbox({ orgType: 'Production' }));
    expect(source().progressOf('entry-uat')).toBeUndefined();
  });

  it('says nothing once the recovery of that refresh was finished, and again of the next refresh', () => {
    configStore.set(
      recoveryAckKey('entry-uat', BEFORE),
      { steps: {}, finishedAt: '2026-11-18T17:00:00.000Z' },
      'recovery',
    );
    expect(source().progressOf('entry-uat')).toBeUndefined();

    // The next refresh is of the org the sandbox became: its recovery starts over.
    refreshes.set('entry-uat', [
      refresh({
        detectedAt: '2026-12-02T08:00:00.000Z',
        previousOrganizationId: AFTER,
        organizationId: '00Dxx00000KlMnO',
      }),
      refresh(),
    ]);
    expect(source().progressOf('entry-uat')?.detectedAt).toBe('2026-12-02T08:00:00.000Z');
  });

  it('keeps showing a recovery whose acknowledgements cannot be read, rather than hiding it', () => {
    configStore.set(recoveryAckKey('entry-uat', BEFORE), { finishedAt: 'yesterday' }, 'recovery');
    expect(source().progressOf('entry-uat')?.done).toBe(0);
  });

  it('names the alias the launcher names the org by', () => {
    orgs.set('entry-uat', sandbox({ alias: 'admin@acme.test.uat', organizationName: 'Acme UAT' }));
    expect(source().progressOf('entry-uat')?.alias).toBe('Acme UAT');
  });
});

describe('refreshKeyOf', () => {
  it('keys a refresh by the org the sandbox was before it, or else by when it was noticed', () => {
    expect(refreshKeyOf(refresh())).toBe(BEFORE);
    expect(refreshKeyOf(refresh({ previousOrganizationId: undefined }))).toBe(
      '2026-11-18T08:12:00.000Z',
    );
  });
});
