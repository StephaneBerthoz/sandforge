import { describe, it, expect } from 'vitest';
import type {
  BackupConfig,
  AnonymizationTemplate,
  DataQualityScanResult,
} from './dataops.types.js';

describe('dataops.types', () => {
  describe('BackupConfig', () => {
    it('should accept a valid BackupConfig with required fields', () => {
      const config: BackupConfig = {
        id: 'bkp-001',
        name: 'Weekly Account Backup',
        orgId: 'org-prod-001',
        objects: ['Account', 'Contact', 'Opportunity'],
        includeAttachments: true,
        includeFiles: false,
        compression: true,
        encryption: true,
        retentionDays: 90,
        createdAt: '2026-01-20T08:00:00Z',
      };

      expect(config.id).toBe('bkp-001');
      expect(config.objects).toHaveLength(3);
      expect(config.includeAttachments).toBe(true);
      expect(config.compression).toBe(true);
      expect(config.encryption).toBe(true);
      expect(config.retentionDays).toBe(90);
      expect(config.schedule).toBeUndefined();
    });

    it('should accept a BackupConfig with an optional schedule', () => {
      const config: BackupConfig = {
        id: 'bkp-002',
        name: 'Nightly Full Backup',
        orgId: 'org-prod-002',
        objects: ['Account', 'Contact', 'Lead', 'Opportunity', 'Case'],
        includeAttachments: true,
        includeFiles: true,
        compression: true,
        encryption: true,
        schedule: {
          enabled: true,
          cron: '0 1 * * *',
          timezone: 'Europe/Paris',
          maxRetries: 2,
        },
        retentionDays: 365,
        createdAt: '2026-02-01T12:00:00Z',
      };

      expect(config.schedule?.enabled).toBe(true);
      expect(config.schedule?.cron).toBe('0 1 * * *');
      expect(config.retentionDays).toBe(365);
      expect(config.objects).toHaveLength(5);
    });
  });

  describe('AnonymizationTemplate', () => {
    it('should accept a valid AnonymizationTemplate with rules and tags', () => {
      const template: AnonymizationTemplate = {
        id: 'anon-001',
        name: 'GDPR Compliance Template',
        description: 'Anonymizes PII fields for GDPR-compliant sandbox seeding',
        rules: [
          {
            objectApiName: 'Contact',
            fieldApiName: 'Email',
            method: 'fake',
            config: { fakerMethod: 'internet.email', fakerLocale: 'en' },
          },
          {
            objectApiName: 'Contact',
            fieldApiName: 'Phone',
            method: 'mask',
            config: { maskChar: '*', maskStart: 0, maskEnd: 6 },
          },
          {
            objectApiName: 'Account',
            fieldApiName: 'BillingStreet',
            method: 'nullify',
            config: {},
          },
        ],
        complianceFramework: 'gdpr',
        tags: ['gdpr', 'pii', 'sandbox'],
        createdAt: '2026-01-10T09:00:00Z',
      };

      expect(template.name).toBe('GDPR Compliance Template');
      expect(template.rules).toHaveLength(3);
      expect(template.rules[0].method).toBe('fake');
      expect(template.rules[1].config.maskChar).toBe('*');
      expect(template.complianceFramework).toBe('gdpr');
      expect(template.tags).toContain('pii');
    });

    it('should accept a template without complianceFramework', () => {
      const template: AnonymizationTemplate = {
        id: 'anon-002',
        name: 'Simple Mask Template',
        description: 'Basic masking for internal dev sandboxes',
        rules: [
          {
            objectApiName: 'Lead',
            fieldApiName: 'LastName',
            method: 'hash',
            config: { hashAlgorithm: 'sha256', hashSalt: 'sandforge-salt' },
          },
        ],
        tags: ['internal', 'dev'],
        createdAt: '2026-02-05T15:00:00Z',
      };

      expect(template.complianceFramework).toBeUndefined();
      expect(template.rules).toHaveLength(1);
      expect(template.rules[0].config.hashAlgorithm).toBe('sha256');
    });
  });

  describe('DataQualityScanResult', () => {
    it('should accept a valid scan result with rule results', () => {
      const scanResult: DataQualityScanResult = {
        orgId: 'org-prod-001',
        objectApiName: 'Contact',
        totalRecords: 10000,
        score: 87.5,
        rules: [
          {
            ruleType: 'completeness',
            fieldApiName: 'Email',
            passed: 9200,
            failed: 800,
            passRate: 92.0,
            sampleFailures: ['003xx000001a', '003xx000001b'],
          },
          {
            ruleType: 'format',
            fieldApiName: 'Phone',
            passed: 8500,
            failed: 1500,
            passRate: 85.0,
            sampleFailures: ['003xx000002a'],
          },
          {
            ruleType: 'uniqueness',
            fieldApiName: 'External_Id__c',
            passed: 9999,
            failed: 1,
            passRate: 99.99,
            sampleFailures: ['003xx000003a'],
          },
        ],
        timestamp: '2026-02-15T18:00:00Z',
      };

      expect(scanResult.score).toBe(87.5);
      expect(scanResult.totalRecords).toBe(10000);
      expect(scanResult.rules).toHaveLength(3);
      expect(scanResult.rules[0].passRate).toBe(92.0);
      expect(scanResult.rules[2].ruleType).toBe('uniqueness');
    });

    it('should accept a scan result with a perfect score and no failures', () => {
      const scanResult: DataQualityScanResult = {
        orgId: 'org-dev-001',
        objectApiName: 'Account',
        totalRecords: 250,
        score: 100,
        rules: [
          {
            ruleType: 'completeness',
            fieldApiName: 'Name',
            passed: 250,
            failed: 0,
            passRate: 100,
            sampleFailures: [],
          },
        ],
        timestamp: '2026-02-16T10:00:00Z',
      };

      expect(scanResult.score).toBe(100);
      expect(scanResult.rules[0].failed).toBe(0);
      expect(scanResult.rules[0].sampleFailures).toHaveLength(0);
    });
  });
});
