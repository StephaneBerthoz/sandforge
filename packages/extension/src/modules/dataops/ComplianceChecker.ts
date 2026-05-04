import { randomBytes } from 'crypto';
import type {
  AnonymizationTemplate,
  DataOpsAnonymizationRule,
  ComplianceFrameworkType,
} from '@sandforge/shared';

/** Result of a compliance check */
export interface ComplianceCheckResult {
  compliant: boolean;
  missingRules: string[];
  suggestions: DataOpsAnonymizationRule[];
  score: number;
}

/** Field patterns that must be anonymized per compliance framework */
const FRAMEWORK_FIELDS: Record<ComplianceFrameworkType, string[]> = {
  gdpr: [
    'Email',
    'Phone',
    'FirstName',
    'LastName',
    'BirthDate',
    'MailingAddress',
    'PersonalEmail__c',
  ],
  ccpa: ['Email', 'Phone', 'FirstName', 'LastName', 'MailingAddress'],
  hipaa: [
    'Email',
    'Phone',
    'FirstName',
    'LastName',
    'BirthDate',
    'SSN__c',
    'MedicalRecordNumber__c',
    'HealthPlanId__c',
  ],
  pci_dss: ['CreditCardNumber__c', 'CardExpiry__c', 'CVV__c', 'BillingAddress'],
  custom: [],
  none: [],
};

/**
 * Checks whether an anonymization template meets the requirements
 * of a specific compliance framework (GDPR, CCPA, HIPAA, PCI-DSS).
 * Identifies missing rules and suggests anonymization rules for
 * uncovered fields.
 */
export class ComplianceChecker {
  /**
   * Check a template against a compliance framework.
   * @param template - The anonymization template to evaluate
   * @param framework - The compliance framework to check against
   * @returns A ComplianceCheckResult with compliance status, gaps, and suggestions
   */
  check(
    template: AnonymizationTemplate,
    framework: ComplianceFrameworkType,
  ): ComplianceCheckResult {
    const requiredFields = this.getRequiredFields(framework);
    const coveredFields = new Set(template.rules.map((r) => r.fieldApiName));

    const missingRules: string[] = [];
    const suggestions: DataOpsAnonymizationRule[] = [];

    for (const field of requiredFields) {
      if (!coveredFields.has(field)) {
        missingRules.push(`Field '${field}' is not anonymized`);
        suggestions.push(this.buildSuggestedRule(framework, field));
      }
    }

    const totalRequired = requiredFields.length;
    const covered = totalRequired - missingRules.length;
    const score = totalRequired > 0 ? Math.round((covered / totalRequired) * 100) : 100;

    return {
      compliant: missingRules.length === 0,
      missingRules,
      suggestions,
      score,
    };
  }

  /**
   * Get the field patterns that must be anonymized for a given framework.
   * @param framework - The compliance framework
   * @returns Array of field API names/patterns that require anonymization
   */
  getRequiredFields(framework: ComplianceFrameworkType): string[] {
    return FRAMEWORK_FIELDS[framework] ?? [];
  }

  /**
   * Generate suggested anonymization rules for fields that are not yet covered.
   * @param framework - The compliance framework
   * @param objectApiName - The Salesforce object API name
   * @param fields - The field names available on the object
   * @returns Suggested anonymization rules for matching fields
   */
  getSuggestedRules(
    framework: ComplianceFrameworkType,
    objectApiName: string,
    fields: string[],
  ): DataOpsAnonymizationRule[] {
    const requiredFields = this.getRequiredFields(framework);
    const suggestions: DataOpsAnonymizationRule[] = [];

    for (const field of fields) {
      if (requiredFields.includes(field)) {
        suggestions.push({
          objectApiName,
          fieldApiName: field,
          method: this.inferRuleType(field),
          config: this.inferConfig(field),
        });
      }
    }

    return suggestions;
  }

  /**
   * Check whether a template is fully compliant with a framework.
   * @param template - The anonymization template to evaluate
   * @param framework - The compliance framework to check against
   * @returns True if no rules are missing
   */
  isCompliant(template: AnonymizationTemplate, framework: ComplianceFrameworkType): boolean {
    return this.check(template, framework).compliant;
  }

  private buildSuggestedRule(
    framework: ComplianceFrameworkType,
    fieldApiName: string,
  ): DataOpsAnonymizationRule {
    return {
      objectApiName: this.inferObject(fieldApiName),
      fieldApiName,
      method: this.inferRuleType(fieldApiName),
      config: this.inferConfig(fieldApiName, framework),
    };
  }

  private inferRuleType(fieldApiName: string): DataOpsAnonymizationRule['method'] {
    const lower = fieldApiName.toLowerCase();
    if (lower.includes('email')) {
      return 'fake';
    }
    if (lower.includes('phone')) {
      return 'mask';
    }
    if (lower.includes('ssn') || lower.includes('creditcard') || lower.includes('cvv')) {
      return 'hash';
    }
    if (lower.includes('address')) {
      return 'fake';
    }
    if (lower.includes('birth') || lower.includes('date')) {
      return 'nullify';
    }
    return 'mask';
  }

  private inferConfig(
    fieldApiName: string,
    _framework?: ComplianceFrameworkType,
  ): DataOpsAnonymizationRule['config'] {
    const lower = fieldApiName.toLowerCase();
    if (lower.includes('email')) {
      return { fakerMethod: 'internet.email', fakerLocale: 'en' };
    }
    if (lower.includes('phone')) {
      return { maskChar: '*', maskStart: 0, maskEnd: 6 };
    }
    if (lower.includes('ssn') || lower.includes('creditcard') || lower.includes('cvv')) {
      return { hashAlgorithm: 'sha256', hashSalt: randomBytes(16).toString('hex') };
    }
    if (lower.includes('address')) {
      return { fakerMethod: 'address.streetAddress', fakerLocale: 'en' };
    }
    return { maskChar: '*' };
  }

  private inferObject(fieldApiName: string): string {
    const lower = fieldApiName.toLowerCase();
    if (lower.includes('medical') || lower.includes('health')) {
      return 'HealthRecord__c';
    }
    if (lower.includes('creditcard') || lower.includes('cvv') || lower.includes('billing')) {
      return 'Payment__c';
    }
    return 'Contact';
  }
}
