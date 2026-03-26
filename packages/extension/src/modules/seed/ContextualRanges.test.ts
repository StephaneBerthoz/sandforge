import { describe, it, expect } from 'vitest';
import { getAmountRange, getDateRange, generateDateFromRange } from './ContextualRanges';

describe('ContextualRanges', () => {
  describe('getAmountRange', () => {
    it('should return 5000-500000 for Opportunity.Amount', () => {
      const range = getAmountRange('Opportunity', 'Amount');
      expect(range.min).toBe(5000);
      expect(range.max).toBe(500000);
      expect(range.decimals).toBe(2);
    });

    it('should return 100000+ for Account.AnnualRevenue', () => {
      const range = getAmountRange('Account', 'AnnualRevenue');
      expect(range.min).toBe(100000);
      expect(range.max).toBe(10000000);
      expect(range.decimals).toBe(0);
    });

    it('should return fallback range for unknown currency field', () => {
      const range = getAmountRange('CustomObj__c', 'RandomCurrency__c');
      expect(range.min).toBe(100);
      expect(range.max).toBe(50000);
      expect(range.decimals).toBe(2);
    });

    it('should match Quantity pattern case-insensitively', () => {
      const range = getAmountRange('Order', 'Quantity');
      expect(range.min).toBe(1);
      expect(range.max).toBe(1000);
      expect(range.decimals).toBe(0);
    });

    it('should match Discount pattern', () => {
      const range = getAmountRange('OpportunityLineItem', 'Discount');
      expect(range.min).toBe(0);
      expect(range.max).toBe(100);
      expect(range.decimals).toBe(1);
    });

    it('should match Percent pattern', () => {
      const range = getAmountRange('CustomObj__c', 'CompletionPercent__c');
      expect(range.min).toBe(0);
      expect(range.max).toBe(100);
    });

    it('should match NumberOfEmployees', () => {
      const range = getAmountRange('Account', 'NumberOfEmployees');
      expect(range.min).toBe(1);
      expect(range.max).toBe(50000);
      expect(range.decimals).toBe(0);
    });

    it('should prefer exact match over pattern match', () => {
      const range = getAmountRange('OpportunityLineItem', 'UnitPrice');
      expect(range.min).toBe(50);
      expect(range.max).toBe(5000);
    });

    it('should match Price pattern for generic price fields', () => {
      const range = getAmountRange('Product2', 'UnitPrice');
      // Product2.UnitPrice is not in exact matches, so pattern match wins
      expect(range.min).toBe(10);
      expect(range.max).toBe(10000);
    });
  });

  describe('getDateRange', () => {
    it('should return future dates for Opportunity.CloseDate', () => {
      const range = getDateRange('Opportunity', 'CloseDate');
      expect(range.minDaysFromNow).toBeGreaterThan(0);
      expect(range.maxDaysFromNow).toBe(180);
    });

    it('should return past dates for Contact.Birthdate', () => {
      const range = getDateRange('Contact', 'Birthdate');
      expect(range.maxDaysFromNow).toBeLessThan(0);
      expect(range.minDaysFromNow).toBeLessThan(range.maxDaysFromNow);
    });

    it('should return fallback for unknown date field', () => {
      const range = getDateRange('CustomObj__c', 'RandomDate__c');
      expect(range.minDaysFromNow).toBe(-90);
      expect(range.maxDaysFromNow).toBe(90);
    });

    it('should match StartDate pattern', () => {
      const range = getDateRange('Contract', 'StartDate');
      expect(range.minDaysFromNow).toBe(-30);
      expect(range.maxDaysFromNow).toBe(90);
    });

    it('should match EndDate pattern', () => {
      const range = getDateRange('Contract', 'EndDate');
      expect(range.minDaysFromNow).toBe(30);
      expect(range.maxDaysFromNow).toBe(365);
    });

    it('should match DueDate pattern', () => {
      const range = getDateRange('Task', 'DueDate');
      expect(range.minDaysFromNow).toBe(7);
      expect(range.maxDaysFromNow).toBe(90);
    });

    it('should match CreatedDate pattern', () => {
      const range = getDateRange('Account', 'CreatedDate');
      expect(range.minDaysFromNow).toBe(-365);
      expect(range.maxDaysFromNow).toBe(0);
    });
  });

  describe('generateDateFromRange', () => {
    it('should produce valid ISO date string', () => {
      const result = generateDateFromRange({ minDaysFromNow: -30, maxDaysFromNow: 30 }, 0);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should produce date within range', () => {
      const range = { minDaysFromNow: 10, maxDaysFromNow: 20 };
      const result = generateDateFromRange(range, 5);
      const generated = new Date(result);
      const now = new Date();
      const diffDays = Math.round((generated.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(range.minDaysFromNow - 1);
      expect(diffDays).toBeLessThanOrEqual(range.maxDaysFromNow + 1);
    });

    it('should produce different dates for different indices', () => {
      const range = { minDaysFromNow: 0, maxDaysFromNow: 100 };
      const r1 = generateDateFromRange(range, 0);
      const r2 = generateDateFromRange(range, 5);
      expect(r1).not.toBe(r2);
    });
  });
});
