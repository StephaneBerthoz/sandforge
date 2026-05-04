/**
 * ComplianceEngine — Maps PII detections to anonymization rules based on compliance frameworks.
 * Includes built-in rule sets for GDPR, CCPA, HIPAA, and PCI-DSS.
 * Generates tamper-evident compliance reports with SHA-256 checksums.
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  ComplianceFrameworkType,
  AnonymizationMethod,
  AutopilotAnonymizationRule,
  AnonymizationOverride,
  PIIFieldDetection,
  PIICategory,
  AnonymizationSummary,
  ApiName,
  ComplianceRule,
  ComplianceProfile,
  ComplianceReport,
  ComplianceReportEntry,
  ComplianceObjectSummary,
} from '@sandforge/shared';

/** Autopilot anonymization rule (re-aliased for readability). */
type AnonymizationRule = AutopilotAnonymizationRule;

/** All available anonymization methods. */
const ALL_METHODS: readonly AnonymizationMethod[] = [
  'fake',
  'mask',
  'hash',
  'nullify',
  'redact',
  'shuffle',
  'truncate',
  'preserve_format',
  'age_band',
  'generalize',
] as const;

/**
 * Maps PII detections to anonymization rules based on compliance frameworks.
 * Includes built-in rule sets for GDPR, CCPA, HIPAA, and PCI-DSS.
 * Generates tamper-evident compliance reports.
 */
export class ComplianceEngine {
  private readonly builtInRules: Map<ComplianceFrameworkType, ComplianceRule[]>;

  constructor() {
    this.builtInRules = new Map();
    this.builtInRules.set('gdpr', this.buildGDPRRules());
    this.builtInRules.set('ccpa', this.buildCCPARules());
    this.builtInRules.set('hipaa', this.buildHIPAARules());
    this.builtInRules.set('pci_dss', this.buildPCIDSSRules());
  }

  /**
   * Build a compliance profile from PII detections and a framework.
   * @param framework - The compliance framework to apply.
   * @param piiDetections - PII fields detected by the AI scanner.
   * @param userOverrides - Optional user overrides for anonymization methods.
   * @returns A compliance profile combining framework rules with detections.
   */
  buildProfile(
    framework: ComplianceFrameworkType,
    piiDetections: PIIFieldDetection[],
    userOverrides: AnonymizationOverride[] = [],
  ): ComplianceProfile {
    const rules = this.builtInRules.get(framework) ?? [];
    return {
      framework,
      rules,
      autoDetectedPII: piiDetections,
      userOverrides,
      auditRequired: framework !== 'none' && framework !== 'custom',
    };
  }

  /**
   * Generate anonymization rules from a compliance profile.
   * Maps each PII detection to the appropriate method per framework rules.
   * User overrides take priority over framework rules.
   * @param profile - The compliance profile to generate rules from.
   * @returns An array of anonymization rules, one per PII field (excluding skipped overrides).
   */
  generateRules(profile: ComplianceProfile): AnonymizationRule[] {
    if (profile.framework === 'none') {
      return [];
    }

    const overrideMap = new Map<string, AnonymizationOverride>();
    for (const override of profile.userOverrides) {
      const key = `${override.objectApiName}.${override.fieldApiName}`;
      overrideMap.set(key, override);
    }

    const rules: AnonymizationRule[] = [];

    for (const detection of profile.autoDetectedPII) {
      const key = `${detection.objectApiName}.${detection.fieldApiName}`;
      const override = overrideMap.get(key);

      if (override) {
        if (override.method === 'skip') {
          continue;
        }
        rules.push({
          objectApiName: detection.objectApiName,
          fieldApiName: detection.fieldApiName,
          method: override.method,
          piiCategory: detection.piiCategory,
          aiConfidence: detection.confidence,
          userOverridden: true,
        });
        continue;
      }

      const matchingRule = this.findMatchingRule(profile.rules, detection.piiCategory);

      const method =
        matchingRule && matchingRule.requiredMethod !== 'any'
          ? matchingRule.requiredMethod
          : detection.suggestedMethod;

      rules.push({
        objectApiName: detection.objectApiName,
        fieldApiName: detection.fieldApiName,
        method,
        piiCategory: detection.piiCategory,
        aiConfidence: detection.confidence,
        userOverridden: false,
      });
    }

    return rules;
  }

  /**
   * Build an anonymization summary from rules.
   * @param rules - The anonymization rules to summarize.
   * @returns A summary with totals, method breakdown, and affected objects.
   */
  buildSummary(rules: AnonymizationRule[]): AnonymizationSummary {
    const methodBreakdown = {} as Record<AnonymizationMethod, number>;
    for (const method of ALL_METHODS) {
      methodBreakdown[method] = 0;
    }
    for (const rule of rules) {
      methodBreakdown[rule.method]++;
    }
    const uniqueObjects = [...new Set(rules.map((r) => r.objectApiName))];
    return {
      totalPiiFields: rules.length,
      totalFieldsToAnonymize: rules.length,
      methodBreakdown,
      objectsWithPii: uniqueObjects,
    };
  }

  /**
   * Generate a compliance report after execution.
   * Includes SHA-256 checksum for tamper detection.
   * @param profile - The compliance profile used during execution.
   * @param rules - The anonymization rules that were applied.
   * @param recordCounts - Map of object API name to number of records processed.
   * @param sourceOrgId - Source Salesforce org identifier.
   * @param targetOrgId - Target Salesforce org identifier.
   * @param totalFieldsScanned - Total number of fields scanned for PII.
   * @returns A complete compliance report with checksum.
   */
  generateReport(
    profile: ComplianceProfile,
    rules: AnonymizationRule[],
    recordCounts: Map<ApiName, number>,
    sourceOrgId: string,
    targetOrgId: string,
    totalFieldsScanned: number,
  ): ComplianceReport {
    const overrideSet = new Set(
      profile.userOverrides.map((o) => `${o.objectApiName}.${o.fieldApiName}`),
    );

    const entries: ComplianceReportEntry[] = rules.map((rule) => {
      const matchingRule = this.findMatchingRule(profile.rules, rule.piiCategory);
      const ruleId = matchingRule ? matchingRule.id : 'custom';
      const objectRecords = recordCounts.get(rule.objectApiName) ?? 0;
      const key = `${rule.objectApiName}.${rule.fieldApiName}`;
      return {
        objectApiName: rule.objectApiName,
        fieldApiName: rule.fieldApiName,
        piiCategory: rule.piiCategory,
        anonymizationMethod: rule.method,
        recordsAnonymized: objectRecords,
        ruleApplied: ruleId,
        userOverridden: overrideSet.has(key) || rule.userOverridden,
      };
    });

    const objectSummaries = this.buildObjectSummaries(rules, recordCounts, profile);

    const overallStatus = this.computeOverallStatus(objectSummaries);

    const generatedAt = new Date().toISOString();
    const reportId = randomUUID();

    const checksumPayload = JSON.stringify(entries);
    const checksumSha256 = createHash('sha256').update(checksumPayload).digest('hex');

    return {
      id: reportId,
      framework: profile.framework,
      generatedAt,
      sourceOrgId,
      targetOrgId,
      totalFieldsScanned,
      piiFieldsDetected: profile.autoDetectedPII.length,
      piiFieldsAnonymized: rules.length,
      entries,
      objectSummaries,
      overallStatus,
      checksumSha256,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────

  /**
   * Find the first compliance rule matching a given PII category.
   * @param rules - The rules to search.
   * @param category - The PII category to match.
   * @returns The first matching rule, or undefined.
   */
  private findMatchingRule(
    rules: ComplianceRule[],
    category: PIICategory,
  ): ComplianceRule | undefined {
    return rules.find((r) => r.targetPiiCategories.includes(category));
  }

  /**
   * Build per-object summaries for the compliance report.
   * @param rules - Anonymization rules applied.
   * @param recordCounts - Map of object API name to record count.
   * @param profile - The compliance profile with PII detections.
   * @returns Array of per-object compliance summaries.
   */
  private buildObjectSummaries(
    rules: AnonymizationRule[],
    recordCounts: Map<ApiName, number>,
    profile: ComplianceProfile,
  ): ComplianceObjectSummary[] {
    const objectNames = new Set<ApiName>();
    for (const rule of rules) {
      objectNames.add(rule.objectApiName);
    }
    for (const detection of profile.autoDetectedPII) {
      objectNames.add(detection.objectApiName);
    }

    const summaries: ComplianceObjectSummary[] = [];

    for (const objectName of objectNames) {
      const objectRules = rules.filter((r) => r.objectApiName === objectName);
      const objectDetections = profile.autoDetectedPII.filter(
        (d) => d.objectApiName === objectName,
      );
      const methods = [...new Set(objectRules.map((r) => r.method))];
      const recordCount = recordCounts.get(objectName) ?? 0;

      const allDetectedCovered =
        objectDetections.length > 0 &&
        objectDetections.every((d) => objectRules.some((r) => r.fieldApiName === d.fieldApiName));

      const status: 'pass' | 'partial' | 'fail' =
        objectDetections.length === 0
          ? 'pass'
          : allDetectedCovered
            ? 'pass'
            : objectRules.length > 0
              ? 'partial'
              : 'fail';

      summaries.push({
        objectApiName: objectName,
        recordCount,
        piiFieldCount: objectDetections.length,
        anonymizationMethods: methods,
        status,
      });
    }

    return summaries;
  }

  /**
   * Compute the overall compliance status from object summaries.
   * @param summaries - Per-object compliance summaries.
   * @returns 'pass' if all pass, 'fail' if all fail, 'partial' otherwise.
   */
  private computeOverallStatus(summaries: ComplianceObjectSummary[]): 'pass' | 'partial' | 'fail' {
    if (summaries.length === 0) {
      return 'pass';
    }
    const allPass = summaries.every((s) => s.status === 'pass');
    if (allPass) {
      return 'pass';
    }
    const allFail = summaries.every((s) => s.status === 'fail');
    if (allFail) {
      return 'fail';
    }
    return 'partial';
  }

  // ─── Built-in rule sets ──────────────────────────────────────

  /** @returns GDPR compliance rules. */
  private buildGDPRRules(): ComplianceRule[] {
    return [
      {
        id: 'gdpr-01',
        framework: 'gdpr',
        category: 'data_minimization',
        description: 'Anonymize personal identifiers (name, email, phone, address)',
        targetPiiCategories: ['PII'],
        requiredMethod: 'fake',
        articleReference: 'GDPR Art. 25',
      },
      {
        id: 'gdpr-02',
        framework: 'gdpr',
        category: 'data_protection',
        description: 'Hash sensitive identifiers for pseudonymization',
        targetPiiCategories: ['SENSITIVE'],
        requiredMethod: 'hash',
        articleReference: 'GDPR Art. 32',
      },
      {
        id: 'gdpr-03',
        framework: 'gdpr',
        category: 'health_data',
        description: 'Nullify health-related data',
        targetPiiCategories: ['PHI'],
        requiredMethod: 'nullify',
        articleReference: 'GDPR Art. 9',
      },
      {
        id: 'gdpr-04',
        framework: 'gdpr',
        category: 'financial_data',
        description: 'Mask payment card data',
        targetPiiCategories: ['PCI'],
        requiredMethod: 'mask',
        articleReference: 'GDPR Art. 32',
      },
    ];
  }

  /** @returns CCPA compliance rules. */
  private buildCCPARules(): ComplianceRule[] {
    return [
      {
        id: 'ccpa-01',
        framework: 'ccpa',
        category: 'personal_info',
        description: 'Anonymize personal information (name, email, phone)',
        targetPiiCategories: ['PII'],
        requiredMethod: 'fake',
      },
      {
        id: 'ccpa-02',
        framework: 'ccpa',
        category: 'commercial_info',
        description: 'Mask commercial and financial data',
        targetPiiCategories: ['PCI', 'SENSITIVE'],
        requiredMethod: 'mask',
      },
      {
        id: 'ccpa-03',
        framework: 'ccpa',
        category: 'biometric',
        description: 'Nullify biometric and health data',
        targetPiiCategories: ['PHI'],
        requiredMethod: 'nullify',
      },
    ];
  }

  /** @returns HIPAA compliance rules (Safe Harbor). */
  private buildHIPAARules(): ComplianceRule[] {
    return [
      {
        id: 'hipaa-01',
        framework: 'hipaa',
        category: 'safe_harbor',
        description: 'Anonymize patient identifiers (name, address, phone)',
        targetPiiCategories: ['PII', 'PHI'],
        requiredMethod: 'fake',
        articleReference: 'HIPAA Safe Harbor \u00A7164.514(b)',
      },
      {
        id: 'hipaa-02',
        framework: 'hipaa',
        category: 'safe_harbor_dates',
        description: 'Generalize dates to year only',
        targetPiiCategories: ['SENSITIVE'],
        requiredMethod: 'age_band',
        articleReference: 'HIPAA Safe Harbor \u00A7164.514(b)',
      },
      {
        id: 'hipaa-03',
        framework: 'hipaa',
        category: 'safe_harbor_ids',
        description: 'Hash medical record numbers and SSNs',
        targetPiiCategories: ['PHI'],
        requiredMethod: 'hash',
        articleReference: 'HIPAA Safe Harbor \u00A7164.514(b)',
      },
    ];
  }

  /** @returns PCI-DSS compliance rules. */
  private buildPCIDSSRules(): ComplianceRule[] {
    return [
      {
        id: 'pci-01',
        framework: 'pci_dss',
        category: 'card_data',
        description: 'Mask PAN to show only last 4 digits',
        targetPiiCategories: ['PCI'],
        requiredMethod: 'mask',
        articleReference: 'PCI-DSS Requirement 3.3',
      },
      {
        id: 'pci-02',
        framework: 'pci_dss',
        category: 'auth_data',
        description: 'Nullify CVV, expiration, and magnetic strip data',
        targetPiiCategories: ['PCI'],
        requiredMethod: 'nullify',
        articleReference: 'PCI-DSS Requirement 3.2',
      },
      {
        id: 'pci-03',
        framework: 'pci_dss',
        category: 'cardholder',
        description: 'Anonymize cardholder personal data',
        targetPiiCategories: ['PII'],
        requiredMethod: 'fake',
        articleReference: 'PCI-DSS Requirement 3.4',
      },
    ];
  }
}
