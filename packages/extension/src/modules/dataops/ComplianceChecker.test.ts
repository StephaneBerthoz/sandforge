import { describe, it, expect, beforeEach } from 'vitest';
import { ComplianceChecker } from './ComplianceChecker';
import type { AnonymizationTemplate } from '@sandforge/shared';

function createTemplate(
  fieldNames: string[],
): AnonymizationTemplate {
  return {
    id: 'tmpl-1',
    name: 'Test Template',
    description: 'Test',
    rules: fieldNames.map((f) => ({
      objectApiName: 'Contact',
      fieldApiName: f,
      method: 'mask' as const,
      config: { maskChar: '*' },
    })),
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('ComplianceChecker', () => {
  let checker: ComplianceChecker;

  beforeEach(() => {
    checker = new ComplianceChecker();
  });

  describe('check', () => {
    it('should return compliant for a fully covered template', () => {
      const template = createTemplate([
        'Email', 'Phone', 'FirstName', 'LastName', 'MailingAddress',
      ]);

      const result = checker.check(template, 'ccpa');

      expect(result.compliant).toBe(true);
      expect(result.missingRules).toHaveLength(0);
      expect(result.score).toBe(100);
    });

    it('should return non-compliant with missing rules', () => {
      const template = createTemplate(['Email']);

      const result = checker.check(template, 'ccpa');

      expect(result.compliant).toBe(false);
      expect(result.missingRules.length).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(100);
    });

    it('should include suggestions for missing fields', () => {
      const template = createTemplate([]);

      const result = checker.check(template, 'gdpr');

      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions[0].fieldApiName).toBeTruthy();
    });

    it('should return score proportional to coverage', () => {
      const allFields = ['Email', 'Phone', 'FirstName', 'LastName', 'MailingAddress'];
      const halfTemplate = createTemplate(allFields.slice(0, 2));

      const result = checker.check(halfTemplate, 'ccpa');

      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(100);
    });

    it('should handle custom framework with no required fields', () => {
      const template = createTemplate([]);

      const result = checker.check(template, 'custom');

      expect(result.compliant).toBe(true);
      expect(result.score).toBe(100);
    });
  });

  describe('getRequiredFields', () => {
    it('should return GDPR fields', () => {
      const fields = checker.getRequiredFields('gdpr');
      expect(fields).toContain('Email');
      expect(fields).toContain('BirthDate');
    });

    it('should return HIPAA fields', () => {
      const fields = checker.getRequiredFields('hipaa');
      expect(fields).toContain('SSN__c');
      expect(fields).toContain('MedicalRecordNumber__c');
    });

    it('should return PCI-DSS fields', () => {
      const fields = checker.getRequiredFields('pci_dss');
      expect(fields).toContain('CreditCardNumber__c');
      expect(fields).toContain('CVV__c');
    });
  });

  describe('getSuggestedRules', () => {
    it('should suggest rules only for matching required fields', () => {
      const rules = checker.getSuggestedRules('ccpa', 'Contact', [
        'Email',
        'Phone',
        'CustomField__c',
      ]);

      expect(rules).toHaveLength(2);
      expect(rules[0].fieldApiName).toBe('Email');
      expect(rules[1].fieldApiName).toBe('Phone');
    });

    it('should return empty array when no fields match', () => {
      const rules = checker.getSuggestedRules('ccpa', 'Contact', [
        'UnrelatedField__c',
      ]);

      expect(rules).toHaveLength(0);
    });

    it('should assign appropriate rule types', () => {
      const rules = checker.getSuggestedRules('gdpr', 'Contact', [
        'Email',
        'Phone',
        'BirthDate',
      ]);

      const emailRule = rules.find((r) => r.fieldApiName === 'Email');
      const phoneRule = rules.find((r) => r.fieldApiName === 'Phone');
      const birthRule = rules.find((r) => r.fieldApiName === 'BirthDate');

      expect(emailRule?.method).toBe('fake');
      expect(phoneRule?.method).toBe('mask');
      expect(birthRule?.method).toBe('nullify');
    });
  });

  describe('isCompliant', () => {
    it('should return true when fully compliant', () => {
      const template = createTemplate([
        'Email', 'Phone', 'FirstName', 'LastName', 'MailingAddress',
      ]);

      expect(checker.isCompliant(template, 'ccpa')).toBe(true);
    });

    it('should return false when not compliant', () => {
      const template = createTemplate(['Email']);

      expect(checker.isCompliant(template, 'ccpa')).toBe(false);
    });
  });
});
