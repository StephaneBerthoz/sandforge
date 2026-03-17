import { describe, it, expect, beforeEach } from 'vitest';
import { MaskingTemplateService } from './MaskingTemplateService';

describe('MaskingTemplateService', () => {
  let service: MaskingTemplateService;

  beforeEach(() => {
    service = new MaskingTemplateService();
  });

  describe('getAllTemplates', () => {
    it('returns all pre-built templates', () => {
      const templates = service.getAllTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(6);
    });

    it('includes Account, Contact, Lead, Opportunity, Case, User', () => {
      const names = service.getAllTemplates().map((t) => t.objectApiName);
      expect(names).toContain('Account');
      expect(names).toContain('Contact');
      expect(names).toContain('Lead');
      expect(names).toContain('Opportunity');
      expect(names).toContain('Case');
      expect(names).toContain('User');
    });
  });

  describe('getTemplate', () => {
    it('returns template for Account', () => {
      const template = service.getTemplate('Account');
      expect(template).toBeDefined();
      expect(template?.objectApiName).toBe('Account');
      expect(template?.rules.length).toBeGreaterThan(0);
    });

    it('returns undefined for unknown object', () => {
      expect(service.getTemplate('CustomObj__c')).toBeUndefined();
    });
  });

  describe('getRulesForObject', () => {
    it('returns all rules for Contact', () => {
      const rules = service.getRulesForObject('Contact');
      expect(rules.length).toBeGreaterThan(0);
    });

    it('returns only recommended rules when filtered', () => {
      const allRules = service.getRulesForObject('Contact');
      const recommended = service.getRulesForObject('Contact', true);
      expect(recommended.length).toBeLessThan(allRules.length);
      expect(recommended.every((r) => r.recommended)).toBe(true);
    });

    it('returns empty array for unknown object', () => {
      expect(service.getRulesForObject('Unknown__c')).toEqual([]);
    });
  });

  describe('getSupportedObjects', () => {
    it('returns list of object API names', () => {
      const objects = service.getSupportedObjects();
      expect(objects).toContain('Account');
      expect(objects).toContain('Contact');
      expect(objects.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('hasTemplate', () => {
    it('returns true for supported objects', () => {
      expect(service.hasTemplate('Account')).toBe(true);
      expect(service.hasTemplate('Contact')).toBe(true);
    });

    it('returns false for unsupported objects', () => {
      expect(service.hasTemplate('CustomObj__c')).toBe(false);
    });
  });

  describe('rule content validation', () => {
    it('Account rules include Name and Phone', () => {
      const rules = service.getRulesForObject('Account');
      const fieldNames = rules.map((r) => r.fieldApiName);
      expect(fieldNames).toContain('Name');
      expect(fieldNames).toContain('Phone');
    });

    it('Contact rules include Email and FirstName', () => {
      const rules = service.getRulesForObject('Contact');
      const fieldNames = rules.map((r) => r.fieldApiName);
      expect(fieldNames).toContain('Email');
      expect(fieldNames).toContain('FirstName');
    });

    it('each rule has a non-empty description', () => {
      const templates = service.getAllTemplates();
      for (const template of templates) {
        for (const rule of template.rules) {
          expect(rule.description.length).toBeGreaterThan(0);
        }
      }
    });

    it('each rule has a valid ruleType', () => {
      const validTypes = new Set(['fake', 'mask', 'hash', 'nullify', 'preserve_format', 'constant', 'truncate', 'shuffle']);
      const templates = service.getAllTemplates();
      for (const template of templates) {
        for (const rule of template.rules) {
          expect(validTypes.has(rule.ruleType)).toBe(true);
        }
      }
    });
  });
});
