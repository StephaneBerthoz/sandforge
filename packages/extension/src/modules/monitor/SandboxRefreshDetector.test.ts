import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { SandboxRefreshDetector } from './SandboxRefreshDetector';
import type { DetectedSandboxRefresh } from './SandboxRefreshDetector';
import { ConfigStore } from '../../core/storage/ConfigStore';
import { OrgManager } from '../../core/connection/OrgManager';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend';

/**
 * Org ids in the shape a real sandbox answers with: `Organization.Id` and the
 * identity check's `organization_id` both carry 18 characters.
 */
const REGISTERED_ORG_ID = '00DXX00000AbCdE2A1';
const REFRESHED_ORG_ID = '00Dxx00000FgHiJ3B2';

function sandbox(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: REGISTERED_ORG_ID,
    alias: 'UAT',
    username: 'admin@acme.test.uat',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: REGISTERED_ORG_ID,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function production(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return sandbox({
    id: '00Dxx00000KlMnO4C3',
    orgId: '00Dxx00000KlMnO4C3',
    alias: 'PROD',
    username: 'admin@acme.test',
    instanceUrl: 'https://acme.my.salesforce.com',
    orgType: 'Production',
    safetyTier: OrgSafetyTier.CRITICAL,
    ...overrides,
  });
}

describe('SandboxRefreshDetector', () => {
  let configStore: ConfigStore;
  let orgManager: OrgManager;
  let detector: SandboxRefreshDetector;
  let heard: DetectedSandboxRefresh[];
  let clock: Date;

  function build(): SandboxRefreshDetector {
    const built = new SandboxRefreshDetector({ configStore, orgManager, now: () => clock });
    built.onRefreshDetected((refresh) => heard.push(refresh));
    return built;
  }

  beforeEach(() => {
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    orgManager = new OrgManager();
    orgManager.addOrg(sandbox());
    heard = [];
    clock = new Date('2026-09-22T09:00:00.000Z');
    detector = build();
  });

  describe('observe', () => {
    it('records the first answer of a sandbox without reporting it', () => {
      expect(
        detector.observe(REGISTERED_ORG_ID, { organizationId: REGISTERED_ORG_ID }, 'connection'),
      ).toBeUndefined();

      expect(heard).toEqual([]);
      expect(detector.organizationIdOf(REGISTERED_ORG_ID)).toBe('00DXX00000AbCdE');
    });

    it('reports a sandbox that answers as another org than the one it was registered with', () => {
      // Imported before the refresh, used after it: the CLI reconnected the
      // same username to the new org, and nothing else said so.
      const refresh = detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REFRESHED_ORG_ID },
        'connection',
      );

      expect(refresh).toEqual({
        orgId: REGISTERED_ORG_ID,
        detectedAt: '2026-09-22T09:00:00.000Z',
        evidence: 'connection',
        previousOrganizationId: '00DXX00000AbCdE',
        organizationId: '00Dxx00000FgHiJ',
      });
      expect(heard).toEqual([refresh]);
      expect(detector.refreshesOf(REGISTERED_ORG_ID)).toEqual([refresh]);
    });

    it('reports a refresh once, however many answers name the new org', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'monitor');
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(heard).toHaveLength(1);
      expect(detector.refreshesOf(REGISTERED_ORG_ID)).toHaveLength(1);
    });

    it('never takes an answer naming a former org for a refresh back to it', () => {
      // The Monitor's org info is cached for five minutes: the row it read
      // before the refresh keeps coming back after the identity check has
      // already seen the new org.
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');
      detector.observe(REGISTERED_ORG_ID, { organizationId: REGISTERED_ORG_ID }, 'monitor');

      expect(heard).toHaveLength(1);
      expect(detector.organizationIdOf(REGISTERED_ORG_ID)).toBe('00Dxx00000FgHiJ');
    });

    it('reports every refresh of a sandbox refreshed again', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');
      clock = new Date('2026-10-20T09:00:00.000Z');
      detector.observe(REGISTERED_ORG_ID, { organizationId: '00Dxx00000PqRsT5D4' }, 'connection');

      expect(heard.map((refresh) => refresh.previousOrganizationId)).toEqual([
        '00DXX00000AbCdE',
        '00Dxx00000FgHiJ',
      ]);
      expect(detector.refreshesOf(REGISTERED_ORG_ID)[0].organizationId).toBe('00Dxx00000PqRsT');
    });

    it('compares the 15 characters an 18-character id adds a case checksum to', () => {
      detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REGISTERED_ORG_ID.slice(0, 15) },
        'connection',
      );

      expect(heard).toEqual([]);
    });

    it('keeps the instance the sandbox was on and the one it answered from after', () => {
      detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REGISTERED_ORG_ID, instanceName: 'EU42S' },
        'monitor',
      );
      const refresh = detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REFRESHED_ORG_ID, instanceName: 'EU44S' },
        'monitor',
      );

      expect(refresh?.previousInstanceName).toBe('EU42S');
      expect(refresh?.instanceName).toBe('EU44S');
      expect(refresh?.evidence).toBe('monitor');
    });

    it('does not take an instance move without a new org id for a refresh', () => {
      detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REGISTERED_ORG_ID, instanceName: 'EU42S' },
        'monitor',
      );
      detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REGISTERED_ORG_ID, instanceName: 'EU46S' },
        'monitor',
      );

      expect(heard).toEqual([]);
    });

    it('writes nothing when an answer changes nothing', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REGISTERED_ORG_ID }, 'connection');
      const set = vi.spyOn(configStore, 'set');

      for (let i = 0; i < 5; i++) {
        detector.observe(REGISTERED_ORG_ID, { organizationId: REGISTERED_ORG_ID }, 'connection');
      }

      expect(set).not.toHaveBeenCalled();
    });

    it('leaves production and scratch orgs alone', () => {
      orgManager.addOrg(production());
      orgManager.addOrg(sandbox({ id: '00Dxx00000UvWxY6E5', orgType: 'Scratch' }));

      detector.observe('00Dxx00000KlMnO4C3', { organizationId: REFRESHED_ORG_ID }, 'connection');
      detector.observe('00Dxx00000UvWxY6E5', { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(heard).toEqual([]);
      expect(detector.organizationIdOf('00Dxx00000KlMnO4C3')).toBeUndefined();
      expect(detector.organizationIdOf('00Dxx00000UvWxY6E5')).toBeUndefined();
    });

    it('takes the first answer as the baseline when the entry holds no usable org id', () => {
      // Entries written by builds that predate the org-id scheme carry none.
      orgManager.addOrg(sandbox({ orgId: '' }));

      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(heard).toEqual([]);
      expect(detector.organizationIdOf(REGISTERED_ORG_ID)).toBe('00Dxx00000FgHiJ');
    });

    it('ignores an answer that is not an org id', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: 'not-an-org' }, 'connection');

      expect(heard).toEqual([]);
      expect(detector.organizationIdOf(REGISTERED_ORG_ID)).toBeUndefined();
    });

    it('remembers across a restart what the sandbox answered last', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      const restarted = build();
      restarted.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(heard).toHaveLength(1);
      expect(restarted.refreshesOf(REGISTERED_ORG_ID)).toHaveLength(1);
    });

    it('starts over from the registered org id when its record cannot be read', () => {
      configStore.set(
        `sandbox-refresh:${REGISTERED_ORG_ID}`,
        { organizationId: 42 },
        'sandbox-refresh',
      );

      const refresh = detector.observe(
        REGISTERED_ORG_ID,
        { organizationId: REFRESHED_ORG_ID },
        'connection',
      );

      expect(refresh?.previousOrganizationId).toBe('00DXX00000AbCdE');
    });

    it('still tells the other listeners when one of them throws', () => {
      const log = vi.fn();
      const withLog = new SandboxRefreshDetector({ configStore, orgManager, log });
      const second = vi.fn();
      withLog.onRefreshDetected(() => {
        throw new Error('listener down');
      });
      withLog.onRefreshDetected(second);

      const refresh = withLog.observe(
        REGISTERED_ORG_ID,
        { organizationId: REFRESHED_ORG_ID },
        'connection',
      );

      expect(refresh).toBeDefined();
      expect(second).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('listener down'));
    });

    it('stops telling a listener that unsubscribed', () => {
      const listener = vi.fn();
      const stop = detector.onRefreshDetected(listener);
      stop();

      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('noteCompletedRefresh', () => {
    /** A SandboxProcess row as the production org's tracker hands it over. */
    function completed(sandboxName: string, refreshDate = '2026-09-21T18:30:00.000+0000') {
      return {
        orgId: '00Dxx00000KlMnO4C3',
        sandboxName,
        refreshDate,
        status: 'Completed' as const,
      };
    }

    beforeEach(() => {
      orgManager.addOrg(production());
    });

    it('records the refresh on the registered sandbox the production org names', () => {
      const [refresh] = detector.noteCompletedRefresh(completed('UAT'));

      expect(refresh).toEqual({
        orgId: REGISTERED_ORG_ID,
        detectedAt: '2026-09-22T09:00:00.000Z',
        evidence: 'production',
        sandboxName: 'UAT',
        reportedBy: '00Dxx00000KlMnO4C3',
      });
      expect(heard).toEqual([refresh]);
    });

    it('completes the report when the sandbox answers, without telling twice', () => {
      detector.noteCompletedRefresh(completed('uat'));

      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(heard).toHaveLength(1);
      const [refresh] = detector.refreshesOf(REGISTERED_ORG_ID);
      expect(refresh.evidence).toBe('production');
      expect(refresh.previousOrganizationId).toBe('00DXX00000AbCdE');
      expect(refresh.organizationId).toBe('00Dxx00000FgHiJ');
      expect(detector.refreshesOf(REGISTERED_ORG_ID)).toHaveLength(1);
    });

    it('matches on the username a sandbox copy receives when the My Domain says nothing', () => {
      orgManager.addOrg(sandbox({ instanceUrl: 'https://cs42.salesforce.com' }));

      expect(detector.noteCompletedRefresh(completed('uat'))).toHaveLength(1);
    });

    it('does not take the sandbox of another production org for this one', () => {
      orgManager.addOrg(
        sandbox({
          instanceUrl: 'https://globex--uat.sandbox.my.salesforce.com',
          username: 'admin@globex.test.uat',
        }),
      );

      expect(detector.noteCompletedRefresh(completed('uat'))).toEqual([]);
      expect(heard).toEqual([]);
    });

    it('does not report again a refresh the sandbox has already told', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      detector.noteCompletedRefresh(completed('uat', '2026-09-21T18:30:00.000+0000'));

      expect(heard).toHaveLength(1);
      expect(detector.refreshesOf(REGISTERED_ORG_ID)).toHaveLength(1);
    });

    it('reports nothing for a production org it does not know', () => {
      expect(
        detector.noteCompletedRefresh({ ...completed('uat'), orgId: '00Dxx00000ZzZzZ7F6' }),
      ).toEqual([]);
    });
  });

  describe('wasRefreshedTo', () => {
    it('names the org a refresh the sandbox answered for made it, in either id form', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(detector.wasRefreshedTo(REGISTERED_ORG_ID, REFRESHED_ORG_ID)).toBe(true);
      expect(detector.wasRefreshedTo(REGISTERED_ORG_ID, REFRESHED_ORG_ID.slice(0, 15))).toBe(true);
    });

    it('does not name the org the sandbox was, nor any other one', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      expect(detector.wasRefreshedTo(REGISTERED_ORG_ID, REGISTERED_ORG_ID)).toBe(false);
      expect(detector.wasRefreshedTo(REGISTERED_ORG_ID, '00Dxx00000ZzZzZ7F6')).toBe(false);
    });

    it('names no org for a refresh only the production history reported', () => {
      orgManager.addOrg(production());
      detector.noteCompletedRefresh({
        orgId: '00Dxx00000KlMnO4C3',
        sandboxName: 'uat',
        refreshDate: '2026-09-21T18:30:00.000+0000',
        status: 'Completed',
      });

      expect(detector.wasRefreshedTo(REGISTERED_ORG_ID, REFRESHED_ORG_ID)).toBe(false);
    });

    it('names no org for a sandbox never seen refreshed', () => {
      detector.observe(REGISTERED_ORG_ID, { organizationId: REGISTERED_ORG_ID }, 'connection');

      expect(detector.wasRefreshedTo(REGISTERED_ORG_ID, REGISTERED_ORG_ID)).toBe(false);
      expect(detector.wasRefreshedTo('not-registered', REFRESHED_ORG_ID)).toBe(false);
    });
  });
});
