import { describe, it, expect } from 'vitest';
import { allowsControllingValue, controllersOf, fieldBoundsOf } from './describeBounds.js';

describe('fieldBoundsOf', () => {
  it('reads the digits, uniqueness, formula and lookup filter a describe gives', () => {
    expect(
      fieldBoundsOf(
        {
          name: 'Amount__c',
          precision: 18,
          scale: 2,
          digits: 0,
          unique: true,
          calculated: true,
          filteredLookupInfo: { controllingFields: [] },
        },
        new Set(),
      ),
    ).toEqual({ precision: 18, scale: 2, unique: true, calculated: true, filteredLookup: true });
  });

  it('reads nothing a describe leaves at zero, null or false', () => {
    expect(
      fieldBoundsOf(
        {
          name: 'Name',
          precision: 0,
          scale: 0,
          digits: 0,
          unique: false,
          calculated: false,
          filteredLookupInfo: null,
        },
        new Set(),
      ),
    ).toEqual({});
  });

  it("keeps a dependent picklist's validFor per active value", () => {
    const bounds = fieldBoundsOf(
      {
        name: 'Product__c',
        controllerName: 'Category__c',
        picklistValues: [
          { value: 'Laptop', active: true, validFor: 'gA==' },
          { value: 'Retired', active: false, validFor: 'gA==' },
          { value: 'Unbound', active: true },
          null,
        ],
      },
      new Set(),
    );

    expect(bounds).toEqual({ validFor: { Laptop: 'gA==' } });
  });

  it('keeps every value of a field another depends on, inactive ones too, in order', () => {
    const fields = [
      {
        name: 'Category__c',
        picklistValues: [
          { value: 'Computers', active: true },
          { value: 'Old', active: false },
          { value: 'Mobile', active: true },
        ],
      },
      { name: 'Product__c', controllerName: 'Category__c' },
    ];

    expect(fieldBoundsOf(fields[0], controllersOf(fields))).toEqual({
      controllingValues: ['Computers', 'Old', 'Mobile'],
    });
  });
});

describe('allowsControllingValue', () => {
  it('reads bit n left to right in the decoded bytes', () => {
    // 0x40 0x01: bits 1 and 15.
    const validFor = Buffer.from([0x40, 0x01]).toString('base64');

    expect([0, 1, 2, 14, 15, 16].map((n) => allowsControllingValue(validFor, n))).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(allowsControllingValue(validFor, -1)).toBe(false);
  });
});
