import { describe, expect, it } from 'vitest';
import type { ForgeGap, ForgeGapKind } from '../types/forge.types.js';
import { adminChangesOf } from './forge-admin-changes.js';
import { forgeGapId } from './forge-gaps.js';

/** A gap of `kind` on `objectApiName`, as a read gives it. */
const gap = (kind: ForgeGapKind, objectApiName: string, over: Partial<ForgeGap> = {}): ForgeGap => {
  const g: ForgeGap = {
    id: '',
    kind,
    severity: 'blocking',
    source: 'simulation',
    objectApiName,
    rows: 3,
    decisions: ['ignore'],
    ...over,
  };
  return { ...g, id: forgeGapId(kind, objectApiName, g.field, g.recordType, g.value) };
};

describe('adminChangesOf', () => {
  it('groups by object and record type the changes a target metadata change cures, each with its Setup step', () => {
    const groups = adminChangesOf([
      gap('picklist_value_refused', 'Case', {
        severity: 'warning',
        field: 'Reason__c',
        recordType: 'Claim',
        value: 'Other',
        detail: { reason: 'record-type', allowed: ['A', 'B'] },
      }),
      gap('picklist_value_refused', 'Case', {
        severity: 'warning',
        field: 'Origin',
        recordType: 'Claim',
        value: 'Fax',
        detail: { reason: 'not-in-target' },
      }),
      gap('record_type_unavailable', 'Case', {
        field: 'RecordTypeId',
        recordType: 'Internal',
        detail: { mapTo: ['Claim'] },
      }),
      gap('value_too_long', 'Account', {
        field: 'Description',
        detail: { length: 255, longest: 812 },
      }),
      gap('currency_inactive', 'Opportunity', {
        severity: 'warning',
        field: 'CurrencyIsoCode',
        value: 'GBP',
      }),
      gap('validation_rule', 'Contact', {
        severity: 'warning',
        source: 'metadata',
        rows: 0,
        detail: { rule: 'Phone_Format', message: 'Phone is wrong' },
      }),
    ]);

    expect(groups.map(({ objectApiName, recordType }) => [objectApiName, recordType])).toEqual([
      ['Account', undefined],
      ['Case', 'Claim'],
      ['Case', 'Internal'],
      ['Contact', undefined],
      ['Opportunity', undefined],
    ]);
    expect(groups[0]?.changes).toEqual([
      expect.objectContaining({
        change: 'lengthen_field',
        field: 'Description',
        length: 812,
        rows: 3,
        setup:
          'Setup > Object Manager > Account > Fields & Relationships > Description > Edit: set its length to 812 characters or more',
      }),
    ]);
    expect(
      groups[1]?.changes.map(({ change, field, value, setup }) => ({
        change,
        field,
        value,
        setup,
      })),
    ).toEqual([
      {
        change: 'add_picklist_value',
        field: 'Origin',
        value: 'Fax',
        setup:
          'Setup > Object Manager > Case > Fields & Relationships > Origin > Values: add or activate "Fax", then select it for record type Claim',
      },
      {
        change: 'select_picklist_value',
        field: 'Reason__c',
        value: 'Other',
        setup:
          'Setup > Object Manager > Case > Record Types > Claim > Reason__c > Edit: add "Other" to the selected values',
      },
    ]);
    expect(groups[2]?.changes).toEqual([expect.objectContaining({ change: 'open_record_type' })]);
    expect(groups[2]?.changes[0]?.setup).toContain('make record type Internal available');
    expect(groups[3]?.changes).toEqual([
      expect.objectContaining({
        change: 'deactivate_validation_rule',
        value: 'Phone_Format',
        rows: 0,
        setup: expect.stringContaining('Validation Rules > Phone_Format'),
      }),
    ]);
    expect(groups[4]?.changes).toEqual([
      expect.objectContaining({ change: 'activate_currency', value: 'GBP' }),
    ]);
  });

  it('names the controlling field of a value its controlling value refuses', () => {
    const [group] = adminChangesOf([
      gap('picklist_value_refused', 'Case', {
        severity: 'warning',
        field: 'SubReason__c',
        recordType: 'Claim',
        value: 'Late',
        detail: { reason: 'controlling-value', controllingField: 'Reason__c' },
      }),
      gap('dependent_value_invalid', 'Case', {
        field: 'Detail__c',
        recordType: 'Claim',
        value: 'X',
        detail: { controllingField: 'Reason__c', allowed: ['A'] },
      }),
    ]);
    expect(
      group?.changes.map(({ change, controllingField }) => [change, controllingField]),
    ).toEqual([
      ['allow_dependent_value', 'Reason__c'],
      ['allow_dependent_value', 'Reason__c'],
    ]);
    expect(group?.changes[1]?.setup).toBe(
      'Setup > Object Manager > Case > Fields & Relationships > Reason__c > Field Dependencies > Edit: include "Late" of SubReason__c under the controlling values it comes with',
    );
  });

  it('leaves out what refuses nothing, what no metadata change cures, and a field the user left out', () => {
    expect(
      adminChangesOf([
        gap('picklist_value_absent', 'Case', { severity: 'info', field: 'Origin', value: 'Fax' }),
        gap('validation_rule', 'Contact', { severity: 'info', detail: { rule: 'Kept_Quiet' } }),
        gap('unique_value_collision', 'Account', { field: 'Code__c', detail: { colliding: 2 } }),
        gap('api_budget', 'Account', { severity: 'warning' }),
        gap('rehearsal_refusal', 'Case', { value: 'CANNOT_EXECUTE_FLOW_TRIGGER' }),
        gap('required_field_missing', 'Case', {
          source: 'metadata',
          field: 'Region__c',
          detail: { reason: 'excluded' },
        }),
      ]),
    ).toEqual([]);
    const [kept] = adminChangesOf([
      gap('required_field_missing', 'Case', {
        source: 'metadata',
        field: 'Region__c',
        detail: { reason: 'notInSource' },
      }),
      gap('object_not_createable', 'Invoice__c'),
    ]);
    expect(kept?.changes.map((c) => c.change)).toEqual(['make_field_optional']);
  });

  it('asks a text field be made longer, to no number, when no read measured its longest value', () => {
    const [group] = adminChangesOf([gap('value_too_long', 'Contact', { field: 'Description' })]);
    expect(group?.changes[0]).toEqual(
      expect.objectContaining({
        change: 'lengthen_field',
        setup:
          'Setup > Object Manager > Contact > Fields & Relationships > Description > Edit: make it longer',
      }),
    );
    expect(group?.changes[0]).not.toHaveProperty('length');
  });

  it('reads the name of a duplicate rule from its detail, and gives each change the gap it answers', () => {
    const duplicate = gap('duplicate_rule', 'Lead', {
      severity: 'warning',
      source: 'metadata',
      value: undefined,
      detail: { rule: 'Leads by email', developerName: 'Leads_By_Email', action: 'block' },
    });
    const [group] = adminChangesOf([duplicate]);
    expect(group?.changes[0]).toEqual(
      expect.objectContaining({
        change: 'deactivate_duplicate_rule',
        value: 'Leads_By_Email',
        gapId: duplicate.id,
        setup:
          'Setup > Duplicate Rules > Leads_By_Email: deactivate it, or set it to Allow on create',
      }),
    );
  });
});
