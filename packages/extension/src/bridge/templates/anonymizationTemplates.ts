import type { ListedAnonymizationTemplate } from '@sandforge/shared';

/**
 * Predefined anonymization rule templates for data privacy compliance.
 *
 * A rule whose method needs a setting carries it here: the value a constant
 * writes, how much of a value a truncation keeps. Without them a constant
 * wrote an empty value and a truncation kept nothing. A hash rule carries no
 * salt: the run hashes with the key its window draws, and a salt written into
 * a template ships to everyone who installs it.
 */
export const ANONYMIZATION_TEMPLATES = [
  {
    id: 'tpl-gdpr-standard',
    name: 'GDPR Standard',
    description:
      'Standard GDPR compliance: anonymize personal data fields across common Salesforce objects.',
    complianceFramework: 'gdpr',
    rules: [
      {
        fieldPattern: 'Contact.FirstName',
        ruleType: 'fake',
        description: 'Replace with fake first name.',
      },
      {
        fieldPattern: 'Contact.LastName',
        ruleType: 'fake',
        description: 'Replace with fake last name.',
      },
      {
        fieldPattern: 'Contact.Email',
        ruleType: 'fake',
        description: 'Replace with fake email address.',
      },
      {
        fieldPattern: 'Contact.Phone',
        ruleType: 'mask',
        description: 'Mask phone number (keep last 4 digits).',
        // Without it the mask ran to the end of the value, and no digit was kept.
        config: { maskKeepLast: 4 },
      },
      {
        fieldPattern: 'Contact.MailingStreet',
        ruleType: 'fake',
        description: 'Replace with fake street address.',
      },
      {
        fieldPattern: 'Contact.MailingCity',
        ruleType: 'fake',
        description: 'Replace with fake city.',
      },
      {
        fieldPattern: 'Contact.MailingPostalCode',
        ruleType: 'mask',
        description: 'Mask postal code.',
      },
      {
        fieldPattern: 'Lead.FirstName',
        ruleType: 'fake',
        description: 'Replace with fake first name.',
      },
      {
        fieldPattern: 'Lead.LastName',
        ruleType: 'fake',
        description: 'Replace with fake last name.',
      },
      {
        fieldPattern: 'Lead.Email',
        ruleType: 'fake',
        description: 'Replace with fake email address.',
      },
      { fieldPattern: 'Lead.Phone', ruleType: 'mask', description: 'Mask phone number.' },
      {
        fieldPattern: 'Lead.Street',
        ruleType: 'fake',
        description: 'Replace with fake street address.',
      },
      {
        fieldPattern: 'Account.BillingStreet',
        ruleType: 'fake',
        description: 'Replace with fake address.',
      },
      { fieldPattern: 'Account.Phone', ruleType: 'mask', description: 'Mask phone number.' },
    ],
  },
  {
    id: 'tpl-ccpa-california',
    name: 'CCPA California',
    description:
      'CCPA compliance: anonymize consumer personal information per California privacy regulations.',
    complianceFramework: 'ccpa',
    rules: [
      {
        fieldPattern: 'Contact.FirstName',
        ruleType: 'fake',
        description: 'Replace consumer first name.',
      },
      {
        fieldPattern: 'Contact.LastName',
        ruleType: 'fake',
        description: 'Replace consumer last name.',
      },
      {
        fieldPattern: 'Contact.Email',
        ruleType: 'hash',
        description: 'Hash email for pseudonymization.',
      },
      { fieldPattern: 'Contact.Phone', ruleType: 'nullify', description: 'Nullify phone number.' },
      {
        fieldPattern: 'Contact.MailingStreet',
        ruleType: 'nullify',
        description: 'Nullify street address.',
      },
      { fieldPattern: 'Contact.MailingCity', ruleType: 'nullify', description: 'Nullify city.' },
      {
        fieldPattern: 'Contact.MailingPostalCode',
        ruleType: 'nullify',
        description: 'Nullify postal code.',
      },
      {
        fieldPattern: 'Contact.Birthdate',
        ruleType: 'nullify',
        description: 'Remove date of birth.',
      },
      {
        fieldPattern: 'Lead.Email',
        ruleType: 'hash',
        description: 'Hash email for pseudonymization.',
      },
      { fieldPattern: 'Lead.Phone', ruleType: 'nullify', description: 'Nullify phone number.' },
    ],
  },
  {
    id: 'tpl-hipaa-health',
    name: 'HIPAA Health Data',
    description:
      'HIPAA compliance: de-identify protected health information (PHI) in healthcare Salesforce orgs.',
    complianceFramework: 'hipaa',
    rules: [
      {
        fieldPattern: 'Contact.FirstName',
        ruleType: 'fake',
        description: 'Replace patient first name.',
      },
      {
        fieldPattern: 'Contact.LastName',
        ruleType: 'fake',
        description: 'Replace patient last name.',
      },
      { fieldPattern: 'Contact.Email', ruleType: 'hash', description: 'Hash email address.' },
      { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: 'Mask phone number.' },
      {
        fieldPattern: 'Contact.Birthdate',
        ruleType: 'nullify',
        description: 'Remove date of birth (PHI).',
      },
      {
        fieldPattern: 'Contact.MailingStreet',
        ruleType: 'nullify',
        description: 'Remove address (PHI).',
      },
      {
        fieldPattern: 'Contact.MailingCity',
        ruleType: 'nullify',
        description: 'Remove city (PHI).',
      },
      {
        fieldPattern: 'Contact.MailingState',
        ruleType: 'nullify',
        description: 'Remove state (PHI).',
      },
      {
        fieldPattern: 'Contact.MailingPostalCode',
        ruleType: 'truncate',
        description: 'Truncate to first 3 digits.',
        config: { truncateLength: 3, truncateKeep: 'first' },
      },
      { fieldPattern: 'Account.Name', ruleType: 'fake', description: 'Replace facility name.' },
      { fieldPattern: 'Account.Phone', ruleType: 'mask', description: 'Mask facility phone.' },
    ],
  },
  {
    id: 'tpl-sandbox-scrub',
    name: 'Sandbox Data Scrub',
    description: 'General-purpose sandbox data scrubbing: mask all PII for safe development use.',
    complianceFramework: 'custom',
    rules: [
      { fieldPattern: 'Contact.FirstName', ruleType: 'fake', description: 'Fake first name.' },
      { fieldPattern: 'Contact.LastName', ruleType: 'fake', description: 'Fake last name.' },
      {
        fieldPattern: 'Contact.Email',
        ruleType: 'preserve_format',
        description: 'Replace keeping email format.',
      },
      {
        fieldPattern: 'Contact.Phone',
        ruleType: 'preserve_format',
        description: 'Replace keeping phone format.',
      },
      { fieldPattern: 'Lead.FirstName', ruleType: 'fake', description: 'Fake first name.' },
      { fieldPattern: 'Lead.LastName', ruleType: 'fake', description: 'Fake last name.' },
      {
        fieldPattern: 'Lead.Email',
        ruleType: 'preserve_format',
        description: 'Replace keeping email format.',
      },
      { fieldPattern: 'Lead.Company', ruleType: 'fake', description: 'Fake company name.' },
      { fieldPattern: 'Account.Name', ruleType: 'fake', description: 'Fake account name.' },
      {
        fieldPattern: 'Account.Website',
        ruleType: 'constant',
        description: 'Replace with placeholder URL.',
        config: { constantValue: 'https://example.com' },
      },
      { fieldPattern: 'Opportunity.Name', ruleType: 'fake', description: 'Fake opportunity name.' },
    ],
  },
] as const satisfies readonly ListedAnonymizationTemplate[];
