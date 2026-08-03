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
  it('should reference the named exports', () => {
    expect(PREBUILT_SYNC_TEMPLATES).toContain(SYNC_ACCOUNT_HIERARCHY);
    expect(PREBUILT_SYNC_TEMPLATES).toContain(SYNC_OPPS_PRODUCTS);
    expect(PREBUILT_SYNC_TEMPLATES).toContain(SYNC_CASES_ATTACHMENTS);
  });

  it('should have unique templateIds across all templates', () => {
    const ids = PREBUILT_SYNC_TEMPLATES.map((t) => t.templateId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------ */
/* Structural invariants, applied uniformly to every prebuilt template */
/* ------------------------------------------------------------------ */

describe.each([
  ['SYNC_ACCOUNT_HIERARCHY', SYNC_ACCOUNT_HIERARCHY],
  ['SYNC_OPPS_PRODUCTS', SYNC_OPPS_PRODUCTS],
  ['SYNC_CASES_ATTACHMENTS', SYNC_CASES_ATTACHMENTS],
])('%s', (_name, template) => {
  it('should have sequential insertOrder 0..N-1', () => {
    assertInsertOrderSequential(template);
  });

  it('should have no duplicate objectApiName', () => {
    assertNoDuplicateObjects(template);
  });

  it('should have all required fields', () => {
    assertRequiredFields(template);
  });
});
