import { describe, expect, it } from 'vitest';
import type { ForgeGap } from '../types/forge.types.js';
import {
  forgeGapId,
  forgeGapParts,
  ignoredGapEntry,
  gapAssignEntry,
  gapAssignments,
  gapLiftedBy,
  mergeGaps,
  picklistMappingEntry,
  skippedRowsEntry,
} from './forge-gaps.js';

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

describe('ignoredGapEntry', () => {
  const id = forgeGapId('picklist_value_absent', 'Case', 'Status', 'ns__Support', 'Open');
  const before = forgeGapId('picklist_value_absent', 'Case', 'Status', 'Support', 'Open');

  it('takes the id itself', () => {
    expect(ignoredGapEntry([id], id, [id])).toBe(id);
  });

  it('takes the id a gap of a package’s record type had before its namespace, and says which it found', () => {
    expect(ignoredGapEntry([before], id, [id])).toBe(before);
    expect(ignoredGapEntry(new Set([before]), id, new Set([id]))).toBe(before);
  });

  it('takes no other gap of the record type, and none of an unpackaged one for a packaged one', () => {
    const other = forgeGapId('picklist_value_absent', 'Case', 'Status', 'Support', 'Closed');
    expect(ignoredGapEntry([other], id, [id])).toBeUndefined();
    expect(ignoredGapEntry([id], before, [before])).toBeUndefined();
    expect(ignoredGapEntry(undefined, id, [id])).toBeUndefined();
  });

  it('leaves a package’s gap undecided when the entry is the org’s own gap the same read found', () => {
    // The target holds the org's own Support and a package's ns__Support,
    // each closed to the user: ignoring the first wrote its id, which is the
    // one the second had before its namespace. Read back by it, the packaged
    // gap said "left as it is", and Execute no longer asked.
    const own = forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', 'Support');
    const packaged = forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', 'ns__Support');
    const read = [own, packaged];

    expect(ignoredGapEntry([own], packaged, read)).toBeUndefined();
    expect(ignoredGapEntry([own], own, read)).toBe(own);
    expect(ignoredGapEntry([own], packaged, [packaged])).toBe(own);
  });

  it('leaves both undecided when two packages’ gaps had the one id the entry is', () => {
    const one = forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', 'ns1__Support');
    const two = forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', 'ns2__Support');
    const old = forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', 'Support');

    expect(ignoredGapEntry([old], one, [one, two])).toBeUndefined();
    expect(ignoredGapEntry([old], two, [one, two])).toBeUndefined();
  });

  it('takes the id an unmapped record type of a package had before its namespace, named in its value', () => {
    const unmapped = forgeGapId(
      'record_type_unmapped',
      'Account',
      'RecordTypeId',
      undefined,
      'ns__Retail',
    );
    const old = forgeGapId('record_type_unmapped', 'Account', 'RecordTypeId', undefined, 'Retail');

    expect(ignoredGapEntry([old], unmapped, [unmapped])).toBe(old);
    // The org's own Retail unmapped in the same read: the entry is its own.
    expect(ignoredGapEntry([old], unmapped, [old, unmapped])).toBeUndefined();
  });

  it('reads no namespace in a picklist value', () => {
    const value = forgeGapId('picklist_value_absent', 'Case', 'Status', undefined, 'ns__Open');
    const bare = forgeGapId('picklist_value_absent', 'Case', 'Status', undefined, 'Open');

    expect(ignoredGapEntry([bare], value, [value])).toBeUndefined();
  });
});

describe('skippedRowsEntry', () => {
  const id = forgeGapId('picklist_value_refused', 'Case', 'Status', 'ns__Support', 'Open');
  const before = forgeGapId('picklist_value_refused', 'Case', 'Status', 'Support', 'Open');
  const entry = (gapId: string) => ({ object: 'Case', gapId });

  it('takes the entry of the id, before the one the id had before its namespace', () => {
    expect(skippedRowsEntry([entry(before), entry(id)], id, [id])).toEqual(entry(id));
  });

  it('takes the entry a template kept before the namespace', () => {
    expect(skippedRowsEntry([entry(before)], id, [id])).toEqual(entry(before));
  });

  it('takes no entry of another value, and none of a packaged type for the org’s own', () => {
    const other = forgeGapId('picklist_value_refused', 'Case', 'Status', 'Support', 'Closed');
    expect(skippedRowsEntry([entry(other)], id, [id])).toBeUndefined();
    expect(skippedRowsEntry([entry(id)], before, [before])).toBeUndefined();
  });

  it('takes not, for a package’s gap, the entry of the org’s own gap the same read found', () => {
    expect(skippedRowsEntry([entry(before)], id, [before, id])).toBeUndefined();
    expect(skippedRowsEntry([entry(before)], before, [before, id])).toEqual(entry(before));
  });
});

describe('picklistMappingEntry', () => {
  const scoped = (recordType?: string) => ({ ...(recordType ? { recordType } : {}), to: 'x' });

  it('takes the mapping for the record type, then for it before its namespace, then for every one', () => {
    const named = scoped('ns__Support');
    const before = scoped('Support');
    const every = scoped();

    expect(picklistMappingEntry([every, before, named], 'ns__Support')).toBe(named);
    expect(picklistMappingEntry([every, before], 'ns__Support')).toBe(before);
    expect(picklistMappingEntry([every], 'ns__Support')).toBe(every);
  });

  it('takes no mapping of a packaged type for the org’s own, nor of another type', () => {
    expect(picklistMappingEntry([scoped('ns__Support')], 'Support')).toBeUndefined();
    expect(picklistMappingEntry([scoped('Claims')], 'ns__Support')).toBeUndefined();
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

describe("a gap's assignments", () => {
  it('reads back each permission with its permission sets, the smallest first', () => {
    const detail = {
      assign: [
        gapAssignEntry({
          permission: 'Bypass_VR',
          permissionSets: [{ name: 'Bypass' }, { name: 'ns__Admin_Tools' }],
        }),
        gapAssignEntry({ permission: 'ns__Skip', permissionSets: [] }),
      ],
    };

    expect(detail.assign).toEqual(['Bypass_VR=Bypass,ns__Admin_Tools', 'ns__Skip=']);
    expect(gapAssignments({ detail })).toEqual([
      {
        permission: 'Bypass_VR',
        permissionSet: { name: 'Bypass' },
        others: [{ name: 'ns__Admin_Tools' }],
      },
      { permission: 'ns__Skip', others: [] },
    ]);
  });

  it('reads none from a gap that holds no assignment, or from an entry that names no permission', () => {
    expect(gapAssignments({})).toEqual([]);
    expect(gapAssignments({ detail: { assign: 'Bypass=Set' } })).toEqual([]);
    expect(gapAssignments({ detail: { assign: ['=Set', 'no sign'] } })).toEqual([]);
  });

  it('keeps the assignments the metadata read gave a gap a rehearsal also found', () => {
    const [merged] = mergeGaps(
      [gap({ detail: { assign: ['Bypass_VR=Bypass'] } })],
      [gap({ source: 'rehearsal', rows: 2, detail: { statusCode: 'X' } })],
    );

    expect(gapAssignments(merged)).toEqual([
      { permission: 'Bypass_VR', permissionSet: { name: 'Bypass' }, others: [] },
    ]);
  });
});

describe('what a mute lifts of a gap', () => {
  const rule = gap({
    id: forgeGapId('validation_rule', 'Contact', 'Email', undefined, 'Email_Required'),
    kind: 'validation_rule',
    objectApiName: 'Contact',
    field: 'Email',
    detail: { rule: 'Email_Required', bypasses: ['$Permission.Bypass_VR'] },
  });
  const lifts = {
    objectApiName: 'contact',
    kind: 'validationRule' as const,
    name: 'Email_Required',
    permission: 'Bypass_VR',
    permissionSet: 'Data_Load',
  };

  it('finds the entry that names the rule on its object, whatever the case of the object', () => {
    expect(gapLiftedBy(rule, [lifts])).toEqual(lifts);
  });

  it('finds none for another rule, another object, a flow of the same name or no plan', () => {
    expect(gapLiftedBy(rule, [{ ...lifts, name: 'Phone_Format' }])).toBeUndefined();
    expect(gapLiftedBy(rule, [{ ...lifts, objectApiName: 'Lead' }])).toBeUndefined();
    expect(gapLiftedBy(rule, [{ ...lifts, kind: 'flow' }])).toBeUndefined();
    expect(gapLiftedBy(rule, undefined)).toBeUndefined();
    // Only a validation rule is lifted: a duplicate rule of that name is not.
    expect(gapLiftedBy({ ...rule, kind: 'duplicate_rule' }, [lifts])).toBeUndefined();
  });

  it("finds the entry of a rule a rehearsal's refusal names, the rehearsal taking no mute", () => {
    const refused = {
      kind: 'rehearsal_refusal' as const,
      objectApiName: 'Contact',
      detail: { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', rule: 'Email_Required' },
    };

    expect(gapLiftedBy(refused, [lifts])).toEqual(lifts);
    // Another refusal naming no rule, or of another code, is lifted by nothing.
    expect(
      gapLiftedBy({ ...refused, detail: { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' } }, [
        lifts,
      ]),
    ).toBeUndefined();
    expect(
      gapLiftedBy(
        { ...refused, detail: { statusCode: 'REQUIRED_FIELD_MISSING', rule: 'Email_Required' } },
        [lifts],
      ),
    ).toBeUndefined();
  });
});
