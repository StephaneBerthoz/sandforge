import { describe, it, expect } from 'vitest';
import type { SeedTemplate } from '../types/seed.types.js';
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

/* ------------------------------------------------------------------ */
/* PREBUILT_SEED_TEMPLATES array                                       */
/* ------------------------------------------------------------------ */

describe('PREBUILT_SEED_TEMPLATES', () => {
  it('should reference the named exports', () => {
    expect(PREBUILT_SEED_TEMPLATES).toContain(SALES_CLOUD_STARTER);
    expect(PREBUILT_SEED_TEMPLATES).toContain(SERVICE_CLOUD_STARTER);
    expect(PREBUILT_SEED_TEMPLATES).toContain(MINIMAL_DEMO);
  });
});

/* ------------------------------------------------------------------ */
/* Structural invariants, applied uniformly to every prebuilt template */
/* ------------------------------------------------------------------ */

describe.each([
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

  it('should have valid ruleType values on all field rules', () => {
    assertValidRuleTypes(template);
  });
});
