import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

import type {
  PIIFieldDetection,
  AnonymizationOverride,
  ApiName,
} from '@sandforge/shared';

import { ComplianceEngine } from './ComplianceEngine.js';

/** Helper to create a PII detection fixture. */
function makePiiDetection(
  overrides: Partial<PIIFieldDetection> = {},
): PIIFieldDetection {
  return {
    objectApiName: 'Contact' as ApiName,
    fieldApiName: 'Email',
    fieldLabel: 'Email',
    fieldType: 'EMAIL',
    piiCategory: 'PII',
    detectionMethod: 'field_name',
    confidence: 0.95,
    suggestedMethod: 'fake',
    ...overrides,
  };
}

describe('ComplianceEngine', () => {
  let engine: ComplianceEngine;

  beforeEach(() => {
    engine = new ComplianceEngine();
  });

  // ─── 1. GDPR profile ──────────────────────────────────────────

  it('should load correct GDPR rules and map PII to fake', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({ piiCategory: 'PII', suggestedMethod: 'mask' }),
      makePiiDetection({
        fieldApiName: 'SSN__c',
        piiCategory: 'SENSITIVE',
        suggestedMethod: 'mask',
      }),
    ];

    const profile = engine.buildProfile('gdpr', detections);
    expect(profile.rules.length).toBe(4);
    expect(profile.framework).toBe('gdpr');
    expect(profile.auditRequired).toBe(true);

    const rules = engine.generateRules(profile);
    const piiRule = rules.find((r) => r.fieldApiName === 'Email');
    expect(piiRule?.method).toBe('fake'); // GDPR requires fake for PII

    const sensitiveRule = rules.find((r) => r.fieldApiName === 'SSN__c');
    expect(sensitiveRule?.method).toBe('hash'); // GDPR requires hash for SENSITIVE
  });

  // ─── 2. CCPA profile ──────────────────────────────────────────

  it('should load correct CCPA rules', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({ piiCategory: 'PII' }),
    ];

    const profile = engine.buildProfile('ccpa', detections);
    expect(profile.rules.length).toBe(3);
    expect(profile.rules[0].framework).toBe('ccpa');

    const rules = engine.generateRules(profile);
    expect(rules[0].method).toBe('fake');
  });

  // ─── 3. HIPAA profile ─────────────────────────────────────────

  it('should load correct HIPAA rules and map PHI to fake via safe_harbor', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({
        fieldApiName: 'MedicalRecordId__c',
        piiCategory: 'PHI',
        suggestedMethod: 'nullify',
      }),
    ];

    const profile = engine.buildProfile('hipaa', detections);
    expect(profile.rules.length).toBe(3);

    const rules = engine.generateRules(profile);
    // HIPAA hipaa-01 targets PHI with requiredMethod 'fake'
    expect(rules[0].method).toBe('fake');
  });

  // ─── 4. PCI-DSS profile ───────────────────────────────────────

  it('should load correct PCI-DSS rules and map PCI to mask', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({
        fieldApiName: 'CreditCard__c',
        piiCategory: 'PCI',
        suggestedMethod: 'redact',
      }),
    ];

    const profile = engine.buildProfile('pci_dss', detections);
    expect(profile.rules.length).toBe(3);

    const rules = engine.generateRules(profile);
    expect(rules[0].method).toBe('mask'); // PCI-DSS pci-01 requires mask for PCI
  });

  // ─── 5. 'none' framework ──────────────────────────────────────

  it('should return empty rules for none framework', () => {
    const detections: PIIFieldDetection[] = [makePiiDetection()];
    const profile = engine.buildProfile('none', detections);

    expect(profile.rules.length).toBe(0);
    expect(profile.auditRequired).toBe(false);

    const rules = engine.generateRules(profile);
    expect(rules).toEqual([]);
  });

  // ─── 6. User overrides take priority ──────────────────────────

  it('should apply user override method instead of framework rule', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({ piiCategory: 'PII', suggestedMethod: 'fake' }),
    ];
    const overrides: AnonymizationOverride[] = [
      {
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Email',
        method: 'hash',
      },
    ];

    const profile = engine.buildProfile('gdpr', detections, overrides);
    const rules = engine.generateRules(profile);

    expect(rules.length).toBe(1);
    expect(rules[0].method).toBe('hash');
    expect(rules[0].userOverridden).toBe(true);
  });

  // ─── 7. Skip override excludes field ──────────────────────────

  it('should exclude field when override method is skip', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({ fieldApiName: 'Email' }),
      makePiiDetection({ fieldApiName: 'Phone' }),
    ];
    const overrides: AnonymizationOverride[] = [
      {
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Email',
        method: 'skip',
      },
    ];

    const profile = engine.buildProfile('gdpr', detections, overrides);
    const rules = engine.generateRules(profile);

    expect(rules.length).toBe(1);
    expect(rules[0].fieldApiName).toBe('Phone');
  });

  // ─── 8. Summary computation ───────────────────────────────────

  it('should compute correct summary with method breakdown', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Email',
        piiCategory: 'PII',
      }),
      makePiiDetection({
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'SSN__c',
        piiCategory: 'SENSITIVE',
      }),
      makePiiDetection({
        objectApiName: 'Account' as ApiName,
        fieldApiName: 'BillingStreet',
        piiCategory: 'PII',
      }),
    ];

    const profile = engine.buildProfile('gdpr', detections);
    const rules = engine.generateRules(profile);
    const summary = engine.buildSummary(rules);

    expect(summary.totalPiiFields).toBe(3);
    expect(summary.totalFieldsToAnonymize).toBe(3);
    expect(summary.methodBreakdown.fake).toBe(2); // 2 PII fields
    expect(summary.methodBreakdown.hash).toBe(1); // 1 SENSITIVE field
    expect(summary.methodBreakdown.mask).toBe(0);
    expect(summary.objectsWithPii).toContain('Contact');
    expect(summary.objectsWithPii).toContain('Account');
    expect(summary.objectsWithPii.length).toBe(2);
  });

  // ─── 9. Report generation ─────────────────────────────────────

  it('should generate report with correct entries and status logic', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Email',
        piiCategory: 'PII',
      }),
      makePiiDetection({
        objectApiName: 'Account' as ApiName,
        fieldApiName: 'Phone',
        piiCategory: 'PII',
      }),
    ];

    const profile = engine.buildProfile('gdpr', detections);
    const rules = engine.generateRules(profile);

    const recordCounts = new Map<ApiName, number>();
    recordCounts.set('Contact' as ApiName, 500);
    recordCounts.set('Account' as ApiName, 200);

    const report = engine.generateReport(
      profile,
      rules,
      recordCounts,
      'org-source-001',
      'org-target-002',
      150,
    );

    expect(report.framework).toBe('gdpr');
    expect(report.sourceOrgId).toBe('org-source-001');
    expect(report.targetOrgId).toBe('org-target-002');
    expect(report.totalFieldsScanned).toBe(150);
    expect(report.piiFieldsDetected).toBe(2);
    expect(report.piiFieldsAnonymized).toBe(2);
    expect(report.entries.length).toBe(2);
    expect(report.objectSummaries.length).toBe(2);
    expect(report.overallStatus).toBe('pass');
    expect(report.checksumSha256).toBeTruthy();
    expect(report.id).toBeTruthy();
    expect(report.generatedAt).toBeTruthy();

    const contactEntry = report.entries.find(
      (e) => e.objectApiName === 'Contact',
    );
    expect(contactEntry?.recordsAnonymized).toBe(500);
    expect(contactEntry?.ruleApplied).toBe('gdpr-01');
  });

  // ─── 10. Report checksum consistency ──────────────────────────

  it('should produce consistent checksum for identical inputs', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({ piiCategory: 'PII' }),
    ];

    const profile = engine.buildProfile('gdpr', detections);
    const rules = engine.generateRules(profile);
    const recordCounts = new Map<ApiName, number>();
    recordCounts.set('Contact' as ApiName, 100);

    const report1 = engine.generateReport(
      profile,
      rules,
      recordCounts,
      'src',
      'tgt',
      50,
    );
    const report2 = engine.generateReport(
      profile,
      rules,
      recordCounts,
      'src',
      'tgt',
      50,
    );

    // Checksums should match because entries are identical
    expect(report1.checksumSha256).toBe(report2.checksumSha256);

    // Verify it is an actual SHA-256 hex (64 chars)
    expect(report1.checksumSha256).toMatch(/^[a-f0-9]{64}$/);

    // Verify the checksum matches a manual computation
    const expectedChecksum = createHash('sha256')
      .update(JSON.stringify(report1.entries))
      .digest('hex');
    expect(report1.checksumSha256).toBe(expectedChecksum);
  });

  // ─── 11. Multiple PII categories matched to correct rule ─────

  it('should match each PII category to its correct framework rule', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({
        fieldApiName: 'Name',
        piiCategory: 'PII',
        suggestedMethod: 'redact',
      }),
      makePiiDetection({
        fieldApiName: 'Diagnosis__c',
        piiCategory: 'PHI',
        suggestedMethod: 'redact',
      }),
      makePiiDetection({
        fieldApiName: 'CardNumber__c',
        piiCategory: 'PCI',
        suggestedMethod: 'redact',
      }),
      makePiiDetection({
        fieldApiName: 'TaxId__c',
        piiCategory: 'SENSITIVE',
        suggestedMethod: 'redact',
      }),
    ];

    const profile = engine.buildProfile('gdpr', detections);
    const rules = engine.generateRules(profile);

    expect(rules.length).toBe(4);

    const nameRule = rules.find((r) => r.fieldApiName === 'Name');
    expect(nameRule?.method).toBe('fake'); // gdpr-01: PII -> fake

    const phiRule = rules.find((r) => r.fieldApiName === 'Diagnosis__c');
    expect(phiRule?.method).toBe('nullify'); // gdpr-03: PHI -> nullify

    const pciRule = rules.find((r) => r.fieldApiName === 'CardNumber__c');
    expect(pciRule?.method).toBe('mask'); // gdpr-04: PCI -> mask

    const sensitiveRule = rules.find((r) => r.fieldApiName === 'TaxId__c');
    expect(sensitiveRule?.method).toBe('hash'); // gdpr-02: SENSITIVE -> hash
  });

  // ─── 12. Empty PII detections ─────────────────────────────────

  it('should generate empty but valid report with no PII detections', () => {
    const profile = engine.buildProfile('gdpr', []);
    const rules = engine.generateRules(profile);
    const recordCounts = new Map<ApiName, number>();

    const report = engine.generateReport(
      profile,
      rules,
      recordCounts,
      'src',
      'tgt',
      100,
    );

    expect(report.entries).toEqual([]);
    expect(report.objectSummaries).toEqual([]);
    expect(report.piiFieldsDetected).toBe(0);
    expect(report.piiFieldsAnonymized).toBe(0);
    expect(report.overallStatus).toBe('pass');
    expect(report.totalFieldsScanned).toBe(100);
    expect(report.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  // ─── Additional: custom framework ─────────────────────────────

  it('should handle custom framework with no built-in rules', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({ suggestedMethod: 'redact' }),
    ];

    const profile = engine.buildProfile('custom', detections);
    expect(profile.rules.length).toBe(0);
    expect(profile.auditRequired).toBe(false);

    // With no matching rules, should fall back to suggestedMethod
    const rules = engine.generateRules(profile);
    expect(rules.length).toBe(1);
    expect(rules[0].method).toBe('redact');
  });

  // ─── Report partial status ────────────────────────────────────

  it('should report partial status when some PII fields are skipped', () => {
    const detections: PIIFieldDetection[] = [
      makePiiDetection({
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Email',
      }),
      makePiiDetection({
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Phone',
      }),
    ];
    const overrides: AnonymizationOverride[] = [
      {
        objectApiName: 'Contact' as ApiName,
        fieldApiName: 'Email',
        method: 'skip',
      },
    ];

    const profile = engine.buildProfile('gdpr', detections, overrides);
    const rules = engine.generateRules(profile);
    const recordCounts = new Map<ApiName, number>();
    recordCounts.set('Contact' as ApiName, 100);

    const report = engine.generateReport(
      profile,
      rules,
      recordCounts,
      'src',
      'tgt',
      50,
    );

    // Contact has 2 PII detections but only 1 rule (Email was skipped)
    const contactSummary = report.objectSummaries.find(
      (s) => s.objectApiName === 'Contact',
    );
    expect(contactSummary?.status).toBe('partial');
    expect(report.overallStatus).toBe('partial');
  });
});
