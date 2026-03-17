import { describe, it, expect } from 'vitest';
import type {
  CompareConfig,
  CompareResult,
  CompareItem,
  DeploymentSuggestion,
} from './compare.types.js';

describe('compare.types', () => {
  describe('CompareConfig', () => {
    it('should accept a valid CompareConfig with required fields', () => {
      const config: CompareConfig = {
        id: 'cmp-001',
        name: 'Prod vs Sandbox Metadata',
        sourceOrgId: 'org-prod',
        targetOrgId: 'org-sandbox',
        mode: 'metadata',
        componentTypes: ['ApexClass', 'ApexTrigger', 'CustomObject', 'CustomField'],
        includeManaged: false,
        includeUnmanaged: true,
        createdAt: '2026-02-10T09:00:00Z',
      };

      expect(config.id).toBe('cmp-001');
      expect(config.mode).toBe('metadata');
      expect(config.componentTypes).toHaveLength(4);
      expect(config.includeManaged).toBe(false);
      expect(config.thirdOrgId).toBeUndefined();
    });

    it('should accept a config with optional thirdOrgId and objectFilter', () => {
      const config: CompareConfig = {
        id: 'cmp-002',
        name: 'Three-way Permission Compare',
        sourceOrgId: 'org-prod',
        targetOrgId: 'org-staging',
        thirdOrgId: 'org-dev',
        mode: 'permissions',
        componentTypes: ['Profile', 'PermissionSet'],
        objectFilter: ['Account', 'Contact', 'Opportunity'],
        includeManaged: true,
        includeUnmanaged: true,
        createdAt: '2026-02-12T14:30:00Z',
      };

      expect(config.thirdOrgId).toBe('org-dev');
      expect(config.objectFilter).toHaveLength(3);
      expect(config.mode).toBe('permissions');
    });
  });

  describe('CompareResult', () => {
    it('should accept a valid CompareResult with summary and diffs', () => {
      const result: CompareResult = {
        configId: 'cmp-001',
        sourceOrgId: 'org-prod',
        targetOrgId: 'org-sandbox',
        mode: 'metadata',
        summary: {
          totalItems: 150,
          added: 5,
          removed: 2,
          modified: 18,
          unchanged: 125,
          byType: {
            ApexClass: { added: 3, removed: 1, modified: 10 },
            CustomField: { added: 2, removed: 1, modified: 8 },
          },
        },
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'AccountTriggerHandler',
            status: 'modified',
            severity: 'warning',
            deployable: true,
          },
        ],
        timestamp: '2026-02-15T11:00:00Z',
        duration: 45000,
      };

      expect(result.summary.totalItems).toBe(150);
      expect(result.summary.byType['ApexClass'].modified).toBe(10);
      expect(result.diffs).toHaveLength(1);
      expect(result.duration).toBe(45000);
    });
  });

  describe('CompareItem', () => {
    it('should accept a modified item with field-level diffs', () => {
      const item: CompareItem = {
        componentType: 'CustomField',
        fullName: 'Account.Industry__c',
        status: 'modified',
        sourceValue: '<field><type>Picklist</type><required>true</required></field>',
        targetValue: '<field><type>Picklist</type><required>false</required></field>',
        fieldDiffs: [
          {
            fieldPath: 'required',
            sourceValue: 'true',
            targetValue: 'false',
            status: 'modified',
          },
        ],
        severity: 'breaking',
        deployable: true,
      };

      expect(item.status).toBe('modified');
      expect(item.fieldDiffs).toHaveLength(1);
      expect(item.severity).toBe('breaking');
      expect(item.deployable).toBe(true);
    });

    it('should accept an added item without field diffs', () => {
      const item: CompareItem = {
        componentType: 'ApexClass',
        fullName: 'NewBatchProcessor',
        status: 'added',
        sourceValue: 'public class NewBatchProcessor {}',
        severity: 'info',
        deployable: true,
      };

      expect(item.status).toBe('added');
      expect(item.targetValue).toBeUndefined();
      expect(item.fieldDiffs).toBeUndefined();
    });
  });

  describe('DeploymentSuggestion', () => {
    it('should accept a valid DeploymentSuggestion with components, risks, and order', () => {
      const suggestion: DeploymentSuggestion = {
        components: [
          {
            componentType: 'CustomObject',
            fullName: 'Invoice__c',
            action: 'deploy',
            reason: 'New custom object not present in target',
          },
          {
            componentType: 'ApexClass',
            fullName: 'InvoiceService',
            action: 'deploy',
            reason: 'Modified — 12 lines changed',
          },
          {
            componentType: 'Flow',
            fullName: 'OldLeadFlow',
            action: 'skip',
            reason: 'Managed package component — cannot modify',
          },
        ],
        estimatedDuration: 120,
        risks: [
          {
            component: 'Invoice__c',
            risk: 'medium',
            description: 'New object may require permission set updates',
          },
          {
            component: 'InvoiceService',
            risk: 'low',
            description: 'Class modification with full test coverage',
          },
        ],
        order: ['Invoice__c', 'InvoiceService'],
      };

      expect(suggestion.components).toHaveLength(3);
      expect(suggestion.estimatedDuration).toBe(120);
      expect(suggestion.risks).toHaveLength(2);
      expect(suggestion.order).toEqual(['Invoice__c', 'InvoiceService']);
    });
  });
});
