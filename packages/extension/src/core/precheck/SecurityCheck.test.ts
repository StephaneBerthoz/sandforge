import { describe, it, expect, vi } from 'vitest';
import { SecurityCheck } from './SecurityCheck';
import type { FetchSecurityInfoFn, OrgSecurityInfo } from './SecurityCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['security'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createSecurityInfo(overrides?: Partial<OrgSecurityInfo>): OrgSecurityInfo {
  return {
    orgType: 'sandbox',
    safetyTier: 'low',
    sensitiveFields: [],
    gdprFields: [],
    ...overrides,
  };
}

describe('SecurityCheck', () => {
  describe('check', () => {
    it('should return items and empty confirmations for safe sandbox', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(createSecurityInfo());
      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.confirmations).toHaveLength(0);
    });

    it('should pass safety tier for low tier sandbox', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ safetyTier: 'low' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const tierItem = result.items.find((i) => i.name === 'Safety Tier');

      expect(tierItem?.passed).toBe(true);
      expect(tierItem?.severity).toBe('info');
    });

    it('should warn for high safety tier', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ safetyTier: 'high' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const tierItem = result.items.find((i) => i.name === 'Safety Tier');

      expect(tierItem?.severity).toBe('warning');
    });

    it('should error for critical safety tier', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ safetyTier: 'critical' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const tierItem = result.items.find((i) => i.name === 'Safety Tier');

      expect(tierItem?.passed).toBe(false);
      expect(tierItem?.severity).toBe('error');
    });

    it('should detect sensitive fields', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(
        createSecurityInfo({
          sensitiveFields: [
            { objectApiName: 'Contact', fieldApiName: 'SSN__c', sensitivityType: 'pii' },
          ],
        }),
      );

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const sensItem = result.items.find((i) => i.name.includes('Sensitive field'));

      expect(sensItem?.severity).toBe('warning');
      expect(sensItem?.message).toContain('pii');
    });

    it('should pass when no sensitive fields', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ sensitiveFields: [] }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const sensItem = result.items.find((i) => i.name === 'Sensitive Data Detection');

      expect(sensItem?.passed).toBe(true);
      expect(sensItem?.severity).toBe('info');
    });

    it('should detect GDPR fields', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(
        createSecurityInfo({
          gdprFields: [
            { objectApiName: 'Contact', fieldApiName: 'Email', gdprClassification: 'personal' },
          ],
        }),
      );

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const gdprItem = result.items.find((i) => i.name.includes('GDPR field'));

      expect(gdprItem?.severity).toBe('warning');
      expect(gdprItem?.message).toContain('personal');
    });

    it('should add confirmation for GDPR fields', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(
        createSecurityInfo({
          gdprFields: [
            { objectApiName: 'Contact', fieldApiName: 'Email', gdprClassification: 'personal' },
          ],
        }),
      );

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      const gdprConfirm = result.confirmations.find((c) => c.title === 'GDPR Data Detected');
      expect(gdprConfirm).toBeDefined();
      expect(gdprConfirm?.severity).toBe('warning');
    });

    it('should require confirmation for production org', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ orgType: 'production', safetyTier: 'medium' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      const prodConfirm = result.confirmations.find((c) => c.title === 'Production Org Operation');
      expect(prodConfirm).toBeDefined();
      expect(prodConfirm?.requiresTypedConfirmation).toBe(false);
    });

    it('should require typed confirmation for critical production org', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ orgType: 'production', safetyTier: 'critical' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      const prodConfirm = result.confirmations.find((c) => c.title === 'Production Org Operation');
      expect(prodConfirm).toBeDefined();
      expect(prodConfirm?.requiresTypedConfirmation).toBe(true);
      expect(prodConfirm?.confirmationText).toBe('I understand the risks');
    });

    it('should not require production confirmation for sandbox', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ orgType: 'sandbox' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      const prodConfirm = result.confirmations.find((c) => c.title === 'Production Org Operation');
      expect(prodConfirm).toBeUndefined();
    });

    it('should pass production guard for non-production org', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ orgType: 'scratch' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());
      const guardItem = result.items.find((i) => i.name === 'Production Guard');

      expect(guardItem?.passed).toBe(true);
      expect(guardItem?.severity).toBe('info');
    });

    it('should add sensitive data confirmation for production with sensitive fields', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(
        createSecurityInfo({
          orgType: 'production',
          safetyTier: 'medium',
          sensitiveFields: [
            { objectApiName: 'Contact', fieldApiName: 'SSN__c', sensitivityType: 'pii' },
          ],
        }),
      );

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      const sensConfirm = result.confirmations.find(
        (c) => c.title === 'Sensitive Data in Production',
      );
      expect(sensConfirm).toBeDefined();
    });

    it('should set all items to category security', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(
        createSecurityInfo({
          sensitiveFields: [
            { objectApiName: 'Contact', fieldApiName: 'SSN__c', sensitivityType: 'pii' },
          ],
        }),
      );

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      for (const item of result.items) {
        expect(item.category).toBe('security');
      }
    });

    it('should call fetchSecurityInfo with correct parameters', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(createSecurityInfo());
      const config = createConfig({
        targetOrgId: 'org-sec',
        operationConfig: { mask: true },
      });

      const checker = new SecurityCheck(fetchFn);
      await checker.check(config);

      expect(fetchFn).toHaveBeenCalledWith('org-sec', { mask: true });
    });

    it('should mark all items as not autoFixable', async () => {
      const fetchFn: FetchSecurityInfoFn = vi
        .fn()
        .mockResolvedValue(createSecurityInfo({ orgType: 'production', safetyTier: 'critical' }));

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      for (const item of result.items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchSecurityInfoFn = vi.fn().mockResolvedValue(
        createSecurityInfo({
          sensitiveFields: [
            { objectApiName: 'Contact', fieldApiName: 'SSN__c', sensitivityType: 'pii' },
            { objectApiName: 'Account', fieldApiName: 'Revenue', sensitivityType: 'financial' },
          ],
          gdprFields: [
            { objectApiName: 'Contact', fieldApiName: 'Email', gdprClassification: 'personal' },
          ],
        }),
      );

      const checker = new SecurityCheck(fetchFn);
      const result = await checker.check(createConfig());

      const ids = new Set(result.items.map((i) => i.id));
      expect(ids.size).toBe(result.items.length);
    });
  });
});
