import { describe, it, expect } from 'vitest';
import type { SeedTemplate } from '../types/seed.types.js';
import { plannedChildCount, relationFor } from '../utils/seed-relations.js';
import { seedsStandardPricebook } from './standard-pricebook.js';
import {
  CRM_STARTER,
  LEADS_ACTIVITIES_STARTER,
  SALES_CLOUD_STARTER,
  SERVICE_CLOUD_STARTER,
  MINIMAL_DEMO,
  PREBUILT_SEED_TEMPLATES,
} from './seed-templates.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const VALID_RULE_TYPES = new Set([
  'static',
  'random',
  'sequence',
  'formula',
  'reference',
  'picklist_random',
  'ai_generate',
  'faker',
  'regex',
  'from_csv',
]);

/** The data storage of a new Developer Edition, in bytes. */
const DEVELOPER_EDITION_STORAGE = 5 * 1024 * 1024;

/** The storage a record takes, as Salesforce documents it: 2 KB, a campaign 8 KB. */
function storageBytes(template: SeedTemplate): number {
  return template.objects.reduce(
    (sum, o) => sum + o.recordCount * (o.objectApiName === 'Campaign' ? 8 : 2) * 1024,
    0,
  );
}

/** Every record a template writes. */
function totalRecords(template: SeedTemplate): number {
  return template.objects.reduce((sum, o) => sum + o.recordCount, 0);
}

/** The rule a template's object has on a field, if any. */
function ruleOf(template: SeedTemplate, objectApiName: string, fieldApiName: string) {
  return template.objects
    .find((o) => o.objectApiName === objectApiName)
    ?.fieldRules.find((r) => r.fieldApiName === fieldApiName);
}

/** Assert insertOrder is a contiguous 0..N sequence. */
function assertInsertOrderSequential(template: SeedTemplate): void {
  const orders = template.objects.map((o) => o.insertOrder).sort((a, b) => a - b);
  orders.forEach((order, idx) => {
    expect(order).toBe(idx);
  });
}

/** Assert no duplicate objectApiName within a template. */
function assertNoDuplicateObjects(template: SeedTemplate): void {
  const names = template.objects.map((o) => o.objectApiName);
  expect(new Set(names).size).toBe(names.length);
}

/**
 * Assert every reference rule and every relation points to an object that
 * appears earlier in insertOrder — the org's standard price book apart, which
 * a run matches and never writes.
 */
function assertReferentialIntegrity(template: SeedTemplate): void {
  const orderMap = new Map<string, number>();
  for (const obj of template.objects) {
    orderMap.set(obj.objectApiName, obj.insertOrder);
  }
  const written = new Set(orderMap.keys());

  for (const obj of template.objects) {
    for (const rule of obj.fieldRules) {
      if (seedsStandardPricebook(rule, written)) continue;
      if (rule.ruleType === 'reference' && rule.config.referenceObject) {
        const refOrder = orderMap.get(rule.config.referenceObject);
        expect(
          refOrder,
          `${obj.objectApiName}.${rule.fieldApiName} references unknown object ${rule.config.referenceObject}`,
        ).toBeDefined();
        expect(
          refOrder,
          `${obj.objectApiName}.${rule.fieldApiName}: ${rule.config.referenceObject} must be inserted before ${obj.objectApiName}`,
        ).toBeLessThan(obj.insertOrder);
      }
    }
  }
  for (const relation of template.relations ?? []) {
    const child = orderMap.get(relation.childObject);
    const parent = orderMap.get(relation.parentObject);
    expect(child, `relation child ${relation.childObject}`).toBeDefined();
    expect(parent, `relation parent ${relation.parentObject}`).toBeDefined();
    expect(parent ?? Infinity).toBeLessThan(child ?? -Infinity);
  }
}

/**
 * Assert each child a relation fills counts exactly what the relation gives
 * its parents: the gallery shows the counts, and the run writes the
 * relation's.
 */
function assertRelationCounts(template: SeedTemplate): void {
  for (const relation of template.relations ?? []) {
    const parent = template.objects.find((o) => o.objectApiName === relation.parentObject);
    const child = template.objects.find((o) => o.objectApiName === relation.childObject);
    // Placed by key, a child counts its rows.
    expect(child?.recordCount, `${relation.childObject} count`).toBe(
      relation.distribution.mode === 'byKey'
        ? child?.rows?.length
        : plannedChildCount(relation.distribution, parent?.recordCount ?? 0),
    );
  }
}

/** Assert all field rules have valid ruleType values. */
function assertValidRuleTypes(template: SeedTemplate): void {
  for (const obj of template.objects) {
    for (const rule of obj.fieldRules) {
      expect(
        VALID_RULE_TYPES.has(rule.ruleType),
        `Invalid ruleType "${rule.ruleType}" on ${obj.objectApiName}.${rule.fieldApiName}`,
      ).toBe(true);
    }
  }
}

/* ------------------------------------------------------------------ */
/* PREBUILT_SEED_TEMPLATES array                                       */
/* ------------------------------------------------------------------ */

describe('PREBUILT_SEED_TEMPLATES', () => {
  it('should reference the named exports', () => {
    expect(PREBUILT_SEED_TEMPLATES).toEqual([
      CRM_STARTER,
      LEADS_ACTIVITIES_STARTER,
      MINIMAL_DEMO,
      SERVICE_CLOUD_STARTER,
      SALES_CLOUD_STARTER,
    ]);
  });

  it('opens on a template a new Developer Edition stores whole', () => {
    const [first] = PREBUILT_SEED_TEMPLATES;
    expect(first).toBe(CRM_STARTER);
    expect(storageBytes(first)).toBeLessThan(DEVELOPER_EDITION_STORAGE / 4);
    expect(totalRecords(first)).toBeGreaterThanOrEqual(250);
    expect(totalRecords(first)).toBeLessThanOrEqual(350);
  });

  it('lists the others from the lightest to the heaviest', () => {
    const rest = PREBUILT_SEED_TEMPLATES.slice(1).map(totalRecords);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
  });

  it('covers accounts, contacts, priced opportunities with their line items and cases in the first', () => {
    expect(CRM_STARTER.objects.map((o) => o.objectApiName)).toEqual([
      'Account',
      'Contact',
      'Product2',
      'PricebookEntry',
      'Opportunity',
      'OpportunityLineItem',
      'Case',
    ]);
  });

  it('covers leads, campaigns, their members and activities', () => {
    expect(LEADS_ACTIVITIES_STARTER.objects.map((o) => o.objectApiName)).toEqual([
      'Lead',
      'Campaign',
      'CampaignMember',
      'Task',
      'Event',
    ]);
    expect(storageBytes(LEADS_ACTIVITIES_STARTER)).toBeLessThan(DEVELOPER_EDITION_STORAGE / 4);
  });
});

/* ------------------------------------------------------------------ */
/* What the platform holds a template to                               */
/* ------------------------------------------------------------------ */

describe('the built-in templates and the platform', () => {
  it('never create a price book: a price goes to the standard one, which every org has', () => {
    for (const template of PREBUILT_SEED_TEMPLATES) {
      expect(template.objects.map((o) => o.objectApiName)).not.toContain('Pricebook2');
      const written = new Set(template.objects.map((o) => o.objectApiName));
      for (const objectApiName of ['PricebookEntry', 'Opportunity']) {
        const book = ruleOf(template, objectApiName, 'Pricebook2Id');
        if (book) expect(seedsStandardPricebook(book, written)).toBe(true);
      }
    }
  });

  it('give each product one price, its own, which the book refuses twice', () => {
    for (const template of [CRM_STARTER, SALES_CLOUD_STARTER]) {
      expect(relationFor('PricebookEntry', template.relations)).toMatchObject({
        lookupField: 'Product2Id',
        parentObject: 'Product2',
        distribution: { mode: 'perParent', count: 1 },
      });
      expect(ruleOf(template, 'PricebookEntry', 'Product2Id')).toBeUndefined();
    }
  });

  it('make a lead a member of one campaign, which the campaign holds once', () => {
    expect(relationFor('CampaignMember', LEADS_ACTIVITIES_STARTER.relations)).toMatchObject({
      lookupField: 'LeadId',
      distribution: { mode: 'perParent', count: 1 },
    });
  });

  it("file a case under its contact's account, which the platform fills from the contact", () => {
    for (const template of [CRM_STARTER, SERVICE_CLOUD_STARTER]) {
      expect(relationFor('Case', template.relations)?.lookupField).toBe('ContactId');
      expect(ruleOf(template, 'Case', 'AccountId')).toBeUndefined();
    }
  });

  it("write the picklist values a new org has: no 'Customer', 'Partner' or 'Critical'", () => {
    for (const template of PREBUILT_SEED_TEMPLATES) {
      const type = ruleOf(template, 'Account', 'Type')?.config.picklistValues ?? [];
      expect(type).not.toContain('Customer');
      expect(type).not.toContain('Partner');
      const priority = ruleOf(template, 'Case', 'Priority')?.config.picklistValues ?? [];
      expect(priority).not.toContain('Critical');
    }
  });

  it('set no publication status on an article, which an insert cannot', () => {
    expect(ruleOf(SERVICE_CLOUD_STARTER, 'Knowledge__kav', 'PublishStatus')).toBeUndefined();
  });

  it("draw an account's country with its city, from the run's locale", () => {
    for (const template of PREBUILT_SEED_TEMPLATES) {
      const country = ruleOf(template, 'Account', 'BillingCountry');
      if (country) expect(country.config.fakerMethod).toBe('location.country');
    }
  });

  it('write no lorem into a case subject or a comment', () => {
    for (const template of PREBUILT_SEED_TEMPLATES) {
      for (const object of template.objects) {
        for (const rule of object.fieldRules) {
          expect(
            rule.config.fakerMethod ?? '',
            `${object.objectApiName}.${rule.fieldApiName}`,
          ).not.toMatch(/^lorem/);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Structural invariants, applied uniformly to every prebuilt template */
/* ------------------------------------------------------------------ */

describe.each([
  ['CRM_STARTER', CRM_STARTER],
  ['LEADS_ACTIVITIES_STARTER', LEADS_ACTIVITIES_STARTER],
  ['SALES_CLOUD_STARTER', SALES_CLOUD_STARTER],
  ['SERVICE_CLOUD_STARTER', SERVICE_CLOUD_STARTER],
  ['MINIMAL_DEMO', MINIMAL_DEMO],
])('%s', (_name, template) => {
  it('should have sequential insertOrder 0..N-1', () => {
    assertInsertOrderSequential(template);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(template);
  });

  it('should maintain referential integrity (references point to earlier objects)', () => {
    assertReferentialIntegrity(template);
  });

  it('counts for each child exactly what its relation gives the parents', () => {
    assertRelationCounts(template);
  });

  it('should have valid ruleType values on all field rules', () => {
    assertValidRuleTypes(template);
  });
});
