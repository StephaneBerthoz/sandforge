import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SalesforceOrg, UUID } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';

const mockGetJsforceConnection = vi.fn();

vi.mock('./ConnectionHelper', async (importOriginal) => ({
  // The real deadline helper: the sweep's bound on a silent org is under test.
  withDeadline: (await importOriginal<typeof import('./ConnectionHelper')>()).withDeadline,
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

import { validateOrgsOnStartup } from './startupValidation';

function makeOrg(id: string, alias: string): SalesforceOrg {
  return {
    id,
    alias,
    username: `${alias}@test.com`,
    instanceUrl: 'https://test.my.salesforce.com',
    orgId: '00D1',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: '', features: [] },
    status: 'connected',
    lastConnected: new Date().toISOString(),
    tags: [],
  };
}

function makeDeps(orgs: SalesforceOrg[]) {
  const orgManager = {
    getAllOrgs: vi.fn().mockReturnValue(orgs),
    updateStatus: vi.fn(),
  } as unknown as OrgManager;
  const orgRegistry = {} as unknown as OrgRegistry;
  const log = vi.fn();
  return { orgManager, orgRegistry, log };
}

describe('validateOrgsOnStartup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no orgs are registered', async () => {
    const deps = makeDeps([]);
    await validateOrgsOnStartup(deps);
    expect(mockGetJsforceConnection).not.toHaveBeenCalled();
    expect(deps.orgManager.updateStatus).not.toHaveBeenCalled();
  });

  it('marks an org connected on successful validation (no intermediate refreshing flip)', async () => {
    const org = makeOrg('org-1', 'dev');
    const deps = makeDeps([org]);
    mockGetJsforceConnection.mockResolvedValueOnce({});

    await validateOrgsOnStartup(deps);

    expect(mockGetJsforceConnection).toHaveBeenCalledTimes(1);
    // Status changes happen on RESULT only — a 'refreshing' intermediate made
    // connected counters tick down one by one during the sweep.
    const statuses = vi.mocked(deps.orgManager.updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual(['connected']);
  });

  it('marks an org expired on an authentication failure', async () => {
    const org = makeOrg('org-1', 'prod');
    const deps = makeDeps([org]);
    mockGetJsforceConnection.mockRejectedValueOnce(
      new Error('Authentication expired for org "prod". Reconnect it…'),
    );

    await validateOrgsOnStartup(deps);

    const statuses = vi.mocked(deps.orgManager.updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual(['expired']);
  });

  it('marks an org error on a non-auth failure', async () => {
    const org = makeOrg('org-1', 'dev');
    const deps = makeDeps([org]);
    mockGetJsforceConnection.mockRejectedValueOnce(
      new Error('Connection failed for "dev": NETWORK_ERROR'),
    );

    await validateOrgsOnStartup(deps);

    const statuses = vi.mocked(deps.orgManager.updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual(['error']);
  });

  it('keeps validating the remaining orgs after one fails', async () => {
    const orgs = [makeOrg('org-1', 'bad'), makeOrg('org-2', 'good')];
    const deps = makeDeps(orgs);
    mockGetJsforceConnection
      .mockRejectedValueOnce(new Error('Authentication expired for org "bad".'))
      .mockResolvedValueOnce({});

    await validateOrgsOnStartup(deps);

    expect(mockGetJsforceConnection).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(deps.orgManager.updateStatus).mock.calls;
    const byOrg = new Map<string, string[]>();
    for (const [id, status] of calls) {
      byOrg.set(id as string, [...(byOrg.get(id as string) ?? []), status as string]);
    }
    expect(byOrg.get('org-1')).toEqual(['expired']);
    expect(byOrg.get('org-2')).toEqual(['connected']);
  });

  it('does not let an org that never answers hold back the next one', async () => {
    vi.useFakeTimers();
    try {
      const orgs = [makeOrg('org-1', 'hung'), makeOrg('org-2', 'good')];
      const deps = makeDeps(orgs);
      mockGetJsforceConnection
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValueOnce({});

      const done = validateOrgsOnStartup(deps);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await done;

      expect(mockGetJsforceConnection).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(deps.orgManager.updateStatus).mock.calls;
      expect(calls).toEqual([
        ['org-1', 'error'],
        ['org-2', 'connected'],
      ]);
      expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/"hung".*did not finish/));
    } finally {
      vi.useRealTimers();
    }
  });

  describe('an answer that arrives after the deadline', () => {
    /** Deps whose OrgManager remembers the statuses the sweep sets. */
    function makeTrackingDeps(orgs: SalesforceOrg[]) {
      const statuses = new Map<string, SalesforceOrg['status']>();
      const orgManager = {
        getAllOrgs: vi.fn().mockReturnValue(orgs),
        getOrg: vi.fn((id: string) => {
          const org = orgs.find((o) => o.id === id);
          return org ? { ...org, status: statuses.get(id) ?? org.status } : undefined;
        }),
        updateStatus: vi.fn((id: string, status: SalesforceOrg['status']) => {
          statuses.set(id, status);
        }),
      } as unknown as OrgManager;
      return {
        deps: { orgManager, orgRegistry: {} as unknown as OrgRegistry, log: vi.fn() },
        statusOf: (id: string) => statuses.get(id),
      };
    }

    /** A connection attempt that settles `ms` after it starts. */
    function settlesAfter(ms: number, outcome: 'resolve' | 'reject'): Promise<unknown> {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (outcome === 'resolve') resolve({});
          else reject(new Error('Connection failed for "slow": NETWORK_ERROR'));
        }, ms);
      });
    }

    it('marks the org connected once a late validation succeeds', async () => {
      vi.useFakeTimers();
      try {
        const { deps, statusOf } = makeTrackingDeps([makeOrg('org-1', 'slow')]);
        mockGetJsforceConnection.mockReturnValueOnce(settlesAfter(50_000, 'resolve'));

        const done = validateOrgsOnStartup(deps);
        await vi.advanceTimersByTimeAsync(45_000);
        await done;
        expect(statusOf('org-1')).toBe('error');

        await vi.advanceTimersByTimeAsync(5_000);
        expect(statusOf('org-1')).toBe('connected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the org in error when the late answer is a failure', async () => {
      vi.useFakeTimers();
      try {
        const { deps, statusOf } = makeTrackingDeps([makeOrg('org-1', 'slow')]);
        mockGetJsforceConnection.mockReturnValueOnce(settlesAfter(50_000, 'reject'));

        const done = validateOrgsOnStartup(deps);
        await vi.advanceTimersByTimeAsync(45_000);
        await done;
        await vi.advanceTimersByTimeAsync(60_000);

        expect(statusOf('org-1')).toBe('error');
        expect(deps.orgManager.updateStatus).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not overwrite a status something else set in the meantime', async () => {
      vi.useFakeTimers();
      try {
        const { deps, statusOf } = makeTrackingDeps([makeOrg('org-1', 'slow')]);
        mockGetJsforceConnection.mockReturnValueOnce(settlesAfter(50_000, 'resolve'));

        const done = validateOrgsOnStartup(deps);
        await vi.advanceTimersByTimeAsync(45_000);
        await done;
        deps.orgManager.updateStatus('org-1' as UUID, 'refreshing');

        await vi.advanceTimersByTimeAsync(5_000);
        expect(statusOf('org-1')).toBe('refreshing');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
