import { describe, expect, it } from 'vitest';
import type { ForgeGap } from '../types/forge.types.js';
import { forgeGapId, forgeGapParts, mergeGaps } from './forge-gaps.js';

const gap = (over: Partial<ForgeGap>): ForgeGap => ({
  id: forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'Other'),
  kind: 'picklist_value_refused',
  severity: 'warning',
  source: 'metadata',
  objectApiName: 'Case',
  field: 'Reason__c',
  recordType: 'Claim',
  value: 'Other',
  rows: 0,
  decisions: ['map_value', 'leave_empty'],
  ...over,
});

describe('forgeGapId', () => {
  it('gives a gap the same id whatever read found it, and another gap another id', () => {
    expect(forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'Other')).toBe(
      forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'Other'),
    );
    expect(forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'Other')).not.toBe(
      forgeGapId('picklist_value_refused', 'Case', 'Reason__c', undefined, 'Other'),
    );
    expect(forgeGapId('validation_rule', 'Contact', undefined, undefined, 'Phone_Format')).toBe(
      'validation_rule|Contact|||Phone_Format',
    );
  });
});

describe('forgeGapParts', () => {
  it('reads back from an id what the gap is about, a value holding a bar included', () => {
    expect(
      forgeGapParts(forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'A|B')),
    ).toEqual({
      kind: 'picklist_value_refused',
      objectApiName: 'Case',
      field: 'Reason__c',
      recordType: 'Claim',
      value: 'A|B',
    });
    expect(forgeGapParts('validation_rule|Contact|||Phone_Format')).toEqual({
      kind: 'validation_rule',
      objectApiName: 'Contact',
      value: 'Phone_Format',
    });
  });

  it('reads nothing from a text no gap id is', () => {
    expect(forgeGapParts('Contact')).toBeNull();
    expect(forgeGapParts('|Contact|||x')).toBeNull();
    expect(forgeGapParts('kind||||x')).toBeNull();
  });
});

describe('mergeGaps', () => {
  it('keeps one line per gap, with the gravest severity, the most rows and every decision', () => {
    const merged = mergeGaps(
      [gap({ rows: 0 })],
      [gap({ severity: 'blocking', source: 'simulation', rows: 12, decisions: ['skip_rows'] })],
      [gap({ source: 'rehearsal', rows: 3, decisions: ['map_value'] })],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      severity: 'blocking',
      source: 'simulation',
      rows: 12,
      decisions: ['map_value', 'leave_empty', 'skip_rows'],
    });
  });

  it('lists what will be refused first, then by object', () => {
    const merged = mergeGaps([
      gap({ id: 'a', objectApiName: 'Contact', severity: 'info' }),
      gap({ id: 'b', objectApiName: 'Account', severity: 'warning' }),
      gap({ id: 'c', objectApiName: 'Case', severity: 'blocking' }),
      gap({ id: 'd', objectApiName: 'Account', severity: 'blocking' }),
    ]);

    expect(merged.map(({ id }) => id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('leaves the lists it was given as they were', () => {
    const first = [gap({})];
    mergeGaps(first, [gap({ decisions: ['ignore'] })]);

    expect(first[0].decisions).toEqual(['map_value', 'leave_empty']);
  });
});
