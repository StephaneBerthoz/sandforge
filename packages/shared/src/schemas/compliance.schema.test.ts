import { describe, it, expect } from 'vitest';

import {
  complianceRuleSchema,
  complianceProfileSchema,
  complianceReportEntrySchema,
  complianceObjectSummarySchema,
  complianceReportSchema,
  anonymizationOverrideSchema,
} from './compliance.schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createValidComplianceRule(): Record<string, unknown> {
  return {
    id: 'rule-gdpr-001',
    framework: 'gdpr',
    category: 'data_minimization',
    description: 'Personal email addresses must be anonymized',
    targetPiiCategories: ['PII'],
    requiredMethod: 'fake',
    articleReference: 'GDPR Art. 17',
  };
}

function createValidPiiFieldDetection(): Record<string, unknown> {
  return {
    objectApiName: 'Contact',
    fieldApiName: 'Email',
    fieldLabel: 'Email Address',
    fieldType: 'email',
    piiCategory: 'PII',
    detectionMethod: 'field_name',
    confidence: 0.95,
    suggestedMethod: 'fake',
  };
}

function createValidComplianceReportEntry(): Record<string, unknown> {
  return {
    objectApiName: 'Contact',
    fieldApiName: 'Email',
    piiCategory: 'PII',
    anonymizationMethod: 'fake',
    recordsAnonymized: 500,
    ruleApplied: 'rule-gdpr-001',
    userOverridden: false,
  };
}

function createValidObjectSummary(): Record<string, unknown> {
  return {
    objectApiName: 'Contact',
    recordCount: 500,
    piiFieldCount: 3,
    anonymizationMethods: ['fake', 'mask'],
    status: 'pass',
  };
}

function createValidComplianceReport(): Record<string, unknown> {
  return {
    id: 'report-001',
    framework: 'gdpr',
    generatedAt: '2026-03-07T12:00:00.000Z',
    sourceOrgId: 'org-source-123',
    targetOrgId: 'org-target-456',
    totalFieldsScanned: 50,
    piiFieldsDetected: 5,
    piiFieldsAnonymized: 5,
    entries: [createValidComplianceReportEntry()],
    objectSummaries: [createValidObjectSummary()],
    overallStatus: 'pass',
    checksumSha256: 'abc123def456',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('anonymizationOverrideSchema', () => {
  it('should parse valid override with method', () => {
    const result = anonymizationOverrideSchema.parse({
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      method: 'mask',
    });
    expect(result.method).toBe('mask');
  });

  it('should parse override with skip method', () => {
    const result = anonymizationOverrideSchema.parse({
      objectApiName: 'Contact',
      fieldApiName: 'Phone',
      method: 'skip',
    });
    expect(result.method).toBe('skip');
  });

  it('should reject invalid method', () => {
    expect(() =>
      anonymizationOverrideSchema.parse({
        objectApiName: 'Contact',
        fieldApiName: 'Email',
        method: 'destroy',
      }),
    ).toThrow();
  });
});

describe('complianceRuleSchema', () => {
  it('should parse valid rule', () => {
    const result = complianceRuleSchema.parse(createValidComplianceRule());
    expect(result.id).toBe('rule-gdpr-001');
    expect(result.framework).toBe('gdpr');
    expect(result.articleReference).toBe('GDPR Art. 17');
  });

  it('should parse rule without optional articleReference', () => {
    const rule = { ...createValidComplianceRule() };
    delete rule['articleReference'];
    const result = complianceRuleSchema.parse(rule);
    expect(result.articleReference).toBeUndefined();
  });

  it('should accept requiredMethod as "any"', () => {
    const result = complianceRuleSchema.parse({
      ...createValidComplianceRule(),
      requiredMethod: 'any',
    });
    expect(result.requiredMethod).toBe('any');
  });

  it('should reject empty id', () => {
    expect(() => complianceRuleSchema.parse({ ...createValidComplianceRule(), id: '' })).toThrow();
  });

  it('should reject invalid pii category in targetPiiCategories', () => {
    expect(() =>
      complianceRuleSchema.parse({
        ...createValidComplianceRule(),
        targetPiiCategories: ['INVALID'],
      }),
    ).toThrow();
  });
});

describe('complianceProfileSchema', () => {
  it('should parse valid profile', () => {
    const profile = {
      framework: 'gdpr',
      rules: [createValidComplianceRule()],
      autoDetectedPII: [createValidPiiFieldDetection()],
      userOverrides: [],
      auditRequired: true,
    };
    const result = complianceProfileSchema.parse(profile);
    expect(result.framework).toBe('gdpr');
    expect(result.rules).toHaveLength(1);
    expect(result.autoDetectedPII).toHaveLength(1);
    expect(result.auditRequired).toBe(true);
  });

  it('should reject invalid nested rule', () => {
    expect(() =>
      complianceProfileSchema.parse({
        framework: 'gdpr',
        rules: [{ id: '' }],
        autoDetectedPII: [],
        userOverrides: [],
        auditRequired: false,
      }),
    ).toThrow();
  });
});

describe('complianceReportEntrySchema', () => {
  it('should parse valid entry', () => {
    const result = complianceReportEntrySchema.parse(createValidComplianceReportEntry());
    expect(result.objectApiName).toBe('Contact');
    expect(result.recordsAnonymized).toBe(500);
  });

  it('should reject negative recordsAnonymized', () => {
    expect(() =>
      complianceReportEntrySchema.parse({
        ...createValidComplianceReportEntry(),
        recordsAnonymized: -10,
      }),
    ).toThrow();
  });
});

describe('complianceObjectSummarySchema', () => {
  it('should parse valid summary', () => {
    const result = complianceObjectSummarySchema.parse(createValidObjectSummary());
    expect(result.objectApiName).toBe('Contact');
    expect(result.status).toBe('pass');
  });

  it('should accept all valid statuses', () => {
    for (const status of ['pass', 'partial', 'fail']) {
      const result = complianceObjectSummarySchema.parse({
        ...createValidObjectSummary(),
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it('should reject invalid status', () => {
    expect(() =>
      complianceObjectSummarySchema.parse({
        ...createValidObjectSummary(),
        status: 'unknown',
      }),
    ).toThrow();
  });

  it('should reject invalid anonymization method in array', () => {
    expect(() =>
      complianceObjectSummarySchema.parse({
        ...createValidObjectSummary(),
        anonymizationMethods: ['invalid_method'],
      }),
    ).toThrow();
  });
});

describe('complianceReportSchema', () => {
  it('should parse valid report', () => {
    const result = complianceReportSchema.parse(createValidComplianceReport());
    expect(result.id).toBe('report-001');
    expect(result.framework).toBe('gdpr');
    expect(result.entries).toHaveLength(1);
    expect(result.objectSummaries).toHaveLength(1);
    expect(result.overallStatus).toBe('pass');
  });

  it('should parse report with multiple entries and summaries', () => {
    const report = {
      ...createValidComplianceReport(),
      entries: [
        createValidComplianceReportEntry(),
        {
          ...createValidComplianceReportEntry(),
          fieldApiName: 'Phone',
          anonymizationMethod: 'mask',
        },
      ],
      objectSummaries: [
        createValidObjectSummary(),
        { ...createValidObjectSummary(), objectApiName: 'Lead', status: 'partial' },
      ],
    };
    const result = complianceReportSchema.parse(report);
    expect(result.entries).toHaveLength(2);
    expect(result.objectSummaries).toHaveLength(2);
  });

  it('should reject empty id', () => {
    expect(() =>
      complianceReportSchema.parse({ ...createValidComplianceReport(), id: '' }),
    ).toThrow();
  });

  it('should reject invalid nested entry', () => {
    expect(() =>
      complianceReportSchema.parse({
        ...createValidComplianceReport(),
        entries: [{ objectApiName: '', fieldApiName: '' }],
      }),
    ).toThrow();
  });

  it('should reject invalid overallStatus', () => {
    expect(() =>
      complianceReportSchema.parse({
        ...createValidComplianceReport(),
        overallStatus: 'warning',
      }),
    ).toThrow();
  });
});
