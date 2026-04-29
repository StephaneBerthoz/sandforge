/**
 * Anonymization presets for the Forge module.
 *
 * Each preset is a curated bundle of (objectApiName → fieldNames[]) pairs
 * the wizard offers as a one-click starting point in the Anonymization
 * tab. Devs pick a preset based on the data sensitivity of their use
 * case — they can still override the field selection per-object before
 * executing.
 *
 * Presets are intentionally simple data — no behaviour. The actual
 * anonymization logic lives in the existing `ForgeAnonymizer` service.
 */

/** A single (object, field) anonymization rule. */
export interface ForgeAnonymizationRule {
  objectApiName: string;
  fieldNames: string[];
}

/** A named bundle of anonymization rules surfaced in the wizard. */
export interface ForgeAnonymizationPreset {
  /** Stable id (used by the UI selector). */
  id: string;
  /** Human-readable name shown in the dropdown. */
  name: string;
  /** Short description shown under the name. */
  description: string;
  /** Rules applied when the preset is selected. */
  rules: ForgeAnonymizationRule[];
}

/**
 * Built-in anonymization presets. Order matches recommended default
 * exposure in the wizard dropdown — `gdpr-default` is the safest pick
 * for most CRM clones.
 */
export const FORGE_ANONYMIZATION_PRESETS: readonly ForgeAnonymizationPreset[] = Object.freeze([
  {
    id: 'preset:gdpr-default',
    name: 'GDPR — default',
    description:
      'Anonymize email, phone, postal address, and date of birth on Account/Contact/Lead. Safe baseline for any CRM dev sandbox.',
    rules: [
      {
        objectApiName: 'Account',
        fieldNames: [
          'PersonEmail',
          'PersonHomePhone',
          'PersonMobilePhone',
          'PersonOtherPhone',
          'PersonAssistantPhone',
          'BillingStreet',
          'BillingPostalCode',
          'ShippingStreet',
          'ShippingPostalCode',
          'PersonBirthdate',
        ],
      },
      {
        objectApiName: 'Contact',
        fieldNames: [
          'Email',
          'Phone',
          'MobilePhone',
          'HomePhone',
          'OtherPhone',
          'AssistantPhone',
          'MailingStreet',
          'MailingPostalCode',
          'OtherStreet',
          'Birthdate',
        ],
      },
      {
        objectApiName: 'Lead',
        fieldNames: ['Email', 'Phone', 'MobilePhone', 'Street', 'PostalCode'],
      },
    ],
  },
  {
    id: 'preset:gdpr-strict',
    name: 'GDPR — strict',
    description:
      'Everything in `GDPR default` plus FirstName/LastName, fax, government IDs, and free-text Description fields. Use for external demos or compliance audits.',
    rules: [
      {
        objectApiName: 'Account',
        fieldNames: [
          'Name',
          'FirstName',
          'LastName',
          'PersonEmail',
          'PersonHomePhone',
          'PersonMobilePhone',
          'PersonOtherPhone',
          'BillingStreet',
          'BillingPostalCode',
          'BillingCity',
          'ShippingStreet',
          'ShippingPostalCode',
          'ShippingCity',
          'PersonBirthdate',
          'Fax',
          'Description',
        ],
      },
      {
        objectApiName: 'Contact',
        fieldNames: [
          'FirstName',
          'LastName',
          'Email',
          'Phone',
          'MobilePhone',
          'HomePhone',
          'OtherPhone',
          'Fax',
          'MailingStreet',
          'MailingPostalCode',
          'MailingCity',
          'OtherStreet',
          'Birthdate',
          'Description',
        ],
      },
      {
        objectApiName: 'Lead',
        fieldNames: [
          'FirstName',
          'LastName',
          'Email',
          'Phone',
          'MobilePhone',
          'Fax',
          'Street',
          'PostalCode',
          'City',
          'Description',
        ],
      },
    ],
  },
  {
    id: 'preset:healthcare',
    name: 'Healthcare — PHI',
    description:
      'Anonymize PHI fields on insurance and patient-related custom objects (PolicyNumber__c, AssistanceRef__c, Birthdate__c, ...). Use on REDACTED-CLIENT-style health-services orgs.',
    rules: [
      {
        objectApiName: 'Contact',
        fieldNames: ['Email', 'Phone', 'MobilePhone', 'Birthdate', 'MailingStreet', 'MailingPostalCode'],
      },
      {
        objectApiName: 'Account',
        fieldNames: [
          'PersonEmail',
          'PersonMobilePhone',
          'PersonBirthdate',
          'BillingStreet',
          'BillingPostalCode',
        ],
      },
      {
        objectApiName: 'Asset',
        fieldNames: ['PolicyNumber__c', 'AssistanceRef__c', 'Address'],
      },
      {
        objectApiName: 'InsurancePolicy',
        fieldNames: ['PolicyNumber__c', 'AssistanceRef__c'],
      },
      {
        objectApiName: 'CaseContact__c',
        fieldNames: ['Email__c', 'Phone__c', 'Birthdate__c', 'Address__c', 'LicenseDate__c'],
      },
    ],
  },
  {
    id: 'preset:internal-test',
    name: 'Internal test — minimal',
    description:
      'Lightweight: only obvious direct identifiers (email, mobile). Use when sharing the cloned sandbox stays inside the team and PII risk is low.',
    rules: [
      {
        objectApiName: 'Contact',
        fieldNames: ['Email', 'MobilePhone'],
      },
      {
        objectApiName: 'Account',
        fieldNames: ['PersonEmail', 'PersonMobilePhone'],
      },
      {
        objectApiName: 'Lead',
        fieldNames: ['Email', 'MobilePhone'],
      },
    ],
  },
]);

/** Lookup helper used by the wizard selector. */
export function findForgeAnonymizationPreset(
  id: string,
): ForgeAnonymizationPreset | undefined {
  return FORGE_ANONYMIZATION_PRESETS.find((p) => p.id === id);
}
