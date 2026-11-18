import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier, RECOVERY_STEP_COUNT, recoveryAckKey } from '@sandforge/shared';
import { ConfigStore } from '../../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend';
import type { DetectedSandboxRefresh } from '../monitor/SandboxRefreshDetector';
import { deducedProgressSource, detectorProgressSource, refreshKeyOf } from './recoveryProgress';

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

  it('keys a refresh only production reported by the org the sandbox answered as last, which it still was', () => {
    // Production's history names neither org: the sandbox has not answered
    // since, and the detector still holds the org it was.
    const reported = refresh({
      evidence: 'production',
      previousOrganizationId: undefined,
      organizationId: undefined,
    });
    expect(refreshKeyOf(reported, () => BEFORE)).toBe(BEFORE);
    // Once the sandbox answers, the refresh names the org it was: the same key.
    expect(refreshKeyOf(refresh({ evidence: 'production' }), () => AFTER)).toBe(BEFORE);
  });
});

describe('detectorProgressSource, on a refresh production reported first', () => {
  it('keeps a recovery finished before the sandbox answered finished once it does', () => {
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    let answered = false;
    let current = BEFORE;
    const refreshes = () => [
      answered
        ? refresh({ evidence: 'production' })
        : refresh({
            evidence: 'production',
            previousOrganizationId: undefined,
            organizationId: undefined,
          }),
    ];
    const source = detectorProgressSource({
      refreshesOf: refreshes,
      organizationIdOf: () => current,
      orgOf: () => sandbox(),
      configStore,
    });
    configStore.set(
      recoveryAckKey('entry-uat', BEFORE),
      { steps: {}, finishedAt: '2026-11-18T17:00:00.000Z' },
      'recovery',
    );
    expect(source.progressOf('entry-uat')).toBeUndefined();
    answered = true;
    current = AFTER;
    expect(source.progressOf('entry-uat')).toBeUndefined();
  });
});

describe('deducedProgressSource', () => {
  let configStore: ConfigStore;
  let refreshes: DetectedSandboxRefresh[];
  let counted: { done: number; total: number } | undefined;
  let statusOf: ReturnType<typeof vi.fn<(entryId: string) => Promise<typeof counted>>>;
  let clock: number;

  const source = () =>
    deducedProgressSource({
      refreshesOf: () => refreshes,
      organizationIdOf: () => AFTER,
      orgOf: (entryId) => (entryId === 'entry-uat' ? sandbox() : undefined),
      configStore,
      statusOf,
      ttlMs: 30_000,
      now: () => clock,
    });

  /** Let the deductions under way end. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    refreshes = [refresh()];
    counted = { done: 3, total: 8 };
    statusOf = vi.fn(() => Promise.resolve(counted));
    clock = 1_000_000;
  });

  it('answers what the detector knows at once, then the steps deduced, and says it changed', async () => {
    const progress = source();
    const told = vi.fn();
    progress.onDidChange(told);
    expect(progress.progressOf('entry-uat')).toMatchObject({ done: 0, total: RECOVERY_STEP_COUNT });
    await settled();
    expect(told).toHaveBeenCalledTimes(1);
    expect(progress.progressOf('entry-uat')).toEqual({
      orgId: 'entry-uat',
      alias: 'UAT',
      detectedAt: '2026-11-18T08:12:00.000Z',
      done: 3,
      total: 8,
    });
    expect(statusOf).toHaveBeenCalledTimes(1);
  });

  it('deduces again once its short cache has passed, and says nothing when nothing changed', async () => {
    const progress = source();
    const told = vi.fn();
    progress.onDidChange(told);
    progress.progressOf('entry-uat');
    await settled();
    progress.progressOf('entry-uat');
    await settled();
    expect(statusOf).toHaveBeenCalledTimes(1);

    clock += 30_001;
    progress.progressOf('entry-uat');
    await settled();
    expect(statusOf).toHaveBeenCalledTimes(2);
    expect(told).toHaveBeenCalledTimes(1);

    clock += 30_001;
    counted = { done: 4, total: 8 };
    expect(progress.progressOf('entry-uat')?.done).toBe(3);
    await settled();
    expect(told).toHaveBeenCalledTimes(2);
    expect(progress.progressOf('entry-uat')?.done).toBe(4);
  });

  it('deduces again at once when a step is said to have changed, the last count kept meanwhile', async () => {
    const progress = source();
    const told = vi.fn();
    progress.onDidChange(told);
    progress.progressOf('entry-uat');
    await settled();
    told.mockClear();

    counted = { done: 5, total: 8 };
    progress.invalidate('entry-uat');
    expect(told).toHaveBeenCalledTimes(1);
    expect(progress.progressOf('entry-uat')?.done).toBe(3);
    await settled();
    expect(told).toHaveBeenCalledTimes(2);
    expect(progress.progressOf('entry-uat')?.done).toBe(5);
  });

  it('drops a count of the refresh before once a new refresh is noticed', async () => {
    const progress = source();
    progress.progressOf('entry-uat');
    await settled();
    refreshes = [
      refresh({ detectedAt: '2026-12-02T08:00:00.000Z', previousOrganizationId: AFTER }),
    ];
    counted = { done: 1, total: 9 };
    expect(progress.progressOf('entry-uat')).toMatchObject({
      detectedAt: '2026-12-02T08:00:00.000Z',
      done: 0,
      total: RECOVERY_STEP_COUNT,
    });
    await settled();
    expect(progress.progressOf('entry-uat')).toMatchObject({ done: 1, total: 9 });
  });

  it('says nothing of a recovery finished, and tells the launcher so as soon as it is', async () => {
    const progress = source();
    const told = vi.fn();
    progress.onDidChange(told);
    progress.progressOf('entry-uat');
    await settled();
    told.mockClear();
    configStore.set(
      recoveryAckKey('entry-uat', BEFORE),
      { steps: {}, finishedAt: '2026-11-18T17:00:00.000Z' },
      'recovery',
    );
    progress.invalidate('entry-uat');
    expect(told).toHaveBeenCalledTimes(1);
    expect(progress.progressOf('entry-uat')).toBeUndefined();
  });

  it('keeps what it knew when a deduction fails, and does not ask again before its cache passes', async () => {
    const log = vi.fn();
    const progress = deducedProgressSource({
      refreshesOf: () => refreshes,
      organizationIdOf: () => AFTER,
      orgOf: () => sandbox(),
      configStore,
      statusOf: () => Promise.reject(new Error('the checkpoints cannot be read')),
      ttlMs: 30_000,
      now: () => clock,
      log,
    });
    expect(progress.progressOf('entry-uat')?.done).toBe(0);
    await settled();
    progress.progressOf('entry-uat');
    await settled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('the checkpoints cannot be read');
  });

  it('stops telling a listener once it is disposed', async () => {
    const progress = source();
    const told = vi.fn();
    progress.onDidChange(told).dispose();
    progress.progressOf('entry-uat');
    await settled();
    expect(told).not.toHaveBeenCalled();
  });
});
