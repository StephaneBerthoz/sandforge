import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProductionGuard } from './ProductionGuard';
import type { OperationRequest } from './ProductionGuard';

function createRequest(overrides?: Partial<OperationRequest>): OperationRequest {
  return {
    orgId: 'org-001',
    orgTier: 'development',
    operation: 'insert',
    objectName: 'Account',
    recordCount: 100,
    module: 'sync',
    ...overrides,
  };
}

describe('ProductionGuard', () => {
  let guard: ProductionGuard;

  beforeEach(() => {
    guard = new ProductionGuard();
  });

  describe('production tier rules', () => {
    it('should block DELETE on production', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toContain('delete');
      expect(result.blockedReason).toContain('org-001');
    });

    it('should block hardDelete on production', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'hardDelete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toContain('hardDelete');
    });

    it('should allow INSERT on production with confirmation', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should allow UPDATE on production with confirmation', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'update',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should allow UPSERT on production with confirmation', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'upsert',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should require approval for > 1000 records on production', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
        recordCount: 1001,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('should not require approval for <= 1000 records on production', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
        recordCount: 1000,
      });

      const result = guard.check(request);

      expect(result.requiresApproval).toBe(false);
    });

    it('should always add a production warning', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'update',
      });

      const result = guard.check(request);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Production');
    });

    it('should allow DELETE on production when override is set', () => {
      guard.setProductionOverride('org-001', true);

      const request = createRequest({
        orgTier: 'production',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.warnings.some((w) => w.includes('override'))).toBe(true);
    });

    it('should block DELETE after override is removed', () => {
      guard.setProductionOverride('org-001', true);
      guard.setProductionOverride('org-001', false);

      const request = createRequest({
        orgTier: 'production',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(false);
    });
  });

  describe('staging tier rules', () => {
    it('should allow INSERT on staging without confirmation for small counts', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'insert',
        recordCount: 100,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should require confirmation for DELETE on staging', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should require confirmation for > 10000 records on staging', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'update',
        recordCount: 10_001,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.warnings.some((w) => w.includes('Large volume'))).toBe(true);
    });

    it('should not require confirmation for <= 10000 non-destructive records on staging', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'insert',
        recordCount: 10_000,
      });

      const result = guard.check(request);

      expect(result.requiresConfirmation).toBe(false);
    });
  });

  describe('development and scratch tier rules', () => {
    it('should allow all operations on development without confirmation', () => {
      const request = createRequest({
        orgTier: 'development',
        operation: 'hardDelete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
      expect(result.requiresApproval).toBe(false);
    });

    it('should allow all operations on scratch without confirmation', () => {
      const request = createRequest({
        orgTier: 'scratch',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should warn for > 50000 records on development', () => {
      const request = createRequest({
        orgTier: 'development',
        operation: 'insert',
        recordCount: 50_001,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.warnings.some((w) => w.includes('Large volume'))).toBe(true);
    });

    it('should not warn for <= 50000 records on development', () => {
      const request = createRequest({
        orgTier: 'development',
        operation: 'insert',
        recordCount: 50_000,
      });

      const result = guard.check(request);

      expect(result.warnings).toHaveLength(0);
    });

    it('should warn for > 50000 records on scratch', () => {
      const request = createRequest({
        orgTier: 'scratch',
        operation: 'upsert',
        recordCount: 100_000,
      });

      const result = guard.check(request);

      expect(result.warnings.some((w) => w.includes('100000'))).toBe(true);
    });
  });

  describe('metadata deployments', () => {
    const deploy = (overrides?: Partial<OperationRequest>): OperationRequest =>
      createRequest({
        operation: 'deploy',
        objectName: 'ApexClass, Layout',
        recordCount: 3,
        module: 'compare',
        ...overrides,
      });

    it('refuses a deployment to a production org', () => {
      const result = guard.check(deploy({ orgTier: 'production' }));

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toContain('deploy is not allowed on production org org-001');
      expect(result.blockedReason).toContain('sandboxes only');
    });

    it('refuses it even with a production override, which lifts only the delete block', () => {
      guard.setProductionOverride('org-001', true);

      expect(guard.check(deploy({ orgTier: 'production' })).allowed).toBe(false);
    });

    it('asks for a confirmation on a staging org, whatever the count', () => {
      const result = guard.check(deploy({ orgTier: 'staging', recordCount: 1 }));

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.warnings).toContain(
        'Metadata deployment on staging org — confirmation required',
      );
    });

    it('lets a sandbox or a scratch org take one without a confirmation', () => {
      for (const orgTier of ['development', 'scratch'] as const) {
        const result = guard.check(deploy({ orgTier }));
        expect(result.allowed).toBe(true);
        expect(result.requiresConfirmation).toBe(false);
      }
    });

    it('counts components, not records, in what it says', () => {
      const result = guard.check(deploy({ orgTier: 'production' }));

      expect(result.impactSummary).toBe(
        'DEPLOY 3 component(s) (ApexClass, Layout) to production org org-001 [module: compare]',
      );
      expect(result.warnings[0]).toBe(
        'Production operation: deploy on ApexClass, Layout (3 components)',
      );
    });
  });

  describe('impactSummary', () => {
    it('should include operation, count, object, tier, orgId, and module', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'update',
        objectName: 'Contact',
        recordCount: 500,
        orgId: 'org-prod-42',
        module: 'seed',
      });

      const result = guard.check(request);

      expect(result.impactSummary).toContain('UPDATE');
      expect(result.impactSummary).toContain('500');
      expect(result.impactSummary).toContain('Contact');
      expect(result.impactSummary).toContain('production');
      expect(result.impactSummary).toContain('org-prod-42');
      expect(result.impactSummary).toContain('seed');
    });

    it('reads an uncounted request as unknown, in the summary and in the warning', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account, Contact',
        recordCount: 'unknown',
      });

      const result = guard.check(request);

      expect(result.impactSummary).toContain('unknown number of Account, Contact record(s)');
      expect(result.impactSummary).not.toContain('INSERT 0');
      expect(result.warnings[0]).toContain('an unknown number of records');
      expect(result.warnings[0]).not.toContain('(0 records)');
    });

    it('spells out a measured count of zero as zero', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        recordCount: 0,
      });

      const result = guard.check(request);

      expect(result.impactSummary).toContain('INSERT 0 Account record(s)');
      expect(result.impactSummary).not.toContain('unknown');
      expect(result.warnings[0]).toContain('(0 records)');
    });

    it('keeps an uncounted request below the production approval threshold', () => {
      const result = guard.check(
        createRequest({ orgTier: 'production', operation: 'insert', recordCount: 'unknown' }),
      );

      expect(result.requiresApproval).toBe(false);
    });

    it('does not warn about volume on staging or development when the count is unknown', () => {
      const staging = guard.check(createRequest({ orgTier: 'staging', recordCount: 'unknown' }));
      const dev = guard.check(createRequest({ orgTier: 'development', recordCount: 'unknown' }));

      expect(staging.requiresConfirmation).toBe(false);
      expect(staging.warnings).toEqual([]);
      expect(dev.warnings).toEqual([]);
    });

    it('says a count known only at most is at most, in the summary and in the warning', () => {
      // A clone of one record is counted by the tables of its objects: the
      // number is the most it can write, not what it writes.
      const result = guard.check(
        createRequest({
          orgTier: 'production',
          operation: 'insert',
          objectName: 'Account, Case',
          recordCount: { atMost: 60 },
        }),
      );

      expect(result.impactSummary).toBe(
        'INSERT at most 60 Account, Case record(s) on production org org-001 [module: sync]',
      );
      expect(result.warnings[0]).toBe(
        'Production operation: insert on Account, Case (at most 60 records)',
      );
    });

    it('says what an operation writes besides the records it counts, in the summary and in the warning', () => {
      // A clone of one record also writes the catalog and the parents its
      // records name: without this, "at most 60" read as a bound on the run.
      const result = guard.check(
        createRequest({
          orgTier: 'production',
          operation: 'insert',
          objectName: 'Account, Case',
          recordCount: { atMost: 60 },
          alsoWrites: 'the related records the run adds',
        }),
      );

      expect(result.impactSummary).toBe(
        'INSERT at most 60 Account, Case record(s), plus the related records the run adds, on production org org-001 [module: sync]',
      );
      expect(result.warnings[0]).toBe(
        'Production operation: insert on Account, Case (at most 60 records, plus the related records the run adds)',
      );
    });

    it('measures the volume thresholds against the most a run can write, and says it is a most', () => {
      const staging = guard.check(
        createRequest({ orgTier: 'staging', recordCount: { atMost: 12_000 } }),
      );
      const dev = guard.check(
        createRequest({ orgTier: 'development', recordCount: { atMost: 60_000 } }),
      );
      const production = guard.check(
        createRequest({ orgTier: 'production', recordCount: { atMost: 1_500 } }),
      );

      expect(staging.requiresConfirmation).toBe(true);
      expect(staging.warnings).toEqual([
        'Large volume operation: at most 12000 records on staging',
      ]);
      expect(dev.warnings).toEqual([
        'Large volume operation: at most 60000 records on development org',
      ]);
      expect(production.requiresApproval).toBe(true);
    });

    it('asks nothing of a staging run whose most stays under the threshold', () => {
      const staging = guard.check(
        createRequest({ orgTier: 'staging', recordCount: { atMost: 500 } }),
      );

      expect(staging.requiresConfirmation).toBe(false);
      expect(staging.warnings).toEqual([]);
    });
  });

  describe('setProductionOverride / isProductionOverridden', () => {
    it('should return false for orgs without override', () => {
      expect(guard.isProductionOverridden('unknown-org')).toBe(false);
    });

    it('should return true after override is set', () => {
      guard.setProductionOverride('org-001', true);

      expect(guard.isProductionOverridden('org-001')).toBe(true);
    });

    it('should return false after override is revoked', () => {
      guard.setProductionOverride('org-001', true);
      guard.setProductionOverride('org-001', false);

      expect(guard.isProductionOverridden('org-001')).toBe(false);
    });

    it('should track overrides independently per org', () => {
      guard.setProductionOverride('org-A', true);
      guard.setProductionOverride('org-B', false);

      expect(guard.isProductionOverridden('org-A')).toBe(true);
      expect(guard.isProductionOverridden('org-B')).toBe(false);
    });
  });

  describe('safety settings wiring', () => {
    it('requiresConfirmation follows isProdConfirmationRequired=false', () => {
      const noConfirmGuard = new ProductionGuard({ isProdConfirmationRequired: () => false });
      const result = noConfirmGuard.check(
        createRequest({ orgTier: 'production', operation: 'insert' }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('requiresConfirmation stays true by default (no options)', () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      expect(result.requiresConfirmation).toBe(true);
    });

    it('confirmIfNeeded returns true when confirmation not required', async () => {
      const result = guard.check(createRequest({ orgTier: 'development' }));
      await expect(guard.confirmIfNeeded(result, 'development')).resolves.toBe(true);
    });

    it('confirmIfNeeded returns false when check disallows the operation', async () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'delete' }));
      await expect(guard.confirmIfNeeded(result, 'production')).resolves.toBe(false);
    });

    it('confirmIfNeeded proceeds when no confirmation UI is wired', async () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(guard.confirmIfNeeded(result, 'production')).resolves.toBe(true);
    });

    it('confirmIfNeeded delegates to requestConfirmation and honors refusal', async () => {
      const confirm = vi.fn().mockResolvedValue(false);
      const uiGuard = new ProductionGuard({ requestConfirmation: confirm });
      const result = uiGuard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(uiGuard.confirmIfNeeded(result, 'production')).resolves.toBe(false);
      expect(confirm).toHaveBeenCalledWith(result.impactSummary, 'production');
    });

    it('confirmIfNeeded honors user acceptance', async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      const uiGuard = new ProductionGuard({ requestConfirmation: confirm });
      const result = uiGuard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(uiGuard.confirmIfNeeded(result, 'production')).resolves.toBe(true);
    });
  });
});
