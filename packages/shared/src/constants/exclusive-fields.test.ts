import { describe, it, expect } from 'vitest';
import {
  EXCLUSIVE_FIELD_GROUPS,
  exclusiveFieldsToDrop,
  exclusiveFieldToFill,
} from './exclusive-fields.js';

describe('exclusiveFieldsToDrop', () => {
  it('drops the derived field when both travel together', () => {
    expect(
      exclusiveFieldsToDrop('OpportunityLineItem', {
        Quantity: 2,
        UnitPrice: 7.85,
        TotalPrice: 15.7,
      }),
    ).toEqual(['TotalPrice']);
  });

  it('keeps a lone total price, which is a valid payload on its own', () => {
    expect(exclusiveFieldsToDrop('OpportunityLineItem', { TotalPrice: 15.7 })).toEqual([]);
  });

  it('keeps a lone unit price', () => {
    expect(exclusiveFieldsToDrop('OpportunityLineItem', { UnitPrice: 7.85 })).toEqual([]);
  });

  it('treats a null as absent, since a null is never sent', () => {
    expect(
      exclusiveFieldsToDrop('OpportunityLineItem', { UnitPrice: 7.85, TotalPrice: null }),
    ).toEqual([]);
  });

  it('treats an explicit undefined as absent', () => {
    expect(
      exclusiveFieldsToDrop('OpportunityLineItem', { UnitPrice: 7.85, TotalPrice: undefined }),
    ).toEqual([]);
  });

  it('leaves an object with no rule untouched', () => {
    expect(exclusiveFieldsToDrop('Account', { UnitPrice: 1, TotalPrice: 2 })).toEqual([]);
  });

  it('applies the same rule to a quote line', () => {
    expect(exclusiveFieldsToDrop('QuoteLineItem', { UnitPrice: 1, TotalPrice: 2 })).toEqual([
      'TotalPrice',
    ]);
  });

  it('names the field to keep first in every group', () => {
    for (const group of EXCLUSIVE_FIELD_GROUPS) {
      expect(group.fields.length).toBeGreaterThanOrEqual(2);
      expect(group.fields[0]).toBe('UnitPrice');
    }
  });
});

describe('exclusiveFieldToFill', () => {
  const all = (): boolean => true;
  const none = (): boolean => false;

  it('names the unit price of a line that holds neither price', () => {
    expect(exclusiveFieldToFill('OpportunityLineItem', all, none)).toBe('UnitPrice');
  });

  it('names nothing while the line holds either price', () => {
    const holdsIt =
      (held: string) =>
      (field: string): boolean =>
        field === held;

    expect(exclusiveFieldToFill('OpportunityLineItem', all, holdsIt('TotalPrice'))).toBe(undefined);
    expect(exclusiveFieldToFill('OpportunityLineItem', all, holdsIt('UnitPrice'))).toBe(undefined);
  });

  it('holds a quote line to its unit price, the one price an insert sets', () => {
    const notTheTotal = (field: string): boolean => field !== 'TotalPrice';

    expect(exclusiveFieldToFill('QuoteLineItem', notTheTotal, none)).toBe('UnitPrice');
    // A total nothing can send fills nothing.
    expect(exclusiveFieldToFill('QuoteLineItem', notTheTotal, (f) => f === 'TotalPrice')).toBe(
      'UnitPrice',
    );
  });

  it('asks nothing of an object with no group, or whose group no insert can set', () => {
    expect(exclusiveFieldToFill('Account', all, none)).toBe(undefined);
    expect(exclusiveFieldToFill('OpportunityLineItem', none, none)).toBe(undefined);
  });
});
