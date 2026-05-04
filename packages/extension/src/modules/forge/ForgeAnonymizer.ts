/**
 * ForgeAnonymizer wraps SmartAnonymizer for the Forge pipeline.
 * Maps Salesforce fields to anonymization categories via pattern matching
 * and delegates actual anonymization to SmartAnonymizer.
 */

import type { ForgeAnonymizationCategory } from '@sandforge/shared';
import type { AnonymizationMethod, AutopilotAnonymizationRule } from '@sandforge/shared';
import { SmartAnonymizer, PersonaRegistry } from '../autopilot/SmartAnonymizer.js';

/** PII field info for anonymization. */
export interface PIIFieldInfo {
  /** Field API name. */
  name: string;
  /** Salesforce field type. */
  type: string;
}

/**
 * Maps Salesforce fields to anonymization categories and applies anonymization.
 * Wraps SmartAnonymizer from Autopilot for use in the Forge pipeline.
 */
export class ForgeAnonymizer {
  private readonly smartAnonymizer: SmartAnonymizer;

  constructor(personaRegistry?: PersonaRegistry) {
    this.smartAnonymizer = new SmartAnonymizer(personaRegistry);
  }

  /** Categorize a field into a ForgeAnonymizationCategory based on its type and name. */
  categorizeField(fieldName: string, fieldType: string): ForgeAnonymizationCategory {
    // Match by field type first
    const lowerType = fieldType.toLowerCase();
    if (lowerType === 'email') return 'email';
    if (lowerType === 'phone') return 'phone';

    // Match by field name patterns
    const lowerName = fieldName.toLowerCase();
    if (lowerName.includes('email')) return 'email';
    if (lowerName.includes('phone') || lowerName.includes('fax') || lowerName.includes('mobile'))
      return 'phone';
    if (lowerName.includes('firstname') || lowerName.includes('lastname') || lowerName === 'name')
      return 'name';
    if (
      lowerName.includes('street') ||
      lowerName.includes('address') ||
      lowerName.includes('city') ||
      lowerName.includes('state') ||
      lowerName.includes('postalcode') ||
      lowerName.includes('zip') ||
      lowerName.includes('country')
    )
      return 'address';
    if (
      lowerName.includes('ssn') ||
      lowerName.includes('national_id') ||
      lowerName.includes('passport') ||
      lowerName.includes('driver') ||
      lowerName.includes('license')
    )
      return 'ssn_id';
    if (
      lowerName.includes('credit') ||
      lowerName.includes('card') ||
      lowerName.includes('cvv') ||
      lowerName.includes('iban') ||
      lowerName.includes('routing') ||
      lowerName.includes('bank')
    )
      return 'financial';

    return 'other';
  }

  /** Get the default anonymization method for a category. */
  getDefaultMethod(category: ForgeAnonymizationCategory): AnonymizationMethod {
    const defaults: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
      email: 'fake',
      phone: 'mask',
      name: 'fake',
      address: 'fake',
      ssn_id: 'redact',
      financial: 'hash',
      other: 'nullify',
    };
    return defaults[category];
  }

  /** Get default methods for all categories. */
  getDefaults(): Record<ForgeAnonymizationCategory, AnonymizationMethod> {
    return {
      email: 'fake',
      phone: 'mask',
      name: 'fake',
      address: 'fake',
      ssn_id: 'redact',
      financial: 'hash',
      other: 'nullify',
    };
  }

  /**
   * Anonymize records using category-level rules.
   * Converts category rules to field-level rules for SmartAnonymizer.
   *
   * @param records - Records to anonymize.
   * @param piiFields - PII field metadata (name + Salesforce type).
   * @param categoryRules - Anonymization method per category.
   * @param objectApiName - Salesforce object API name.
   * @returns Anonymized records (cloned, originals not mutated).
   */
  anonymizeRecords(
    records: Record<string, unknown>[],
    piiFields: PIIFieldInfo[],
    categoryRules: Record<ForgeAnonymizationCategory, AnonymizationMethod>,
    objectApiName: string,
  ): Record<string, unknown>[] {
    // Convert category rules to per-field AnonymizationRule[]
    const rules: AutopilotAnonymizationRule[] = piiFields.map((field) => {
      const category = this.categorizeField(field.name, field.type);
      return {
        objectApiName,
        fieldApiName: field.name,
        method: categoryRules[category],
        piiCategory: 'PII' as const,
        aiConfidence: 1,
        userOverridden: false,
      };
    });

    // Clone records to avoid mutation
    const cloned = records.map((r) => ({ ...r }));
    return this.smartAnonymizer.anonymize(cloned, rules, objectApiName);
  }
}
