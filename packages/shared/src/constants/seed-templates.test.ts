import { describe, it, expect } from 'vitest';
import type { SeedTemplate, SeedObjectConfig, FieldRule } from '../types/seed.types.js';
import {
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

/** Assert every reference rule points to an object that appears earlier in insertOrder. */
function assertReferentialIntegrity(template: SeedTemplate): void {
  const orderMap = new Map<string, number>();
  for (const obj of template.objects) {
    orderMap.set(obj.objectApiName, obj.insertOrder);
  }

  for (const obj of template.objects) {
    for (const rule of obj.fieldRules) {
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

/** Get the field rule for a given object + field within a template. */
function getRule(
  template: SeedTemplate,
  objectName: string,
  fieldName: string,
): FieldRule | undefined {
  const obj = template.objects.find((o) => o.objectApiName === objectName);
  return obj?.fieldRules.find((r) => r.fieldApiName === fieldName);
}

/** Get the object config for a given object within a template. */
function getObject(template: SeedTemplate, objectName: string): SeedObjectConfig | undefined {
  return template.objects.find((o) => o.objectApiName === objectName);
}

/* ------------------------------------------------------------------ */
/* PREBUILT_SEED_TEMPLATES array                                       */
/* ------------------------------------------------------------------ */

describe('PREBUILT_SEED_TEMPLATES', () => {
  it('should contain exactly 3 templates', () => {
    expect(PREBUILT_SEED_TEMPLATES).toHaveLength(3);
  });

  it('should reference the named exports', () => {
    expect(PREBUILT_SEED_TEMPLATES[0]).toBe(SALES_CLOUD_STARTER);
    expect(PREBUILT_SEED_TEMPLATES[1]).toBe(SERVICE_CLOUD_STARTER);
    expect(PREBUILT_SEED_TEMPLATES[2]).toBe(MINIMAL_DEMO);
  });
});

/* ------------------------------------------------------------------ */
/* Sales Cloud Starter                                                 */
/* ------------------------------------------------------------------ */

describe('SALES_CLOUD_STARTER', () => {
  it('should have 7 objects', () => {
    expect(SALES_CLOUD_STARTER.objects).toHaveLength(7);
  });

  it('should have sequential insertOrder 0-6', () => {
    assertInsertOrderSequential(SALES_CLOUD_STARTER);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(SALES_CLOUD_STARTER);
  });

  it('should maintain referential integrity (references point to earlier objects)', () => {
    assertReferentialIntegrity(SALES_CLOUD_STARTER);
  });

  it('should have valid ruleType values on all field rules', () => {
    assertValidRuleTypes(SALES_CLOUD_STARTER);
  });

  it('should have correct insertOrder chain: Pricebook2(0) -> Product2(1) -> PricebookEntry(2) -> Account(3) -> Contact(4) -> Opportunity(5) -> OLI(6)', () => {
    expect(getObject(SALES_CLOUD_STARTER, 'Pricebook2')?.insertOrder).toBe(0);
    expect(getObject(SALES_CLOUD_STARTER, 'Product2')?.insertOrder).toBe(1);
    expect(getObject(SALES_CLOUD_STARTER, 'PricebookEntry')?.insertOrder).toBe(2);
    expect(getObject(SALES_CLOUD_STARTER, 'Account')?.insertOrder).toBe(3);
    expect(getObject(SALES_CLOUD_STARTER, 'Contact')?.insertOrder).toBe(4);
    expect(getObject(SALES_CLOUD_STARTER, 'Opportunity')?.insertOrder).toBe(5);
    expect(getObject(SALES_CLOUD_STARTER, 'OpportunityLineItem')?.insertOrder).toBe(6);
  });

  it('should have correct record counts', () => {
    expect(getObject(SALES_CLOUD_STARTER, 'Pricebook2')?.recordCount).toBe(1);
    expect(getObject(SALES_CLOUD_STARTER, 'Product2')?.recordCount).toBe(50);
    expect(getObject(SALES_CLOUD_STARTER, 'PricebookEntry')?.recordCount).toBe(50);
    expect(getObject(SALES_CLOUD_STARTER, 'Account')?.recordCount).toBe(500);
    expect(getObject(SALES_CLOUD_STARTER, 'Contact')?.recordCount).toBe(1000);
    expect(getObject(SALES_CLOUD_STARTER, 'Opportunity')?.recordCount).toBe(2000);
    expect(getObject(SALES_CLOUD_STARTER, 'OpportunityLineItem')?.recordCount).toBe(4000);
  });

  it('should have Opportunity.Pricebook2Id referencing Pricebook2', () => {
    const rule = getRule(SALES_CLOUD_STARTER, 'Opportunity', 'Pricebook2Id');
    expect(rule?.ruleType).toBe('reference');
    expect(rule?.config.referenceObject).toBe('Pricebook2');
  });

  it('should have OLI.PricebookEntryId referencing PricebookEntry', () => {
    const rule = getRule(SALES_CLOUD_STARTER, 'OpportunityLineItem', 'PricebookEntryId');
    expect(rule?.ruleType).toBe('reference');
    expect(rule?.config.referenceObject).toBe('PricebookEntry');
  });

  it('should have Account.Name as faker company.name', () => {
    const rule = getRule(SALES_CLOUD_STARTER, 'Account', 'Name');
    expect(rule?.ruleType).toBe('faker');
    expect(rule?.config.fakerMethod).toBe('company.name');
  });

  it('should use i18n keys for name and description', () => {
    expect(SALES_CLOUD_STARTER.name).toBe('seed.templates.salesCloudStarter.name');
    expect(SALES_CLOUD_STARTER.description).toBe('seed.templates.salesCloudStarter.description');
  });

  it('should have strategy faker and version 1', () => {
    expect(SALES_CLOUD_STARTER.strategy).toBe('faker');
    expect(SALES_CLOUD_STARTER.version).toBe(1);
  });

  it('should have batchSize 200 for all objects', () => {
    for (const obj of SALES_CLOUD_STARTER.objects) {
      expect(obj.batchSize).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Service Cloud Starter                                               */
/* ------------------------------------------------------------------ */

describe('SERVICE_CLOUD_STARTER', () => {
  it('should have 5 objects', () => {
    expect(SERVICE_CLOUD_STARTER.objects).toHaveLength(5);
  });

  it('should have sequential insertOrder 0-4', () => {
    assertInsertOrderSequential(SERVICE_CLOUD_STARTER);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(SERVICE_CLOUD_STARTER);
  });

  it('should maintain referential integrity', () => {
    assertReferentialIntegrity(SERVICE_CLOUD_STARTER);
  });

  it('should have valid ruleType values on all field rules', () => {
    assertValidRuleTypes(SERVICE_CLOUD_STARTER);
  });

  it('should have correct insertOrder chain: Account(0) -> Contact(1) -> Case(2) -> CaseComment(3) -> Knowledge__kav(4)', () => {
    expect(getObject(SERVICE_CLOUD_STARTER, 'Account')?.insertOrder).toBe(0);
    expect(getObject(SERVICE_CLOUD_STARTER, 'Contact')?.insertOrder).toBe(1);
    expect(getObject(SERVICE_CLOUD_STARTER, 'Case')?.insertOrder).toBe(2);
    expect(getObject(SERVICE_CLOUD_STARTER, 'CaseComment')?.insertOrder).toBe(3);
    expect(getObject(SERVICE_CLOUD_STARTER, 'Knowledge__kav')?.insertOrder).toBe(4);
  });

  it('should have correct record counts', () => {
    expect(getObject(SERVICE_CLOUD_STARTER, 'Account')?.recordCount).toBe(200);
    expect(getObject(SERVICE_CLOUD_STARTER, 'Contact')?.recordCount).toBe(500);
    expect(getObject(SERVICE_CLOUD_STARTER, 'Case')?.recordCount).toBe(1000);
    expect(getObject(SERVICE_CLOUD_STARTER, 'CaseComment')?.recordCount).toBe(2000);
    expect(getObject(SERVICE_CLOUD_STARTER, 'Knowledge__kav')?.recordCount).toBe(100);
  });

  it('should have Knowledge__kav with PublishStatus Online and Language en_US', () => {
    const pubRule = getRule(SERVICE_CLOUD_STARTER, 'Knowledge__kav', 'PublishStatus');
    expect(pubRule?.ruleType).toBe('static');
    expect(pubRule?.config.staticValue).toBe('Online');

    const langRule = getRule(SERVICE_CLOUD_STARTER, 'Knowledge__kav', 'Language');
    expect(langRule?.ruleType).toBe('static');
    expect(langRule?.config.staticValue).toBe('en_US');
  });

  it('should have Knowledge__kav.UrlName as sequence', () => {
    const rule = getRule(SERVICE_CLOUD_STARTER, 'Knowledge__kav', 'UrlName');
    expect(rule?.ruleType).toBe('sequence');
    expect(rule?.config.sequencePrefix).toBe('kb-article-');
    expect(rule?.config.sequenceStart).toBe(1);
  });

  it('should use i18n keys for name and description', () => {
    expect(SERVICE_CLOUD_STARTER.name).toBe('seed.templates.serviceCloudStarter.name');
    expect(SERVICE_CLOUD_STARTER.description).toBe(
      'seed.templates.serviceCloudStarter.description',
    );
  });

  it('should have batchSize 200 for all objects', () => {
    for (const obj of SERVICE_CLOUD_STARTER.objects) {
      expect(obj.batchSize).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Minimal Demo                                                        */
/* ------------------------------------------------------------------ */

describe('MINIMAL_DEMO', () => {
  it('should have 3 objects', () => {
    expect(MINIMAL_DEMO.objects).toHaveLength(3);
  });

  it('should have sequential insertOrder 0-2', () => {
    assertInsertOrderSequential(MINIMAL_DEMO);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(MINIMAL_DEMO);
  });

  it('should maintain referential integrity', () => {
    assertReferentialIntegrity(MINIMAL_DEMO);
  });

  it('should have valid ruleType values on all field rules', () => {
    assertValidRuleTypes(MINIMAL_DEMO);
  });

  it('should have correct objects: Account(0), Contact(1), Opportunity(2)', () => {
    expect(getObject(MINIMAL_DEMO, 'Account')?.insertOrder).toBe(0);
    expect(getObject(MINIMAL_DEMO, 'Contact')?.insertOrder).toBe(1);
    expect(getObject(MINIMAL_DEMO, 'Opportunity')?.insertOrder).toBe(2);
  });

  it('should have correct record counts', () => {
    expect(getObject(MINIMAL_DEMO, 'Account')?.recordCount).toBe(50);
    expect(getObject(MINIMAL_DEMO, 'Contact')?.recordCount).toBe(100);
    expect(getObject(MINIMAL_DEMO, 'Opportunity')?.recordCount).toBe(200);
  });

  it('should NOT have Pricebook2Id on Opportunity', () => {
    const rule = getRule(MINIMAL_DEMO, 'Opportunity', 'Pricebook2Id');
    expect(rule).toBeUndefined();
  });

  it('should use i18n keys for name and description', () => {
    expect(MINIMAL_DEMO.name).toBe('seed.templates.minimalDemo.name');
    expect(MINIMAL_DEMO.description).toBe('seed.templates.minimalDemo.description');
  });

  it('should have batchSize 200 for all objects', () => {
    for (const obj of MINIMAL_DEMO.objects) {
      expect(obj.batchSize).toBe(200);
    }
  });
});
