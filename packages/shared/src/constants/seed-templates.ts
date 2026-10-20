import type {
  SeedTemplate,
  SeedObjectConfig,
  FieldRule,
  SeedRelation,
  SeedRelationDistribution,
} from '../types/seed.types.js';

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
  return {
    fieldApiName,
    ruleType: 'sequence',
    config: { sequencePrefix: prefix, sequenceStart: start, sequenceStep: 1 },
  };
}

/** Build a reference field rule. */
function referenceRule(
  fieldApiName: string,
  referenceObject: string,
  referenceField: string = 'Id',
): FieldRule {
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

/**
 * A lookup filled from the records the run writes for its parent object, each
 * parent receiving what `distribution` gives it. The child's record count in
 * the template is the most the relation writes — what the gallery shows, and
 * what the storage check and the production guard count.
 */
function underParent(
  childObject: string,
  lookupField: string,
  parentObject: string,
  distribution: SeedRelationDistribution,
): SeedRelation {
  return { childObject, lookupField, parentObject, parents: { kind: 'generated' }, distribution };
}

/* ------------------------------------------------------------------ */
/* Shared field-rule sets                                               */
/* ------------------------------------------------------------------ */

/*
 * Picklist values are the ones a new org ships with. The templates wrote
 * "Customer" and "Partner" as account types and "Critical" as a case
 * priority, which no org has: an unrestricted picklist takes them, a report
 * then sets them apart, and the next edit of the record drops them. A run
 * also keeps only the values the target's own picklist has.
 */

const INDUSTRIES = [
  'Technology',
  'Finance',
  'Healthcare',
  'Manufacturing',
  'Retail',
  'Energy',
  'Education',
  'Consulting',
  'Telecommunications',
  'Transportation',
];

const ACCOUNT_TYPES = [
  'Prospect',
  'Customer - Direct',
  'Customer - Channel',
  'Channel Partner / Reseller',
  'Technology Partner',
];

const LEAD_SOURCES = ['Web', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other'];

const OPPORTUNITY_STAGES = [
  'Prospecting',
  'Qualification',
  'Needs Analysis',
  'Value Proposition',
  'Proposal/Price Quote',
  'Negotiation/Review',
  'Closed Won',
  'Closed Lost',
];

/**
 * An account's rules. The country is drawn with the city, state and postal
 * code, from one address of the run's locale: it was fixed to "United
 * States" whatever the locale drew around it.
 */
const ACCOUNT_FIELD_RULES: FieldRule[] = [
  fakerRule('Name', 'company.name'),
  picklistRule('Industry', INDUSTRIES),
  picklistRule('Type', ACCOUNT_TYPES),
  picklistRule('Rating', ['Hot', 'Warm', 'Cold']),
  fakerRule('Phone', 'phone.number'),
  fakerRule('Website', 'internet.url'),
  fakerRule('BillingStreet', 'location.streetAddress'),
  fakerRule('BillingCity', 'location.city'),
  fakerRule('BillingState', 'location.state'),
  fakerRule('BillingPostalCode', 'location.zipCode'),
  fakerRule('BillingCountry', 'location.country'),
  randomRule('NumberOfEmployees', 10, 50000),
  randomRule('AnnualRevenue', 100000, 50000000),
];

/** A contact's rules; its account is the relation's. */
const CONTACT_FIELD_RULES: FieldRule[] = [
  fakerRule('FirstName', 'person.firstName'),
  fakerRule('LastName', 'person.lastName'),
  fakerRule('Email', 'internet.email'),
  fakerRule('Phone', 'phone.number'),
  fakerRule('Title', 'person.jobTitle'),
  picklistRule('LeadSource', LEAD_SOURCES),
  fakerRule('MailingStreet', 'location.streetAddress'),
  fakerRule('MailingCity', 'location.city'),
  fakerRule('MailingState', 'location.state'),
  fakerRule('MailingPostalCode', 'location.zipCode'),
  fakerRule('MailingCountry', 'location.country'),
];

/**
 * An opportunity's rules; its account is the relation's. A close date falls
 * in the weeks to come, and in the weeks past for a closed stage. With line
 * items the amount is theirs, which the platform sums: a template that
 * writes them sets none.
 */
function opportunityRules(withAmount: boolean): FieldRule[] {
  return [
    fakerRule('Name', 'company.catchPhrase'),
    picklistRule('StageName', OPPORTUNITY_STAGES),
    fakerRule('CloseDate', 'date.soon'),
    picklistRule('Type', ['New Customer', 'Existing Customer - Upgrade']),
    picklistRule('LeadSource', LEAD_SOURCES),
    ...(withAmount ? [randomRule('Amount', 5000, 500000)] : []),
  ];
}

const PRODUCT_FIELD_RULES: FieldRule[] = [
  fakerRule('Name', 'commerce.productName'),
  sequenceRule('ProductCode', 'PROD-', 1001),
  staticRule('IsActive', true),
  fakerRule('Description', 'commerce.productDescription'),
];

/**
 * A product's standard price. `Pricebook2Id` names `Pricebook2`, which the
 * template does not write: a run matches it to the org's standard price book,
 * which every org has, active or not, and none can create. The template wrote
 * a price book of its own named "Standard Price Book", which made a second,
 * custom one: the org refused every price in it for want of a standard price
 * (STANDARD_PRICE_NOT_DEFINED), and every line item was then skipped. The
 * relation gives each product one price, its own: a product drawn at random
 * came round twice in about one price in three, which the book refuses.
 */
const PRICEBOOK_ENTRY_FIELD_RULES: FieldRule[] = [
  referenceRule('Pricebook2Id', 'Pricebook2'),
  randomRule('UnitPrice', 20, 2000),
  staticRule('IsActive', true),
];

/** A line item's rules; its opportunity is the relation's, its price drawn among the run's. */
const LINE_ITEM_FIELD_RULES: FieldRule[] = [
  referenceRule('PricebookEntryId', 'PricebookEntry'),
  randomRule('Quantity', 1, 10),
  randomRule('UnitPrice', 20, 2000),
];

/**
 * A case's rules. Its contact is the relation's, and the platform files the
 * case under that contact's account: drawn on their own, the account and the
 * contact of a case belonged to two different companies.
 */
const CASE_FIELD_RULES: FieldRule[] = [
  fakerRule('Subject', 'caseSubject'),
  picklistRule('Status', ['New', 'Working', 'Escalated', 'Closed']),
  picklistRule('Priority', ['High', 'Medium', 'Low']),
  picklistRule('Origin', ['Phone', 'Email', 'Web']),
];

/* ------------------------------------------------------------------ */
/* CRM Starter                                                         */
/* ------------------------------------------------------------------ */

/**
 * The template a new Developer Edition takes whole: accounts with their
 * contacts, opportunities priced from the standard price book with their line
 * items, and cases — 295 records, about 0.6 MB of the 5 MB of data storage
 * such an org has. First in the gallery.
 */
export const CRM_STARTER: SeedTemplate = {
  id: 'prebuilt-crm-starter',
  name: 'seed.templates.crmStarter.name',
  description: 'seed.templates.crmStarter.description',
  version: 1,
  strategy: 'faker',
  tags: ['prebuilt', 'sales', 'service'],
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  objects: [
    obj('Account', 0, 25, ACCOUNT_FIELD_RULES),
    obj('Contact', 1, 75, CONTACT_FIELD_RULES),
    obj('Product2', 2, 10, PRODUCT_FIELD_RULES),
    obj('PricebookEntry', 3, 10, PRICEBOOK_ENTRY_FIELD_RULES),
    obj('Opportunity', 4, 50, [
      ...opportunityRules(false),
      referenceRule('Pricebook2Id', 'Pricebook2'),
    ]),
    obj('OpportunityLineItem', 5, 75, LINE_ITEM_FIELD_RULES),
    obj('Case', 6, 50, CASE_FIELD_RULES),
  ],
  relations: [
    underParent('Contact', 'AccountId', 'Account', { mode: 'perParent', count: 3 }),
    underParent('PricebookEntry', 'Product2Id', 'Product2', { mode: 'perParent', count: 1 }),
    underParent('Opportunity', 'AccountId', 'Account', { mode: 'perParent', count: 2 }),
    underParent('OpportunityLineItem', 'OpportunityId', 'Opportunity', {
      mode: 'ratio',
      ratio: 1.5,
    }),
    underParent('Case', 'ContactId', 'Contact', { mode: 'ratio', ratio: 0.67 }),
  ],
};

/* ------------------------------------------------------------------ */
/* Leads & Activities Starter                                          */
/* ------------------------------------------------------------------ */

/**
 * Leads, the campaigns they answered, and the calls and meetings booked with
 * them — what the Trailhead modules on leads, campaigns and activities work
 * with. Each lead is a member of one campaign: a campaign holds a lead once,
 * and members drawn at random came round twice. A user who may not create
 * campaigns — the Marketing User box — gets the leads and their activities,
 * and a word on the campaigns.
 */
export const LEADS_ACTIVITIES_STARTER: SeedTemplate = {
  id: 'prebuilt-leads-activities-starter',
  name: 'seed.templates.leadsActivitiesStarter.name',
  description: 'seed.templates.leadsActivitiesStarter.description',
  version: 1,
  strategy: 'faker',
  tags: ['prebuilt', 'marketing', 'activities'],
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  objects: [
    obj('Lead', 0, 40, [
      fakerRule('FirstName', 'person.firstName'),
      fakerRule('LastName', 'person.lastName'),
      fakerRule('Company', 'company.name'),
      fakerRule('Title', 'person.jobTitle'),
      fakerRule('Email', 'internet.email'),
      fakerRule('Phone', 'phone.number'),
      // A converted status is the conversion's to set.
      picklistRule('Status', [
        'Open - Not Contacted',
        'Working - Contacted',
        'Closed - Not Converted',
      ]),
      picklistRule('LeadSource', LEAD_SOURCES),
      picklistRule('Industry', INDUSTRIES),
      picklistRule('Rating', ['Hot', 'Warm', 'Cold']),
      fakerRule('Street', 'location.streetAddress'),
      fakerRule('City', 'location.city'),
      fakerRule('State', 'location.state'),
      fakerRule('PostalCode', 'location.zipCode'),
      fakerRule('Country', 'location.country'),
    ]),
    obj('Campaign', 1, 3, [
      fakerRule('Name', 'company.catchPhrase'),
      picklistRule('Type', ['Webinar', 'Email', 'Conference', 'Trade Show']),
      picklistRule('Status', ['Planned', 'In Progress', 'Completed']),
      staticRule('IsActive', true),
      fakerRule('StartDate', 'date.past'),
      fakerRule('EndDate', 'date.soon'),
    ]),
    obj('CampaignMember', 2, 40, [
      referenceRule('CampaignId', 'Campaign'),
      picklistRule('Status', ['Sent', 'Responded']),
    ]),
    obj('Task', 3, 20, [
      picklistRule('Subject', ['Call', 'Email', 'Send Quote']),
      picklistRule('Status', ['Not Started', 'In Progress', 'Completed']),
      picklistRule('Priority', ['High', 'Normal', 'Low']),
      fakerRule('ActivityDate', 'date.soon'),
    ]),
    obj('Event', 4, 10, [
      picklistRule('Subject', ['Meeting', 'Call']),
      fakerRule('StartDateTime', 'futureDateTime'),
      randomRule('DurationInMinutes', 30, 90),
    ]),
  ],
  relations: [
    underParent('CampaignMember', 'LeadId', 'Lead', { mode: 'perParent', count: 1 }),
    underParent('Task', 'WhoId', 'Lead', { mode: 'ratio', ratio: 0.5 }),
    underParent('Event', 'WhoId', 'Lead', { mode: 'ratio', ratio: 0.25 }),
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
    obj('Opportunity', 2, 200, opportunityRules(true)),
  ],
  relations: [
    underParent('Contact', 'AccountId', 'Account', { mode: 'perParent', count: 2 }),
    underParent('Opportunity', 'AccountId', 'Account', { mode: 'perParent', count: 4 }),
  ],
};

/* ------------------------------------------------------------------ */
/* Service Cloud Starter                                               */
/* ------------------------------------------------------------------ */

/**
 * Pre-built seed template for Service Cloud: 3,800 records, about 7.6 MB —
 * more than a Developer Edition holds.
 *
 * Insert order: Account -> Contact -> Case -> CaseComment -> Knowledge__kav.
 * An org without Salesforce Knowledge has no `Knowledge__kav`, and the run
 * skips the articles with that reason: it tried to insert them, and every one
 * was refused. An article is inserted as a draft: its publication status is
 * not set on create.
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
    obj('Case', 2, 1000, CASE_FIELD_RULES),
    obj('CaseComment', 3, 2000, [
      fakerRule('CommentBody', 'caseComment'),
      staticRule('IsPublished', false),
    ]),
    obj('Knowledge__kav', 4, 100, [
      fakerRule('Title', 'caseSubject'),
      fakerRule('UrlName', 'string.uuid'),
      staticRule('Language', 'en_US'),
    ]),
  ],
  relations: [
    underParent('Contact', 'AccountId', 'Account', { mode: 'ratio', ratio: 2.5 }),
    underParent('Case', 'ContactId', 'Contact', { mode: 'perParent', count: 2 }),
    underParent('CaseComment', 'ParentId', 'Case', { mode: 'perParent', count: 2 }),
  ],
};

/* ------------------------------------------------------------------ */
/* Sales Cloud Starter                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pre-built seed template for Sales Cloud: 7,600 records, about 15 MB — more
 * than a Developer Edition holds.
 *
 * Insert order: Product2 -> PricebookEntry (the standard prices) -> Account ->
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
    obj('Product2', 0, 50, PRODUCT_FIELD_RULES),
    obj('PricebookEntry', 1, 50, PRICEBOOK_ENTRY_FIELD_RULES),
    obj('Account', 2, 500, ACCOUNT_FIELD_RULES),
    obj('Contact', 3, 1000, CONTACT_FIELD_RULES),
    obj('Opportunity', 4, 2000, [
      ...opportunityRules(false),
      referenceRule('Pricebook2Id', 'Pricebook2'),
    ]),
    obj('OpportunityLineItem', 5, 4000, LINE_ITEM_FIELD_RULES),
  ],
  relations: [
    underParent('PricebookEntry', 'Product2Id', 'Product2', { mode: 'perParent', count: 1 }),
    underParent('Contact', 'AccountId', 'Account', { mode: 'perParent', count: 2 }),
    underParent('Opportunity', 'AccountId', 'Account', { mode: 'perParent', count: 4 }),
    underParent('OpportunityLineItem', 'OpportunityId', 'Opportunity', {
      mode: 'perParent',
      count: 2,
    }),
  ],
};

/* ------------------------------------------------------------------ */
/* Convenience array                                                   */
/* ------------------------------------------------------------------ */

/**
 * All pre-built seed templates, in gallery order: the one a new Developer
 * Edition takes whole first, then the others from the lightest to the
 * heaviest. Sales Cloud Starter came first, and its 7,601 records were three
 * times what such an org can store.
 */
export const PREBUILT_SEED_TEMPLATES: SeedTemplate[] = [
  CRM_STARTER,
  LEADS_ACTIVITIES_STARTER,
  MINIMAL_DEMO,
  SERVICE_CLOUD_STARTER,
  SALES_CLOUD_STARTER,
];
