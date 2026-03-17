import { describe, it, expect } from 'vitest';
import type {
  ComplianceProfile,
  ComplianceReport,
  ComplianceRule,
  ComplianceReportEntry,
  ComplianceObjectSummary,
} from './compliance.types.js';

describe('compliance.types', () => {
  it('should compile ComplianceRule', () => {
    const rule: ComplianceRule = {
      id: 'rule-1',
      framework: 'gdpr',
      category: 'data_minimization',
      description: 'Personal email must be anonymized',
      targetPiiCategories: ['PII'],
      requiredMethod: 'fake',
      articleReference: 'GDPR Art. 17',
    };
    expect(rule.framework).toBe('gdpr');
  });

  it('should compile ComplianceProfile', () => {
    const profile: ComplianceProfile = {
      framework: 'gdpr',
      rules: [],
      autoDetectedPII: [],
      userOverrides: [],
      auditRequired: true,
    };
    expect(profile.framework).toBe('gdpr');
  });

  it('should compile ComplianceReportEntry', () => {
    const entry: ComplianceReportEntry = {
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      piiCategory: 'PII',
      anonymizationMethod: 'fake',
      recordsAnonymized: 500,
      ruleApplied: 'rule-1',
      userOverridden: false,
    };
    expect(entry.recordsAnonymized).toBe(500);
  });

  it('should compile ComplianceReport', () => {
    const report: ComplianceReport = {
      id: 'rpt-1',
      framework: 'hipaa',
      generatedAt: '2026-03-07T00:00:00.000Z',
      sourceOrgId: 'org1',
      targetOrgId: 'org2',
      totalFieldsScanned: 100,
      piiFieldsDetected: 10,
      piiFieldsAnonymized: 10,
      entries: [],
      objectSummaries: [],
      overallStatus: 'pass',
      checksumSha256: 'abc123',
    };
    expect(report.overallStatus).toBe('pass');
  });

  it('should compile ComplianceObjectSummary', () => {
    const summary: ComplianceObjectSummary = {
      objectApiName: 'Contact',
      recordCount: 1000,
      piiFieldCount: 5,
      anonymizationMethods: ['fake', 'mask'],
      status: 'pass',
    };
    expect(summary.piiFieldCount).toBe(5);
  });
});
