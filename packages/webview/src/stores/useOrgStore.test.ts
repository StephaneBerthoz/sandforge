import { describe, it, expect, beforeEach } from 'vitest';
import { useOrgStore } from './useOrgStore';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

function createMockOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-001',
    alias: 'dev-sandbox',
    username: 'admin@dev.sandbox',
    instanceUrl: 'https://dev-sandbox.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    sandboxType: 'Developer',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#3b82f6', icon: 'cloud', position: 0 },
    metadata: {
      apiVersion: '60.0',
      edition: 'Developer',
      features: ['API', 'Bulk API'],
    },
    status: 'connected',
    lastConnected: '2026-02-20T10:00:00.000Z',
    tags: ['dev'],
    ...overrides,
  };
}

function getState(): ReturnType<typeof useOrgStore.getState> {
  return useOrgStore.getState();
}

describe('useOrgStore', () => {
  beforeEach(() => {
    useOrgStore.setState({
      orgs: [],
      selectedOrgId: null,
      isConnecting: false,
    });
  });

  it('should have correct initial state', () => {
    const state = getState();
    expect(state.orgs).toEqual([]);
    expect(state.selectedOrgId).toBeNull();
    expect(state.isConnecting).toBe(false);
  });

  it('should set orgs in bulk', () => {
    const orgs = [
      createMockOrg({ id: 'org-001' }),
      createMockOrg({ id: 'org-002', alias: 'staging' }),
    ];
    getState().setOrgs(orgs);
    expect(getState().orgs).toHaveLength(2);
    expect(getState().orgs[0].id).toBe('org-001');
    expect(getState().orgs[1].id).toBe('org-002');
  });

  it('should add an org', () => {
    const org = createMockOrg();
    getState().addOrg(org);
    expect(getState().orgs).toHaveLength(1);
    expect(getState().orgs[0]).toEqual(org);
  });

  it('should update an existing org', () => {
    const org = createMockOrg({ id: 'org-001' });
    getState().setOrgs([org]);

    getState().updateOrg('org-001', { alias: 'renamed-sandbox', status: 'expired' });

    const updated = getState().orgs[0];
    expect(updated.alias).toBe('renamed-sandbox');
    expect(updated.status).toBe('expired');
    expect(updated.username).toBe('admin@dev.sandbox');
  });

  it('should not modify other orgs when updating', () => {
    const org1 = createMockOrg({ id: 'org-001', alias: 'first' });
    const org2 = createMockOrg({ id: 'org-002', alias: 'second' });
    getState().setOrgs([org1, org2]);

    getState().updateOrg('org-001', { alias: 'updated-first' });

    expect(getState().orgs[0].alias).toBe('updated-first');
    expect(getState().orgs[1].alias).toBe('second');
  });

  it('should remove an org by id', () => {
    const orgs = [createMockOrg({ id: 'org-001' }), createMockOrg({ id: 'org-002' })];
    getState().setOrgs(orgs);

    getState().removeOrg('org-001');
    expect(getState().orgs).toHaveLength(1);
    expect(getState().orgs[0].id).toBe('org-002');
  });

  it('should clear selectedOrgId when the selected org is removed', () => {
    const org = createMockOrg({ id: 'org-001' });
    getState().setOrgs([org]);
    getState().selectOrg('org-001');
    expect(getState().selectedOrgId).toBe('org-001');

    getState().removeOrg('org-001');
    expect(getState().selectedOrgId).toBeNull();
  });

  it('should preserve selectedOrgId when a different org is removed', () => {
    getState().setOrgs([createMockOrg({ id: 'org-001' }), createMockOrg({ id: 'org-002' })]);
    getState().selectOrg('org-002');

    getState().removeOrg('org-001');
    expect(getState().selectedOrgId).toBe('org-002');
  });

  it('should select and deselect an org', () => {
    getState().selectOrg('org-123');
    expect(getState().selectedOrgId).toBe('org-123');

    getState().selectOrg(null);
    expect(getState().selectedOrgId).toBeNull();
  });

  it('should set connecting state', () => {
    getState().setConnecting(true);
    expect(getState().isConnecting).toBe(true);
    getState().setConnecting(false);
    expect(getState().isConnecting).toBe(false);
  });

  it('should return the selected org via selectedOrg()', () => {
    const org = createMockOrg({ id: 'org-001' });
    getState().setOrgs([org]);
    getState().selectOrg('org-001');

    expect(getState().selectedOrg()).toEqual(org);
  });

  it('should return undefined from selectedOrg() when no org is selected', () => {
    getState().setOrgs([createMockOrg()]);
    expect(getState().selectedOrg()).toBeUndefined();
  });

  it('should return only connected orgs via connectedOrgs()', () => {
    getState().setOrgs([
      createMockOrg({ id: 'org-001', status: 'connected' }),
      createMockOrg({ id: 'org-002', status: 'expired' }),
      createMockOrg({ id: 'org-003', status: 'connected' }),
      createMockOrg({ id: 'org-004', status: 'error' }),
    ]);

    const connected = getState().connectedOrgs();
    expect(connected).toHaveLength(2);
    expect(connected.map((o) => o.id)).toEqual(['org-001', 'org-003']);
  });

  it('should filter orgs by safety tier via orgsByTier()', () => {
    getState().setOrgs([
      createMockOrg({ id: 'org-001', safetyTier: OrgSafetyTier.LOW }),
      createMockOrg({ id: 'org-002', safetyTier: OrgSafetyTier.CRITICAL }),
      createMockOrg({ id: 'org-003', safetyTier: OrgSafetyTier.LOW }),
      createMockOrg({ id: 'org-004', safetyTier: OrgSafetyTier.HIGH }),
    ]);

    const lowOrgs = getState().orgsByTier(OrgSafetyTier.LOW);
    expect(lowOrgs).toHaveLength(2);
    expect(lowOrgs.map((o) => o.id)).toEqual(['org-001', 'org-003']);

    const criticalOrgs = getState().orgsByTier(OrgSafetyTier.CRITICAL);
    expect(criticalOrgs).toHaveLength(1);
    expect(criticalOrgs[0].id).toBe('org-002');

    const mediumOrgs = getState().orgsByTier(OrgSafetyTier.MEDIUM);
    expect(mediumOrgs).toHaveLength(0);
  });
});
