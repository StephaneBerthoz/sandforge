import { describe, it, expect } from 'vitest';
import { insertionGroups, orderWithinGroup } from './insertionOrder.js';

/** Object → the objects it points at, from `[child, [parents…]]` pairs. */
function depsOf(entries: Array<[string, string[]]>): Map<string, Set<string>> {
  return new Map(entries.map(([name, parents]) => [name, new Set(parents)]));
}

describe('insertionGroups', () => {
  it('puts every parent before its children when nothing forms a cycle', () => {
    const groups = insertionGroups(
      depsOf([
        ['OrderItem', ['Order', 'PricebookEntry']],
        ['PricebookEntry', ['Product2']],
        ['Order', ['Account']],
        ['Account', []],
        ['Product2', []],
      ]),
    );

    // Taken a layer at a time: what needs nothing, then what needs only that.
    expect(groups).toEqual([
      ['Account'],
      ['Product2'],
      ['Order'],
      ['PricebookEntry'],
      ['OrderItem'],
    ]);
  });

  it('keeps the objects of a cycle together, and what hangs off the cycle after it', () => {
    // An Account points at its key Contact, the Contact at its Account; the
    // relation between them has to wait for both.
    const groups = insertionGroups(
      depsOf([
        ['AccountContactRelation', ['Account', 'Contact']],
        ['Account', ['Contact']],
        ['Contact', ['Account']],
      ]),
    );

    expect(groups).toEqual([['Account', 'Contact'], ['AccountContactRelation']]);
  });

  it('ignores a dependency on an object outside the set', () => {
    const groups = insertionGroups(depsOf([['Contact', ['User']]]));

    expect(groups).toEqual([['Contact']]);
  });

  it('orders independent objects by name, whatever order they were given in', () => {
    const groups = insertionGroups(
      depsOf([
        ['Location', []],
        ['Account', []],
        ['Campaign', []],
      ]),
    );

    expect(groups).toEqual([['Account'], ['Campaign'], ['Location']]);
  });
});

describe('orderWithinGroup', () => {
  it('writes the object a required lookup points at before the one that holds it', () => {
    // A contract cannot be written without its account; everything else in
    // the cycle can wait for the second pass.
    const order = orderWithinGroup(
      ['Account', 'Contact', 'Contract', 'Opportunity'],
      depsOf([['Contract', ['Account']]]),
    );

    expect(order.indexOf('Account')).toBeLessThan(order.indexOf('Contract'));
    expect(order).toEqual(['Account', 'Contact', 'Opportunity', 'Contract']);
  });

  it('ignores a required lookup at an object outside the group', () => {
    const order = orderWithinGroup(['Order', 'OrderItem'], depsOf([['Order', ['Account']]]));

    expect(order).toEqual(['Order', 'OrderItem']);
  });

  it('writes a cycle of required lookups alphabetically, since no order can satisfy it', () => {
    const order = orderWithinGroup(
      ['Beta', 'Alpha', 'Gamma'],
      depsOf([
        ['Alpha', ['Beta']],
        ['Beta', ['Alpha']],
      ]),
    );

    expect(order).toEqual(['Gamma', 'Alpha', 'Beta']);
  });
});
