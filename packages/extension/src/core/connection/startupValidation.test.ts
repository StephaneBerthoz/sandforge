import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';

const mockGetJsforceConnection = vi.fn();

vi.mock('./ConnectionHelper', () => ({
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

  it('marks an org refreshing then connected on successful validation', async () => {
    const org = makeOrg('org-1', 'dev');
    const deps = makeDeps([org]);
    mockGetJsforceConnection.mockResolvedValueOnce({});

    await validateOrgsOnStartup(deps);

    expect(mockGetJsforceConnection).toHaveBeenCalledTimes(1);
    const statuses = vi.mocked(deps.orgManager.updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual(['refreshing', 'connected']);
  });

  it('marks an org expired on an authentication failure', async () => {
    const org = makeOrg('org-1', 'prod');
    const deps = makeDeps([org]);
    mockGetJsforceConnection.mockRejectedValueOnce(
      new Error('Authentication expired for org "prod". Reconnect it…'),
    );

    await validateOrgsOnStartup(deps);

    const statuses = vi.mocked(deps.orgManager.updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual(['refreshing', 'expired']);
  });

  it('marks an org error on a non-auth failure', async () => {
    const org = makeOrg('org-1', 'dev');
    const deps = makeDeps([org]);
    mockGetJsforceConnection.mockRejectedValueOnce(
      new Error('Connection failed for "dev": NETWORK_ERROR'),
    );

    await validateOrgsOnStartup(deps);

    const statuses = vi.mocked(deps.orgManager.updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual(['refreshing', 'error']);
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
    expect(byOrg.get('org-1')).toEqual(['refreshing', 'expired']);
    expect(byOrg.get('org-2')).toEqual(['refreshing', 'connected']);
  });
});
