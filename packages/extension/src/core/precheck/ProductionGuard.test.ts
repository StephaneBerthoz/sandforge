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

  describe('audit log', () => {
    it('should start with an empty audit log', () => {
      expect(guard.getAuditLog()).toHaveLength(0);
    });

    it('should record operations via logOperation', () => {
      const request = createRequest({ orgTier: 'production', operation: 'insert' });
      const result = guard.check(request);

      guard.logOperation(request, result);

      const log = guard.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].request).toEqual(request);
      expect(log[0].result).toEqual(result);
      expect(log[0].timestamp).toBeTruthy();
    });

    it('should record multiple operations in order', () => {
      const req1 = createRequest({ operation: 'insert', orgTier: 'production' });
      const req2 = createRequest({ operation: 'update', orgTier: 'staging' });

      guard.logOperation(req1, guard.check(req1));
      guard.logOperation(req2, guard.check(req2));

      const log = guard.getAuditLog();
      expect(log).toHaveLength(2);
      expect(log[0].request.operation).toBe('insert');
      expect(log[1].request.operation).toBe('update');
    });

    it('should return a copy of the audit log (not a reference)', () => {
      const request = createRequest({ orgTier: 'development' });
      const result = guard.check(request);
      guard.logOperation(request, result);

      const log1 = guard.getAuditLog();
      const log2 = guard.getAuditLog();

      expect(log1).toEqual(log2);
      expect(log1).not.toBe(log2);
    });

    it('should include ISO timestamp in audit entries', () => {
      const request = createRequest({ orgTier: 'scratch' });
      const result = guard.check(request);
      guard.logOperation(request, result);

      const log = guard.getAuditLog();
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
      expect(isoRegex.test(log[0].timestamp)).toBe(true);
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

    it('logOperation is a no-op when auditLogging is disabled', () => {
      const noAuditGuard = new ProductionGuard({ isAuditLoggingEnabled: () => false });
      const request = createRequest({ orgTier: 'production', operation: 'insert' });
      noAuditGuard.logOperation(request, noAuditGuard.check(request));
      expect(noAuditGuard.getAuditLog()).toHaveLength(0);
    });

    it('logOperation reads the auditLogging flag at call time', () => {
      let enabled = false;
      const togglable = new ProductionGuard({ isAuditLoggingEnabled: () => enabled });
      const request = createRequest();
      togglable.logOperation(request, togglable.check(request));
      expect(togglable.getAuditLog()).toHaveLength(0);
      enabled = true;
      togglable.logOperation(request, togglable.check(request));
      expect(togglable.getAuditLog()).toHaveLength(1);
    });

    it('audit log is capped at 1000 entries with FIFO eviction', () => {
      const request = createRequest();
      const result = guard.check(request);
      for (let i = 0; i < 1100; i++) {
        guard.logOperation(request, result);
      }
      const log = guard.getAuditLog();
      expect(log).toHaveLength(1000);
    });

    it('confirmIfNeeded returns true when confirmation not required', async () => {
      const result = guard.check(createRequest({ orgTier: 'development' }));
      await expect(guard.confirmIfNeeded(result)).resolves.toBe(true);
    });

    it('confirmIfNeeded returns false when check disallows the operation', async () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'delete' }));
      await expect(guard.confirmIfNeeded(result)).resolves.toBe(false);
    });

    it('confirmIfNeeded proceeds when no confirmation UI is wired', async () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(guard.confirmIfNeeded(result)).resolves.toBe(true);
    });

    it('confirmIfNeeded delegates to requestConfirmation and honors refusal', async () => {
      const confirm = vi.fn().mockResolvedValue(false);
      const uiGuard = new ProductionGuard({ requestConfirmation: confirm });
      const result = uiGuard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(uiGuard.confirmIfNeeded(result)).resolves.toBe(false);
      expect(confirm).toHaveBeenCalledWith(result.impactSummary);
    });

    it('confirmIfNeeded honors user acceptance', async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      const uiGuard = new ProductionGuard({ requestConfirmation: confirm });
      const result = uiGuard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(uiGuard.confirmIfNeeded(result)).resolves.toBe(true);
    });
  });
});
