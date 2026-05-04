import { describe, it, expect, vi } from 'vitest';
import { OrgStatusCheck } from './OrgStatusCheck';
import type { FetchOrgStatusFn, OrgStatusData } from './OrgStatusCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['org_status'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createOrgStatus(overrides?: Partial<OrgStatusData>): OrgStatusData {
  return {
    isMaintenanceScheduled: false,
    isSandboxRefreshInProgress: false,
    isReadOnly: false,
    isDeploymentInProgress: false,
    instanceName: 'CS42',
    orgType: 'sandbox',
    ...overrides,
  };
}

describe('OrgStatusCheck', () => {
  describe('check', () => {
    it('should return 4 items for all status checks', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(createOrgStatus());
      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(4);
    });

    it('should pass all checks when org is healthy', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(createOrgStatus());
      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.passed).toBe(true);
        expect(item.severity).toBe('info');
      }
    });

    it('should blocker when maintenance is scheduled', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(
        createOrgStatus({
          isMaintenanceScheduled: true,
          maintenanceWindow: { start: '2026-02-20T02:00:00Z', end: '2026-02-20T06:00:00Z' },
        }),
      );

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const maintItem = items.find((i) => i.name === 'Scheduled Maintenance');

      expect(maintItem?.passed).toBe(false);
      expect(maintItem?.severity).toBe('blocker');
      expect(maintItem?.message).toContain('2026-02-20T02:00:00Z');
    });

    it('should blocker when sandbox refresh is in progress', async () => {
      const fetchFn: FetchOrgStatusFn = vi
        .fn()
        .mockResolvedValue(createOrgStatus({ isSandboxRefreshInProgress: true }));

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const refreshItem = items.find((i) => i.name === 'Sandbox Refresh');

      expect(refreshItem?.passed).toBe(false);
      expect(refreshItem?.severity).toBe('blocker');
    });

    it('should blocker when org is in read-only mode', async () => {
      const fetchFn: FetchOrgStatusFn = vi
        .fn()
        .mockResolvedValue(createOrgStatus({ isReadOnly: true }));

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const roItem = items.find((i) => i.name === 'Read-Only Mode');

      expect(roItem?.passed).toBe(false);
      expect(roItem?.severity).toBe('blocker');
    });

    it('should warn when deployment is in progress', async () => {
      const fetchFn: FetchOrgStatusFn = vi
        .fn()
        .mockResolvedValue(createOrgStatus({ isDeploymentInProgress: true }));

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const deployItem = items.find((i) => i.name === 'Deployment In Progress');

      expect(deployItem?.passed).toBe(false);
      expect(deployItem?.severity).toBe('warning');
    });

    it('should pass deployment check when no deployment', async () => {
      const fetchFn: FetchOrgStatusFn = vi
        .fn()
        .mockResolvedValue(createOrgStatus({ isDeploymentInProgress: false }));

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const deployItem = items.find((i) => i.name === 'Deployment In Progress');

      expect(deployItem?.passed).toBe(true);
      expect(deployItem?.severity).toBe('info');
    });

    it('should include instance name in maintenance message', async () => {
      const fetchFn: FetchOrgStatusFn = vi
        .fn()
        .mockResolvedValue(createOrgStatus({ instanceName: 'NA99' }));

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const maintItem = items.find((i) => i.name === 'Scheduled Maintenance');

      expect(maintItem?.message).toContain('NA99');
    });

    it('should set all items to category org_status', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(createOrgStatus());
      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('org_status');
      }
    });

    it('should call fetchOrgStatus with correct orgId', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(createOrgStatus());
      const checker = new OrgStatusCheck(fetchFn);
      await checker.check(createConfig({ targetOrgId: 'org-abc' }));

      expect(fetchFn).toHaveBeenCalledWith('org-abc');
    });

    it('should mark all items as not autoFixable', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(
        createOrgStatus({
          isMaintenanceScheduled: true,
          isReadOnly: true,
          isDeploymentInProgress: true,
        }),
      );

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should handle maintenance without window gracefully', async () => {
      const fetchFn: FetchOrgStatusFn = vi
        .fn()
        .mockResolvedValue(createOrgStatus({ isMaintenanceScheduled: true }));

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());
      const maintItem = items.find((i) => i.name === 'Scheduled Maintenance');

      expect(maintItem?.message).toContain('unknown');
    });

    it('should handle multiple blockers simultaneously', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(
        createOrgStatus({
          isMaintenanceScheduled: true,
          isSandboxRefreshInProgress: true,
          isReadOnly: true,
        }),
      );

      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());

      const blockers = items.filter((i) => i.severity === 'blocker');
      expect(blockers).toHaveLength(3);
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchOrgStatusFn = vi.fn().mockResolvedValue(createOrgStatus());
      const checker = new OrgStatusCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = new Set(items.map((i) => i.id));
      expect(ids.size).toBe(items.length);
    });
  });
});
