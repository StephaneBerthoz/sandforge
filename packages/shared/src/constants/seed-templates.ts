import type { SeedTemplate, SeedObjectConfig, FieldRule } from '../types/seed.types.js';

/* ------------------------------------------------------------------ */
/* Helper factories                                                    */
/* ------------------------------------------------------------------ */

/** Build a static field rule. */
function staticRule(fieldApiName: string, value: string | number | boolean): FieldRule {
  return { fieldApiName, ruleType: 'static', config: { staticValue: value } };
}

/** Build a faker field rule. */
function fakerRule(fieldApiName: string, fakerMethod: string): FieldRule {
  return { fieldApiName, ruleType: 'faker', config: { fakerMethod } };
}

/** Build a sequence field rule. */
function sequenceRule(fieldApiName: string, prefix: string, start: number): FieldRule {
  return { fieldApiName, ruleType: 'sequence', config: { sequencePrefix: prefix, sequenceStart: start, sequenceStep: 1 } };
}

/** Build a reference field rule. */
function referenceRule(fieldApiName: string, referenceObject: string, referenceField: string = 'Id'): FieldRule {
  return { fieldApiName, ruleType: 'reference', config: { referenceObject, referenceField } };
}

/** Build a picklist_random field rule. */
function picklistRule(fieldApiName: string, values: string[]): FieldRule {
  return { fieldApiName, ruleType: 'picklist_random', config: { picklistValues: values } };
}

/** Build a random numeric field rule. */
function randomRule(fieldApiName: string, min: number, max: number): FieldRule {
  return { fieldApiName, ruleType: 'random', config: { minValue: min, maxValue: max } };
}

/** Build a SeedObjectConfig. */
function obj(
  objectApiName: string,
  insertOrder: number,
  recordCount: number,
  fieldRules: FieldRule[],
  batchSize: number = 200,
): SeedObjectConfig {
  return { objectApiName, recordCount, fieldRules, excludedFields: [], insertOrder, batchSize };
}

/* ------------------------------------------------------------------ */
/* Shared field-rule sets                                               */
/* ------------------------------------------------------------------ */

const ACCOUNT_FIELD_RULES: FieldRule[] = [
  fakerRule('Name', 'company.name'),
  picklistRule('Industry', ['Technology', 'Finance', 'Healthcare', 'Manufacturing', 'Retail', 'Energy', 'Education']),
  picklistRule('Type', ['Customer', 'Prospect', 'Partner']),
  fakerRule('Phone', 'phone.number'),
  fakerRule('Website', 'internet.url'),
  fakerRule('BillingStreet', 'location.streetAddress'),
  fakerRule('BillingCity', 'location.city'),
  fakerRule('BillingState', 'location.state'),
  fakerRule('BillingPostalCode', 'location.zipCode'),
  staticRule('BillingCountry', 'United States'),
  randomRule('NumberOfEmployees', 10, 50000),
  randomRule('AnnualRevenue', 100000, 50000000),
];

const CONTACT_FIELD_RULES: FieldRule[] = [
  referenceRule('AccountId', 'Account'),
  fakerRule('FirstName', 'person.firstName'),
  fakerRule('LastName', 'person.lastName'),
  fakerRule('Email', 'internet.email'),
  fakerRule('Phone', 'phone.number'),
  fakerRule('Title', 'person.jobTitle'),
  fakerRule('MailingStreet', 'location.streetAddress'),
  fakerRule('MailingCity', 'location.city'),
  fakerRule('MailingState', 'location.state'),
  fakerRule('MailingPostalCode', 'location.zipCode'),
];

/* ------------------------------------------------------------------ */
/* Sales Cloud Starter                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pre-built seed template for Sales Cloud.
 *
 * Insert order: Pricebook2 -> Product2 -> PricebookEntry -> Account ->
 * Contact -> Opportunity -> OpportunityLineItem.
 */
export const SALES_CLOUD_STARTER: SeedTemplate = {
  id: 'prebuilt-sales-cloud-starter',
  name: 'seed.templates.salesCloudStarter.name',
  description: 'seed.templates.salesCloudStarter.description',
  version: 1,
  strategy: 'faker',
  tags: ['prebuilt', 'sales'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  objects: [
    obj('Pricebook2', 0, 1, [
      staticRule('Name', 'Standard Price Book'),
      staticRule('IsActive', true),
    ]),
    obj('Product2', 1, 50, [
      fakerRule('Name', 'commerce.productName'),
      sequenceRule('ProductCode', 'PROD-', 1001),
      staticRule('IsActive', true),
      fakerRule('Description', 'commerce.productDescription'),
      picklistRule('Family', ['Hardware', 'Software', 'Service', 'Subscription']),
    ]),
    obj('PricebookEntry', 2, 50, [
      referenceRule('Pricebook2Id', 'Pricebook2'),
      referenceRule('Product2Id', 'Product2'),
      randomRule('UnitPrice', 10, 5000),
      staticRule('IsActive', true),
    ]),
    obj('Account', 3, 500, ACCOUNT_FIELD_RULES),
    obj('Contact', 4, 1000, CONTACT_FIELD_RULES),
    obj('Opportunity', 5, 2000, [
      referenceRule('AccountId', 'Account'),
      fakerRule('Name', 'company.catchPhrase'),
      picklistRule('StageName', [
        'Prospecting',
        'Qualification',
        'Needs Analysis',
        'Value Proposition',
        'Negotiation/Review',
        'Closed Won',
        'Closed Lost',
      ]),
      fakerRule('CloseDate', 'date.soon'),
      randomRule('Amount', 5000, 500000),
      referenceRule('Pricebook2Id', 'Pricebook2'),
    ]),
    obj('OpportunityLineItem', 6, 4000, [
      referenceRule('OpportunityId', 'Opportunity'),
      referenceRule('PricebookEntryId', 'PricebookEntry'),
      randomRule('Quantity', 1, 100),
      randomRule('UnitPrice', 100, 10000),
    ]),
  ],
};

/* ------------------------------------------------------------------ */
/* Service Cloud Starter                                               */
/* ------------------------------------------------------------------ */

/**
 * Pre-built seed template for Service Cloud.
 *
 * Insert order: Account -> Contact -> Case -> CaseComment -> Knowledge__kav.
 */
export const SERVICE_CLOUD_STARTER: SeedTemplate = {
  id: 'prebuilt-service-cloud-starter',
  name: 'seed.templates.serviceCloudStarter.name',
  description: 'seed.templates.serviceCloudStarter.description',
  version: 1,
  strategy: 'faker',
  tags: ['prebuilt', 'service'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  objects: [
    obj('Account', 0, 200, ACCOUNT_FIELD_RULES),
    obj('Contact', 1, 500, CONTACT_FIELD_RULES),
    obj('Case', 2, 1000, [
      referenceRule('AccountId', 'Account'),
      referenceRule('ContactId', 'Contact'),
      fakerRule('Subject', 'lorem.sentence'),
      fakerRule('Description', 'lorem.paragraph'),
      picklistRule('Status', ['New', 'Working', 'Escalated', 'Closed']),
      picklistRule('Priority', ['Low', 'Medium', 'High', 'Critical']),
      picklistRule('Origin', ['Phone', 'Email', 'Web']),
      picklistRule('Type', ['Problem', 'Feature Request', 'Question']),
    ]),
    obj('CaseComment', 3, 2000, [
      referenceRule('ParentId', 'Case'),
      fakerRule('CommentBody', 'lorem.paragraph'),
      staticRule('IsPublished', false),
    ]),
    obj('Knowledge__kav', 4, 100, [
      fakerRule('Title', 'lorem.sentence'),
      sequenceRule('UrlName', 'kb-article-', 1),
      fakerRule('Summary', 'lorem.paragraph'),
      staticRule('PublishStatus', 'Online'),
      staticRule('Language', 'en_US'),
    ]),
  ],
};

/* ------------------------------------------------------------------ */
/* Minimal Demo                                                        */
/* ------------------------------------------------------------------ */

/**
 * Lightweight demo template with just Account, Contact, Opportunity.
 * No Pricebook chain required since OLI is excluded.
 */
export const MINIMAL_DEMO: SeedTemplate = {
  id: 'prebuilt-minimal-demo',
  name: 'seed.templates.minimalDemo.name',
  description: 'seed.templates.minimalDemo.description',
  version: 1,
  strategy: 'faker',
  tags: ['prebuilt', 'demo'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  objects: [
    obj('Account', 0, 50, ACCOUNT_FIELD_RULES),
    obj('Contact', 1, 100, CONTACT_FIELD_RULES),
    obj('Opportunity', 2, 200, [
      referenceRule('AccountId', 'Account'),
      fakerRule('Name', 'company.catchPhrase'),
      picklistRule('StageName', [
        'Prospecting',
        'Qualification',
        'Needs Analysis',
        'Value Proposition',
        'Negotiation/Review',
        'Closed Won',
        'Closed Lost',
      ]),
      fakerRule('CloseDate', 'date.soon'),
      randomRule('Amount', 5000, 500000),
    ]),
  ],
};

/* ------------------------------------------------------------------ */
/* Convenience array                                                   */
/* ------------------------------------------------------------------ */

/** All pre-built seed templates. */
export const PREBUILT_SEED_TEMPLATES: SeedTemplate[] = [
  SALES_CLOUD_STARTER,
  SERVICE_CLOUD_STARTER,
  MINIMAL_DEMO,
];
