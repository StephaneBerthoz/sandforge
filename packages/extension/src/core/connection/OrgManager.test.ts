import { describe, it, expect, vi } from 'vitest';
import type { SalesforceOrg, UUID } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { OrgManager } from './OrgManager';
import type { OrgManagerEvent } from './OrgManager';

function createMockOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-001' as UUID,
    alias: 'dev-sandbox',
    username: 'user@test.sandbox',
    instanceUrl: 'https://test.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    sandboxType: 'Developer',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4CAF50', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00.000Z',
    tags: ['dev', 'test'],
    ...overrides,
  };
}

describe('OrgManager', () => {
  it('should add an org and emit added event', () => {
    const manager = new OrgManager();
    const listener = vi.fn();
    manager.onOrgChange(listener);

    const org = createMockOrg();
    manager.addOrg(org);

    expect(manager.getOrg(org.id)).toEqual(org);
    expect(listener).toHaveBeenCalledWith({
      type: 'added',
      orgId: org.id,
      org,
    } satisfies OrgManagerEvent);
  });

  it('should emit updated event when adding an existing org', () => {
    const manager = new OrgManager();
    const org = createMockOrg();
    manager.addOrg(org);

    const listener = vi.fn();
    manager.onOrgChange(listener);

    const updated = { ...org, alias: 'renamed' };
    manager.addOrg(updated);

    expect(listener).toHaveBeenCalledWith({
      type: 'updated',
      orgId: org.id,
      org: updated,
    } satisfies OrgManagerEvent);
  });

  it('should remove an org and emit removed event', () => {
    const manager = new OrgManager();
    const org = createMockOrg();
    manager.addOrg(org);

    const listener = vi.fn();
    manager.onOrgChange(listener);

    const result = manager.removeOrg(org.id);

    expect(result).toBe(true);
    expect(manager.getOrg(org.id)).toBeUndefined();
    expect(listener).toHaveBeenCalledWith({
      type: 'removed',
      orgId: org.id,
    } satisfies OrgManagerEvent);
  });

  it('should return false when removing a non-existent org', () => {
    const manager = new OrgManager();
    const result = manager.removeOrg('nonexistent' as UUID);
    expect(result).toBe(false);
  });

  it('should return all orgs', () => {
    const manager = new OrgManager();
    const org1 = createMockOrg({ id: 'org-001' as UUID });
    const org2 = createMockOrg({ id: 'org-002' as UUID, alias: 'staging' });
    manager.addOrg(org1);
    manager.addOrg(org2);

    const all = manager.getAllOrgs();

    expect(all).toHaveLength(2);
    expect(all).toContainEqual(org1);
    expect(all).toContainEqual(org2);
  });

  it('should update org status and emit statusChanged event', () => {
    const manager = new OrgManager();
    const org = createMockOrg({ status: 'connected' });
    manager.addOrg(org);

    const listener = vi.fn();
    manager.onOrgChange(listener);

    const result = manager.updateStatus(org.id, 'expired');

    expect(result).toBe(true);
    expect(manager.getOrg(org.id)?.status).toBe('expired');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'statusChanged',
        orgId: org.id,
      }),
    );
  });

  it('should return false when updating status of non-existent org', () => {
    const manager = new OrgManager();
    const result = manager.updateStatus('nonexistent' as UUID, 'error');
    expect(result).toBe(false);
  });

  it('should find orgs by tag', () => {
    const manager = new OrgManager();
    const org1 = createMockOrg({ id: 'org-001' as UUID, tags: ['dev', 'test'] });
    const org2 = createMockOrg({ id: 'org-002' as UUID, tags: ['staging'] });
    const org3 = createMockOrg({ id: 'org-003' as UUID, tags: ['dev', 'ci'] });
    manager.addOrg(org1);
    manager.addOrg(org2);
    manager.addOrg(org3);

    const devOrgs = manager.findByTag('dev');

    expect(devOrgs).toHaveLength(2);
    expect(devOrgs.map((o) => o.id)).toContain('org-001');
    expect(devOrgs.map((o) => o.id)).toContain('org-003');
  });

  it('should return empty array for unknown tag', () => {
    const manager = new OrgManager();
    manager.addOrg(createMockOrg());
    expect(manager.findByTag('unknown')).toEqual([]);
  });

  it('should count connected orgs', () => {
    const manager = new OrgManager();
    manager.addOrg(createMockOrg({ id: 'org-001' as UUID, status: 'connected' }));
    manager.addOrg(createMockOrg({ id: 'org-002' as UUID, status: 'expired' }));
    manager.addOrg(createMockOrg({ id: 'org-003' as UUID, status: 'connected' }));

    expect(manager.connectedCount).toBe(2);
  });

  it('should clear all orgs', () => {
    const manager = new OrgManager();
    manager.addOrg(createMockOrg({ id: 'org-001' as UUID }));
    manager.addOrg(createMockOrg({ id: 'org-002' as UUID }));

    manager.clear();

    expect(manager.getAllOrgs()).toHaveLength(0);
  });

  it('should remove listener via offOrgChange', () => {
    const manager = new OrgManager();
    const listener = vi.fn();
    manager.onOrgChange(listener);
    manager.offOrgChange(listener);

    manager.addOrg(createMockOrg());

    expect(listener).not.toHaveBeenCalled();
  });

  it('should continue notifying listeners even if one throws', () => {
    const manager = new OrgManager();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const safe = vi.fn();
    manager.onOrgChange(throwing);
    manager.onOrgChange(safe);

    const org = createMockOrg();
    manager.addOrg(org);

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(safe).toHaveBeenCalledTimes(1);
  });

  it('should emit removed events when clear() is called', () => {
    const manager = new OrgManager();
    manager.addOrg(createMockOrg({ id: 'org-001' as UUID }));
    manager.addOrg(createMockOrg({ id: 'org-002' as UUID }));

    const listener = vi.fn();
    manager.onOrgChange(listener);
    listener.mockClear();

    manager.clear();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'removed', orgId: 'org-001' }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'removed', orgId: 'org-002' }),
    );
  });

  it('should dispose and clear both orgs and listeners', () => {
    const manager = new OrgManager();
    const listener = vi.fn();
    manager.onOrgChange(listener);
    manager.addOrg(createMockOrg());

    listener.mockClear();
    manager.dispose();

    expect(manager.getAllOrgs()).toHaveLength(0);
    // Listeners should be cleared, adding an org should not trigger callback
    manager.addOrg(createMockOrg());
    expect(listener).not.toHaveBeenCalled();
  });

  describe('onOrgChange unsubscribe', () => {
    it('returns an unsubscribe function that removes the listener', () => {
      const manager = new OrgManager();
      const listener = vi.fn();
      const unsub = manager.onOrgChange(listener);

      manager.addOrg(createMockOrg());
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      manager.addOrg(createMockOrg());
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('unsubscribing one listener keeps the others registered', () => {
      const manager = new OrgManager();
      const first = vi.fn();
      const second = vi.fn();
      const unsubFirst = manager.onOrgChange(first);
      manager.onOrgChange(second);

      unsubFirst();
      manager.addOrg(createMockOrg());

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
