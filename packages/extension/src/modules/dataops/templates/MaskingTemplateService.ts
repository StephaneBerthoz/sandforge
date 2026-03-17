/**
 * Pre-built data masking templates for common Salesforce objects.
 *
 * Provides field-level anonymization rules for Account, Contact, Lead,
 * Opportunity, Case, and User objects. Each template defines which fields
 * to mask and the recommended masking method (fake, mask, hash, nullify, etc.).
 */

/** A single field masking rule. */
export interface FieldMaskingRule {
  /** Salesforce field API name. */
  fieldApiName: string;
  /** Masking method to apply. */
  ruleType: 'fake' | 'mask' | 'hash' | 'nullify' | 'preserve_format' | 'constant' | 'truncate' | 'shuffle';
  /** Human-readable description. */
  description: string;
  /** Whether this rule is recommended for sandbox scrubbing. */
  recommended: boolean;
}

/** Masking template for a specific Salesforce object. */
export interface ObjectMaskingTemplate {
  /** Salesforce object API name (e.g. 'Account'). */
  objectApiName: string;
  /** Human-readable label. */
  label: string;
  /** Field masking rules for this object. */
  rules: FieldMaskingRule[];
}

/** Pre-built masking templates keyed by object API name. */
const MASKING_TEMPLATES: Record<string, ObjectMaskingTemplate> = {
  Account: {
    objectApiName: 'Account',
    label: 'Account',
    rules: [
      { fieldApiName: 'Name', ruleType: 'fake', description: 'Replace with fake company name', recommended: true },
      { fieldApiName: 'Phone', ruleType: 'mask', description: 'Mask phone keeping last 4 digits', recommended: true },
      { fieldApiName: 'Fax', ruleType: 'nullify', description: 'Clear fax number', recommended: false },
      { fieldApiName: 'Website', ruleType: 'constant', description: 'Replace with placeholder URL', recommended: true },
      { fieldApiName: 'BillingStreet', ruleType: 'fake', description: 'Replace with fake street address', recommended: true },
      { fieldApiName: 'BillingCity', ruleType: 'fake', description: 'Replace with fake city', recommended: true },
      { fieldApiName: 'BillingPostalCode', ruleType: 'mask', description: 'Mask postal code', recommended: true },
      { fieldApiName: 'ShippingStreet', ruleType: 'fake', description: 'Replace with fake street address', recommended: false },
      { fieldApiName: 'ShippingCity', ruleType: 'fake', description: 'Replace with fake city', recommended: false },
      { fieldApiName: 'ShippingPostalCode', ruleType: 'mask', description: 'Mask postal code', recommended: false },
      { fieldApiName: 'Description', ruleType: 'constant', description: 'Replace with placeholder text', recommended: false },
      { fieldApiName: 'AnnualRevenue', ruleType: 'shuffle', description: 'Shuffle values across records', recommended: false },
    ],
  },
  Contact: {
    objectApiName: 'Contact',
    label: 'Contact',
    rules: [
      { fieldApiName: 'FirstName', ruleType: 'fake', description: 'Replace with fake first name', recommended: true },
      { fieldApiName: 'LastName', ruleType: 'fake', description: 'Replace with fake last name', recommended: true },
      { fieldApiName: 'Email', ruleType: 'fake', description: 'Replace with fake email address', recommended: true },
      { fieldApiName: 'Phone', ruleType: 'mask', description: 'Mask phone keeping last 4 digits', recommended: true },
      { fieldApiName: 'MobilePhone', ruleType: 'mask', description: 'Mask mobile phone', recommended: true },
      { fieldApiName: 'HomePhone', ruleType: 'nullify', description: 'Clear home phone', recommended: false },
      { fieldApiName: 'OtherPhone', ruleType: 'nullify', description: 'Clear other phone', recommended: false },
      { fieldApiName: 'MailingStreet', ruleType: 'fake', description: 'Replace with fake street address', recommended: true },
      { fieldApiName: 'MailingCity', ruleType: 'fake', description: 'Replace with fake city', recommended: true },
      { fieldApiName: 'MailingPostalCode', ruleType: 'mask', description: 'Mask postal code', recommended: true },
      { fieldApiName: 'Birthdate', ruleType: 'nullify', description: 'Clear date of birth', recommended: true },
      { fieldApiName: 'Title', ruleType: 'fake', description: 'Replace with fake job title', recommended: false },
      { fieldApiName: 'Description', ruleType: 'constant', description: 'Replace with placeholder', recommended: false },
    ],
  },
  Lead: {
    objectApiName: 'Lead',
    label: 'Lead',
    rules: [
      { fieldApiName: 'FirstName', ruleType: 'fake', description: 'Replace with fake first name', recommended: true },
      { fieldApiName: 'LastName', ruleType: 'fake', description: 'Replace with fake last name', recommended: true },
      { fieldApiName: 'Email', ruleType: 'fake', description: 'Replace with fake email address', recommended: true },
      { fieldApiName: 'Phone', ruleType: 'mask', description: 'Mask phone keeping last 4 digits', recommended: true },
      { fieldApiName: 'MobilePhone', ruleType: 'mask', description: 'Mask mobile phone', recommended: false },
      { fieldApiName: 'Company', ruleType: 'fake', description: 'Replace with fake company name', recommended: true },
      { fieldApiName: 'Street', ruleType: 'fake', description: 'Replace with fake street address', recommended: true },
      { fieldApiName: 'City', ruleType: 'fake', description: 'Replace with fake city', recommended: true },
      { fieldApiName: 'PostalCode', ruleType: 'mask', description: 'Mask postal code', recommended: true },
      { fieldApiName: 'Website', ruleType: 'constant', description: 'Replace with placeholder URL', recommended: false },
      { fieldApiName: 'Title', ruleType: 'fake', description: 'Replace with fake job title', recommended: false },
      { fieldApiName: 'Description', ruleType: 'constant', description: 'Replace with placeholder', recommended: false },
    ],
  },
  Opportunity: {
    objectApiName: 'Opportunity',
    label: 'Opportunity',
    rules: [
      { fieldApiName: 'Name', ruleType: 'fake', description: 'Replace with fake opportunity name', recommended: true },
      { fieldApiName: 'Amount', ruleType: 'shuffle', description: 'Shuffle amounts across records', recommended: true },
      { fieldApiName: 'Description', ruleType: 'constant', description: 'Replace with placeholder', recommended: false },
      { fieldApiName: 'NextStep', ruleType: 'constant', description: 'Replace with placeholder', recommended: false },
    ],
  },
  Case: {
    objectApiName: 'Case',
    label: 'Case',
    rules: [
      { fieldApiName: 'Subject', ruleType: 'fake', description: 'Replace with fake subject', recommended: true },
      { fieldApiName: 'Description', ruleType: 'constant', description: 'Replace with placeholder text', recommended: true },
      { fieldApiName: 'SuppliedName', ruleType: 'fake', description: 'Replace with fake name', recommended: true },
      { fieldApiName: 'SuppliedEmail', ruleType: 'fake', description: 'Replace with fake email', recommended: true },
      { fieldApiName: 'SuppliedPhone', ruleType: 'mask', description: 'Mask phone number', recommended: true },
      { fieldApiName: 'SuppliedCompany', ruleType: 'fake', description: 'Replace with fake company', recommended: false },
    ],
  },
  User: {
    objectApiName: 'User',
    label: 'User',
    rules: [
      { fieldApiName: 'FirstName', ruleType: 'fake', description: 'Replace with fake first name', recommended: false },
      { fieldApiName: 'LastName', ruleType: 'fake', description: 'Replace with fake last name', recommended: false },
      { fieldApiName: 'Email', ruleType: 'preserve_format', description: 'Replace keeping email format', recommended: true },
      { fieldApiName: 'Phone', ruleType: 'mask', description: 'Mask phone number', recommended: false },
      { fieldApiName: 'MobilePhone', ruleType: 'mask', description: 'Mask mobile phone', recommended: false },
      { fieldApiName: 'Street', ruleType: 'nullify', description: 'Clear street address', recommended: false },
      { fieldApiName: 'City', ruleType: 'nullify', description: 'Clear city', recommended: false },
      { fieldApiName: 'PostalCode', ruleType: 'nullify', description: 'Clear postal code', recommended: false },
    ],
  },
};

/**
 * Service that provides pre-built masking templates for Salesforce objects.
 * Templates can be queried by object name and customized before application.
 */
export class MaskingTemplateService {
  /**
   * Get all available masking templates.
   * @returns Array of all object masking templates.
   */
  getAllTemplates(): ObjectMaskingTemplate[] {
    return Object.values(MASKING_TEMPLATES);
  }

  /**
   * Get the masking template for a specific object.
   * @param objectApiName - Salesforce object API name.
   * @returns The template or undefined if no template exists.
   */
  getTemplate(objectApiName: string): ObjectMaskingTemplate | undefined {
    return MASKING_TEMPLATES[objectApiName];
  }

  /**
   * Get masking rules for a specific object, optionally filtered to recommended-only.
   * @param objectApiName - Salesforce object API name.
   * @param recommendedOnly - If true, only return recommended rules.
   * @returns Array of field masking rules.
   */
  getRulesForObject(objectApiName: string, recommendedOnly: boolean = false): FieldMaskingRule[] {
    const template = MASKING_TEMPLATES[objectApiName];
    if (!template) return [];

    if (recommendedOnly) {
      return template.rules.filter((r) => r.recommended);
    }
    return [...template.rules];
  }

  /**
   * Get the list of objects that have masking templates.
   * @returns Array of object API names.
   */
  getSupportedObjects(): string[] {
    return Object.keys(MASKING_TEMPLATES);
  }

  /**
   * Check if a masking template exists for an object.
   * @param objectApiName - Salesforce object API name.
   * @returns true if a template exists.
   */
  hasTemplate(objectApiName: string): boolean {
    return objectApiName in MASKING_TEMPLATES;
  }
}
