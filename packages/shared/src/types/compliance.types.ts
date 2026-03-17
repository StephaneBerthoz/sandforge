/**
 * Compliance types for audit reporting and regulatory framework enforcement.
 */

import type { ISODateString, ApiName, ComplianceFrameworkType, AnonymizationMethod } from './common.types.js';
import type {
  AnonymizationOverride,
  PIIFieldDetection,
  PIICategory,
} from './autopilot.types.js';

/** A rule within a compliance profile */
export interface ComplianceRule {
  /** Unique rule identifier */
  readonly id: string;
  /** Framework this rule belongs to */
  readonly framework: ComplianceFrameworkType;
  /** Rule category (e.g., 'data_minimization', 'access_control') */
  readonly category: string;
  /** Human-readable description */
  readonly description: string;
  /** PII categories targeted by this rule */
  readonly targetPiiCategories: PIICategory[];
  /** Required anonymization method, or 'any' if flexible */
  readonly requiredMethod: AnonymizationMethod | 'any';
  /** Reference to the regulation article (e.g., 'GDPR Art. 17') */
  readonly articleReference?: string;
}

/** A compliance profile combining framework rules with detected PII */
export interface ComplianceProfile {
  /** Compliance framework */
  readonly framework: ComplianceFrameworkType;
  /** Rules in this profile */
  readonly rules: ComplianceRule[];
  /** PII fields auto-detected by AI */
  readonly autoDetectedPII: PIIFieldDetection[];
  /** User overrides applied */
  readonly userOverrides: AnonymizationOverride[];
  /** Whether audit trail generation is required */
  readonly auditRequired: boolean;
}

/** Entry in the compliance report for a single field */
export interface ComplianceReportEntry {
  /** Object containing the field */
  readonly objectApiName: ApiName;
  /** Field that was anonymized */
  readonly fieldApiName: string;
  /** PII category of the field */
  readonly piiCategory: PIICategory;
  /** Anonymization method applied */
  readonly anonymizationMethod: AnonymizationMethod;
  /** Number of records anonymized */
  readonly recordsAnonymized: number;
  /** Rule that triggered the anonymization */
  readonly ruleApplied: string;
  /** Whether the user manually overrode the default */
  readonly userOverridden: boolean;
}

/** Complete compliance report generated after execution */
export interface ComplianceReport {
  /** Unique report identifier */
  readonly id: string;
  /** Framework used */
  readonly framework: ComplianceFrameworkType;
  /** Generation timestamp */
  readonly generatedAt: ISODateString;
  /** Source org identifier */
  readonly sourceOrgId: string;
  /** Target org identifier */
  readonly targetOrgId: string;
  /** Total fields scanned for PII */
  readonly totalFieldsScanned: number;
  /** PII fields detected */
  readonly piiFieldsDetected: number;
  /** PII fields that were anonymized */
  readonly piiFieldsAnonymized: number;
  /** Detailed per-field entries */
  readonly entries: ComplianceReportEntry[];
  /** Per-object summaries */
  readonly objectSummaries: ComplianceObjectSummary[];
  /** Overall compliance status */
  readonly overallStatus: 'pass' | 'partial' | 'fail';
  /** SHA-256 checksum for tamper detection */
  readonly checksumSha256: string;
}

/** Per-object summary in the compliance report */
export interface ComplianceObjectSummary {
  /** Object API name */
  readonly objectApiName: ApiName;
  /** Number of records processed */
  readonly recordCount: number;
  /** Number of PII fields in this object */
  readonly piiFieldCount: number;
  /** Anonymization methods used */
  readonly anonymizationMethods: AnonymizationMethod[];
  /** Compliance status for this object */
  readonly status: 'pass' | 'partial' | 'fail';
}
