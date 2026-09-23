import { describe, it, expect } from 'vitest';
import { getQueryLimits, getDefaultQueryLimit, resolveOrgTier } from './queryLimits';

describe('queryLimits', () => {
  describe('getQueryLimits', () => {
    it('should return sandbox limits for sandbox tier', () => {
      const limits = getQueryLimits('sandbox');
      expect(limits.defaultQueryLimit).toBe(2000);
      expect(limits.previewQueryLimit).toBe(2000);
      expect(limits.exportQueryLimit).toBe(5000);
    });

    it('should return production limits for production tier', () => {
      const limits = getQueryLimits('production');
      expect(limits.defaultQueryLimit).toBe(500);
      expect(limits.previewQueryLimit).toBe(200);
      expect(limits.exportQueryLimit).toBe(1000);
    });

    it.each(['sandbox', 'production'] as const)(
      'gives the %s tier no permission set limit, which no query reads any more',
      (tier) => {
        // Compare's Permissions tab pages through every row of both orgs: a
        // LIMIT with no ORDER BY handed back a different slice of each.
        expect(getQueryLimits(tier)).not.toHaveProperty('permissionSetLimit');
      },
    );

    it('should return a copy, not the original object', () => {
      const limits1 = getQueryLimits('sandbox');
      const limits2 = getQueryLimits('sandbox');
      expect(limits1).not.toBe(limits2);
      expect(limits1).toEqual(limits2);
    });
  });

  describe('getDefaultQueryLimit', () => {
    it('should return 2000 for sandbox', () => {
      expect(getDefaultQueryLimit('sandbox')).toBe(2000);
    });

    it('should return 500 for production', () => {
      expect(getDefaultQueryLimit('production')).toBe(500);
    });
  });

  describe('resolveOrgTier', () => {
    it('should return sandbox when isSandbox is true', () => {
      expect(resolveOrgTier(true)).toBe('sandbox');
    });

    it('should return production when isSandbox is false', () => {
      expect(resolveOrgTier(false)).toBe('production');
    });
  });
});
