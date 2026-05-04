import { describe, it, expect } from 'vitest';
import type { SyncTemplateConfig } from './sync-templates.js';
import {
  SYNC_ACCOUNT_HIERARCHY,
  SYNC_OPPS_PRODUCTS,
  SYNC_CASES_ATTACHMENTS,
  PREBUILT_SYNC_TEMPLATES,
} from './sync-templates.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Assert insertOrder is a contiguous 0..N sequence. */
function assertInsertOrderSequential(template: SyncTemplateConfig): void {
  const orders = template.objects.map((o) => o.insertOrder).sort((a, b) => a - b);
  orders.forEach((order, idx) => {
    expect(order).toBe(idx);
  });
}

/** Assert no duplicate objectApiName within a template. */
function assertNoDuplicateObjects(template: SyncTemplateConfig): void {
  const names = template.objects.map((o) => o.objectApiName);
  expect(new Set(names).size).toBe(names.length);
}

/** Assert all required fields are present on every template. */
function assertRequiredFields(template: SyncTemplateConfig): void {
  expect(template.templateId).toBeTruthy();
  expect(template.nameKey).toBeTruthy();
  expect(template.descriptionKey).toBeTruthy();
  expect(template.tags.length).toBeGreaterThan(0);
  expect(template.direction).toBeTruthy();
  expect(template.mode).toBeTruthy();
  expect(template.conflictStrategy).toBeTruthy();
  expect(template.objects.length).toBeGreaterThan(0);

  for (const obj of template.objects) {
    expect(obj.objectApiName).toBeTruthy();
    expect(obj.operation).toBeTruthy();
    expect(obj.externalIdField).toBeTruthy();
    expect(obj.batchSize).toBeGreaterThan(0);
    expect(typeof obj.insertOrder).toBe('number');
  }
}

/* ------------------------------------------------------------------ */
/* PREBUILT_SYNC_TEMPLATES array                                       */
/* ------------------------------------------------------------------ */

describe('PREBUILT_SYNC_TEMPLATES', () => {
  it('should contain exactly 3 templates', () => {
    expect(PREBUILT_SYNC_TEMPLATES).toHaveLength(3);
  });

  it('should reference the named exports', () => {
    expect(PREBUILT_SYNC_TEMPLATES[0]).toBe(SYNC_ACCOUNT_HIERARCHY);
    expect(PREBUILT_SYNC_TEMPLATES[1]).toBe(SYNC_OPPS_PRODUCTS);
    expect(PREBUILT_SYNC_TEMPLATES[2]).toBe(SYNC_CASES_ATTACHMENTS);
  });

  it('should have unique templateIds across all templates', () => {
    const ids = PREBUILT_SYNC_TEMPLATES.map((t) => t.templateId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------ */
/* Full Account Hierarchy                                              */
/* ------------------------------------------------------------------ */

describe('SYNC_ACCOUNT_HIERARCHY', () => {
  it('should have 5 objects', () => {
    expect(SYNC_ACCOUNT_HIERARCHY.objects).toHaveLength(5);
  });

  it('should have sequential insertOrder 0-4', () => {
    assertInsertOrderSequential(SYNC_ACCOUNT_HIERARCHY);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(SYNC_ACCOUNT_HIERARCHY);
  });

  it('should have all required fields', () => {
    assertRequiredFields(SYNC_ACCOUNT_HIERARCHY);
  });

  it('should have correct insert order chain: Account(0) -> Contact(1) -> Opportunity(2) -> Task(3) -> Note(4)', () => {
    const find = (name: string) =>
      SYNC_ACCOUNT_HIERARCHY.objects.find((o) => o.objectApiName === name);
    expect(find('Account')?.insertOrder).toBe(0);
    expect(find('Contact')?.insertOrder).toBe(1);
    expect(find('Opportunity')?.insertOrder).toBe(2);
    expect(find('Task')?.insertOrder).toBe(3);
    expect(find('Note')?.insertOrder).toBe(4);
  });

  it('should use source_to_target direction, full mode, source_wins conflict', () => {
    expect(SYNC_ACCOUNT_HIERARCHY.direction).toBe('source_to_target');
    expect(SYNC_ACCOUNT_HIERARCHY.mode).toBe('full');
    expect(SYNC_ACCOUNT_HIERARCHY.conflictStrategy).toBe('source_wins');
  });

  it('should use i18n keys for name and description', () => {
    expect(SYNC_ACCOUNT_HIERARCHY.nameKey).toBe('sync.templates.accountHierarchy.name');
    expect(SYNC_ACCOUNT_HIERARCHY.descriptionKey).toBe(
      'sync.templates.accountHierarchy.description',
    );
  });

  it('should include prebuilt tag', () => {
    expect(SYNC_ACCOUNT_HIERARCHY.tags).toContain('prebuilt');
  });

  it('should have batchSize 200 for all objects', () => {
    for (const obj of SYNC_ACCOUNT_HIERARCHY.objects) {
      expect(obj.batchSize).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Opportunities + Products                                            */
/* ------------------------------------------------------------------ */

describe('SYNC_OPPS_PRODUCTS', () => {
  it('should have 5 objects', () => {
    expect(SYNC_OPPS_PRODUCTS.objects).toHaveLength(5);
  });

  it('should have sequential insertOrder 0-4', () => {
    assertInsertOrderSequential(SYNC_OPPS_PRODUCTS);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(SYNC_OPPS_PRODUCTS);
  });

  it('should have all required fields', () => {
    assertRequiredFields(SYNC_OPPS_PRODUCTS);
  });

  it('should have correct insert order chain: Pricebook2(0) -> Product2(1) -> PricebookEntry(2) -> Opportunity(3) -> OLI(4)', () => {
    const find = (name: string) => SYNC_OPPS_PRODUCTS.objects.find((o) => o.objectApiName === name);
    expect(find('Pricebook2')?.insertOrder).toBe(0);
    expect(find('Product2')?.insertOrder).toBe(1);
    expect(find('PricebookEntry')?.insertOrder).toBe(2);
    expect(find('Opportunity')?.insertOrder).toBe(3);
    expect(find('OpportunityLineItem')?.insertOrder).toBe(4);
  });

  it('should use i18n keys for name and description', () => {
    expect(SYNC_OPPS_PRODUCTS.nameKey).toBe('sync.templates.oppsProducts.name');
    expect(SYNC_OPPS_PRODUCTS.descriptionKey).toBe('sync.templates.oppsProducts.description');
  });

  it('should have batchSize 200 for all objects', () => {
    for (const obj of SYNC_OPPS_PRODUCTS.objects) {
      expect(obj.batchSize).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Cases + Attachments                                                 */
/* ------------------------------------------------------------------ */

describe('SYNC_CASES_ATTACHMENTS', () => {
  it('should have 5 objects', () => {
    expect(SYNC_CASES_ATTACHMENTS.objects).toHaveLength(5);
  });

  it('should have sequential insertOrder 0-4', () => {
    assertInsertOrderSequential(SYNC_CASES_ATTACHMENTS);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(SYNC_CASES_ATTACHMENTS);
  });

  it('should have all required fields', () => {
    assertRequiredFields(SYNC_CASES_ATTACHMENTS);
  });

  it('should have correct insert order chain: Account(0) -> Contact(1) -> Case(2) -> CaseComment(3) -> Attachment(4)', () => {
    const find = (name: string) =>
      SYNC_CASES_ATTACHMENTS.objects.find((o) => o.objectApiName === name);
    expect(find('Account')?.insertOrder).toBe(0);
    expect(find('Contact')?.insertOrder).toBe(1);
    expect(find('Case')?.insertOrder).toBe(2);
    expect(find('CaseComment')?.insertOrder).toBe(3);
    expect(find('Attachment')?.insertOrder).toBe(4);
  });

  it('should use i18n keys for name and description', () => {
    expect(SYNC_CASES_ATTACHMENTS.nameKey).toBe('sync.templates.casesAttachments.name');
    expect(SYNC_CASES_ATTACHMENTS.descriptionKey).toBe(
      'sync.templates.casesAttachments.description',
    );
  });

  it('should have Attachment with batchSize 100', () => {
    const attachment = SYNC_CASES_ATTACHMENTS.objects.find((o) => o.objectApiName === 'Attachment');
    expect(attachment?.batchSize).toBe(100);
  });
});
