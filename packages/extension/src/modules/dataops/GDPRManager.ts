import { createHash, randomBytes } from 'crypto';
import type { DataOpsAnonymizationRule, ComplianceFrameworkType } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** Data Subject Request type. */
export type DSRType = 'access' | 'erasure' | 'rectification' | 'portability' | 'restriction';

/** Data Subject Request status. */
export type DSRStatus = 'pending' | 'in_progress' | 'completed' | 'rejected';

/** Data Subject Request. PII fields are stored as SHA-256 hashes. */
export interface DataSubjectRequest {
  id: string;
  type: DSRType;
  /** SHA-256 hash of the subject's email. Use {@link GDPRManager.hashPII} to compare. */
  subjectEmail: string;
  /** SHA-256 hash of the subject's name. */
  subjectName: string;
  requestDate: string;
  dueDate: string;
  status: DSRStatus;
  affectedObjects: string[];
  recordsFound: number;
  recordsProcessed: number;
  completedDate?: string;
  notes: string;
}

/** Field detection result for PII scanning. */
export interface PIIFieldResult {
  objectApiName: string;
  fieldApiName: string;
  piiCategory: string;
  recordCount: number;
  sampleValues: string[];
}

/** Erasure plan for a right-to-erasure request. */
export interface ErasurePlan {
  dsrId: string;
  subjectIdentifier: string;
  objects: ErasurePlanObject[];
  totalRecords: number;
  estimatedDuration: number;
  anonymizationRules: DataOpsAnonymizationRule[];
}

/** Per-object erasure plan. */
export interface ErasurePlanObject {
  objectApiName: string;
  recordIds: string[];
  action: 'delete' | 'anonymize';
  fields?: string[];
}

/** Connection abstraction for GDPR operations. */
export interface GDPRConnection {
  queryRecordsByEmail(
    orgId: string,
    objectName: string,
    emailField: string,
    email: string,
  ): Promise<Record<string, unknown>[]>;
  queryRecordCount(orgId: string, soql: string): Promise<number>;
  describeFields(
    orgId: string,
    objectName: string,
  ): Promise<Array<{ apiName: string; label: string; type: string }>>;
}

/** PII field name patterns mapped to categories. */
const PII_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /email/i, category: 'email' },
  { pattern: /phone|mobile|fax/i, category: 'phone' },
  { pattern: /first.?name/i, category: 'name' },
  { pattern: /last.?name/i, category: 'name' },
  { pattern: /birth.?date|date.?of.?birth/i, category: 'date_of_birth' },
  { pattern: /address|street|city|postal|zip/i, category: 'address' },
  { pattern: /ssn|social.?security/i, category: 'national_id' },
  { pattern: /passport/i, category: 'national_id' },
  { pattern: /credit.?card|card.?number/i, category: 'financial' },
  { pattern: /iban|bank.?account/i, category: 'financial' },
  { pattern: /ip.?address/i, category: 'technical_id' },
  { pattern: /device.?id|cookie/i, category: 'technical_id' },
];

/** Standard objects likely containing personal data. */
const PERSONAL_DATA_OBJECTS = ['Contact', 'Lead', 'Person', 'User', 'Account', 'Case'];

/** GDPR response deadline in days. */
const GDPR_DEADLINE_DAYS = 30;

/**
 * Manages GDPR/RGPD compliance operations including
 * Data Subject Requests (DSR), PII scanning, right-to-erasure
 * plans, and consent audit trails.
 */
export class GDPRManager {
  private readonly requests: Map<string, DataSubjectRequest> = new Map();
  private requestCounter = 0;

  /**
   * Hash a PII value using SHA-256 for safe storage.
   * @param value - The plaintext PII value to hash
   * @returns The SHA-256 hex digest of the value
   */
  hashPII(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * Create a new Data Subject Request.
   * PII fields (email, name) are stored as SHA-256 hashes.
   * @param type - The type of DSR
   * @param subjectEmail - The data subject's email (will be hashed before storage)
   * @param subjectName - The data subject's name (will be hashed before storage)
   * @returns The newly created DSR (with hashed PII)
   */
  createDSR(type: DSRType, subjectEmail: string, subjectName: string): DataSubjectRequest {
    this.requestCounter += 1;
    const id = `dsr-${Date.now()}-${this.requestCounter}`;
    const now = new Date();
    const due = new Date(now);
    due.setDate(due.getDate() + GDPR_DEADLINE_DAYS);

    const dsr: DataSubjectRequest = {
      id,
      type,
      subjectEmail: this.hashPII(subjectEmail),
      subjectName: this.hashPII(subjectName),
      requestDate: now.toISOString(),
      dueDate: due.toISOString(),
      status: 'pending',
      affectedObjects: [],
      recordsFound: 0,
      recordsProcessed: 0,
      notes: '',
    };

    this.requests.set(id, dsr);
    return dsr;
  }

  /**
   * List all tracked DSR requests.
   * @returns Array of all Data Subject Requests
   */
  listDSRs(): DataSubjectRequest[] {
    return Array.from(this.requests.values());
  }

  /**
   * Get a specific DSR by ID.
   * @param dsrId - The DSR identifier
   * @returns The DSR or undefined
   */
  getDSR(dsrId: string): DataSubjectRequest | undefined {
    return this.requests.get(dsrId);
  }

  /**
   * Update a DSR status and metadata.
   * @param dsrId - The DSR identifier
   * @param updates - Partial updates to apply
   * @returns True if updated, false if not found
   */
  updateDSR(dsrId: string, updates: Partial<DataSubjectRequest>): boolean {
    const existing = this.requests.get(dsrId);
    if (!existing) return false;

    const updated: DataSubjectRequest = { ...existing, ...updates, id: existing.id };
    if (updates.status === 'completed') {
      updated.completedDate = new Date().toISOString();
    }
    this.requests.set(dsrId, updated);
    return true;
  }

  /**
   * Scan org fields for PII patterns.
   * @param conn - Connection abstraction
   * @param orgId - The org to scan
   * @param objectNames - Objects to scan (defaults to standard personal data objects)
   * @returns Array of PII field detections
   */
  async scanForPII(
    conn: GDPRConnection,
    orgId: string,
    objectNames?: string[],
  ): Promise<PIIFieldResult[]> {
    const objects = objectNames ?? PERSONAL_DATA_OBJECTS;
    const results: PIIFieldResult[] = [];

    for (const objName of objects) {
      try {
        const fields = await conn.describeFields(orgId, objName);

        for (const field of fields) {
          const category = this.detectPIICategory(field.apiName, field.label);
          if (category) {
            let recordCount = 0;
            try {
              recordCount = await conn.queryRecordCount(
                orgId,
                `SELECT COUNT() FROM ${assertSoqlIdentifier(objName)} WHERE ${assertSoqlIdentifier(field.apiName)} != null`,
              );
            } catch {
              recordCount = 0;
            }

            results.push({
              objectApiName: objName,
              fieldApiName: field.apiName,
              piiCategory: category,
              recordCount,
              sampleValues: [],
            });
          }
        }
      } catch {
        // Object not accessible, skip
      }
    }

    return results;
  }

  /**
   * Build an erasure plan for a right-to-erasure DSR.
   * Identifies all records associated with the data subject
   * and proposes delete or anonymize actions.
   * @param conn - Connection abstraction
   * @param orgId - The org to scan
   * @param dsr - The DSR to plan for
   * @param framework - Compliance framework to follow
   * @returns Erasure plan with per-object actions
   */
  async buildErasurePlan(
    conn: GDPRConnection,
    orgId: string,
    dsr: DataSubjectRequest,
    framework: ComplianceFrameworkType = 'gdpr',
  ): Promise<ErasurePlan> {
    const objects: ErasurePlanObject[] = [];
    const anonymizationRules: DataOpsAnonymizationRule[] = [];
    let totalRecords = 0;

    for (const objName of PERSONAL_DATA_OBJECTS) {
      try {
        const fields = await conn.describeFields(orgId, objName);
        const emailField = fields.find((f) => f.apiName.toLowerCase().includes('email'));

        if (!emailField) continue;

        const records = await conn.queryRecordsByEmail(
          orgId,
          objName,
          emailField.apiName,
          dsr.subjectEmail,
        );

        if (records.length === 0) continue;

        const recordIds = records.map((r) => String(r['Id'] ?? '')).filter((id) => id.length > 0);

        // Determine PII fields for anonymization
        const piiFields = fields
          .filter((f) => this.detectPIICategory(f.apiName, f.label) !== null)
          .map((f) => f.apiName);

        // Core objects: anonymize. Others: delete.
        const isCoreObject = objName === 'Account' || objName === 'User';
        const action: 'delete' | 'anonymize' = isCoreObject ? 'anonymize' : 'delete';

        objects.push({
          objectApiName: objName,
          recordIds,
          action,
          fields: action === 'anonymize' ? piiFields : undefined,
        });

        if (action === 'anonymize') {
          for (const fieldName of piiFields) {
            anonymizationRules.push({
              objectApiName: objName,
              fieldApiName: fieldName,
              method: this.inferDataOpsAnonymizationRule(fieldName, framework),
              config: this.inferAnonymizationConfig(fieldName),
            });
          }
        }

        totalRecords += recordIds.length;
      } catch {
        // Object not accessible, skip
      }
    }

    const estimatedDuration = Math.ceil(totalRecords / 200);

    return {
      dsrId: dsr.id,
      subjectIdentifier: dsr.subjectEmail,
      objects,
      totalRecords,
      estimatedDuration,
      anonymizationRules,
    };
  }

  /**
   * Check which DSRs are overdue (past their due date).
   * @returns Array of overdue DSRs
   */
  getOverdueDSRs(): DataSubjectRequest[] {
    const now = new Date();
    return this.listDSRs().filter((dsr) => {
      if (dsr.status === 'completed' || dsr.status === 'rejected') return false;
      return new Date(dsr.dueDate) < now;
    });
  }

  /**
   * Get compliance summary statistics.
   * @returns Summary of DSR statuses and compliance metrics
   */
  getComplianceSummary(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    rejected: number;
    overdue: number;
    averageResolutionDays: number;
  } {
    const dsrs = this.listDSRs();
    const completed = dsrs.filter((d) => d.status === 'completed');

    let totalDays = 0;
    for (const dsr of completed) {
      if (dsr.completedDate) {
        const days =
          (new Date(dsr.completedDate).getTime() - new Date(dsr.requestDate).getTime()) /
          (1000 * 60 * 60 * 24);
        totalDays += days;
      }
    }

    return {
      total: dsrs.length,
      pending: dsrs.filter((d) => d.status === 'pending').length,
      inProgress: dsrs.filter((d) => d.status === 'in_progress').length,
      completed: completed.length,
      rejected: dsrs.filter((d) => d.status === 'rejected').length,
      overdue: this.getOverdueDSRs().length,
      averageResolutionDays: completed.length > 0 ? Math.round(totalDays / completed.length) : 0,
    };
  }

  /**
   * Detect PII category for a field based on name/label patterns.
   * @param apiName - The field API name
   * @param label - The field label
   * @returns The PII category or null if not PII
   */
  detectPIICategory(apiName: string, label: string): string | null {
    const combined = `${apiName} ${label}`;
    for (const { pattern, category } of PII_PATTERNS) {
      if (pattern.test(combined)) return category;
    }
    return null;
  }

  private inferDataOpsAnonymizationRule(
    fieldName: string,
    _framework: ComplianceFrameworkType,
  ): DataOpsAnonymizationRule['method'] {
    const lower = fieldName.toLowerCase();
    if (lower.includes('email')) return 'fake';
    if (lower.includes('phone') || lower.includes('mobile')) return 'mask';
    if (lower.includes('ssn') || lower.includes('creditcard')) return 'hash';
    if (lower.includes('birth') || lower.includes('date')) return 'nullify';
    if (lower.includes('address') || lower.includes('street')) return 'fake';
    return 'mask';
  }

  private inferAnonymizationConfig(fieldName: string): DataOpsAnonymizationRule['config'] {
    const lower = fieldName.toLowerCase();
    if (lower.includes('email')) {
      return { fakerMethod: 'internet.email', fakerLocale: 'en' };
    }
    if (lower.includes('phone') || lower.includes('mobile')) {
      return { maskChar: '*', maskStart: 0, maskEnd: 6 };
    }
    if (lower.includes('ssn') || lower.includes('creditcard')) {
      return { hashAlgorithm: 'sha256', hashSalt: randomBytes(16).toString('hex') };
    }
    if (lower.includes('address') || lower.includes('street')) {
      return { fakerMethod: 'address.streetAddress', fakerLocale: 'en' };
    }
    return { maskChar: '*' };
  }
}
