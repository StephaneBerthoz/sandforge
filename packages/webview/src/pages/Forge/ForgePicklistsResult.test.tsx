import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgePicklistValuesChanged } from '@sandforge/shared';
import '../../i18n';
import { ForgePicklistsResult } from './ForgePicklistsResult';

const CHANGES: ForgePicklistValuesChanged[] = [
  {
    objectApiName: 'Order__c',
    field: 'Status__c',
    reason: 'record-type',
    values: ['Old', 'Older'],
    rows: 3,
    recordType: 'Retail',
    replacedBy: 'New',
    replacement: 'default',
  },
  {
    objectApiName: 'Order__c',
    field: 'Entity__c',
    reason: 'record-type',
    values: ['East'],
    rows: 1,
    recordType: 'Retail',
    replacedBy: 'North',
    replacement: 'first',
  },
  {
    objectApiName: 'Order__c',
    field: 'Reason__c',
    reason: 'controlling-value',
    values: ['Late'],
    rows: 1,
    recordType: 'Retail',
    controllingField: 'Status__c',
  },
  {
    objectApiName: 'Invoice__c',
    field: 'Kind__c',
    reason: 'not-in-target',
    values: ['Gone'],
    rows: 2,
  },
];

describe('ForgePicklistsResult', () => {
  it('says per object and field which values the run replaced or left out, on how many rows, and why', () => {
    render(<ForgePicklistsResult changes={CHANGES} />);

    expect(
      screen.getByRole('heading', { name: 'Picklist values not written as read' }),
    ).toBeDefined();
    expect(
      screen.getAllByTestId('forge-results-picklists-row').map((row) => row.textContent),
    ).toEqual([
      'Order__c.Status__c — 3 rows: Old, Older — not allowed for record type Retail, replaced by New, the default of record type Retail',
      'Order__c.Entity__c — 1 row: East — not allowed for record type Retail, replaced by North, the first value record type Retail allows: the field is required and has no default there',
      'Order__c.Reason__c — 1 row: Late — not allowed with the value of Status__c, left out',
      'Invoice__c.Kind__c — 2 rows: Gone — not a value of the field in the target org, left out',
    ]);
  });

  it('says what the run does with a value the target would refuse', () => {
    render(<ForgePicklistsResult changes={CHANGES.slice(0, 1)} />);

    expect(screen.getByTestId('forge-results-picklists').textContent).toContain(
      "Each was replaced by the record type's default for the field",
    );
  });
});
