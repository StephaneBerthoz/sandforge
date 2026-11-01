import { describe, it, expect } from 'vitest';
import {
  atInsertDeps,
  insertionGroups,
  orderWithinGroup,
  waveGroupsOf,
  writeOrderOf,
} from './insertionOrder.js';

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

describe('atInsertDeps', () => {
  const group = ['Alpha', 'Beta'];
  const noLookups = () => null;

  it('needs what a required lookup points at, inside the cycle only', () => {
    const needs = atInsertDeps(
      group,
      [
        { from: 'Beta', to: 'Alpha', fieldApiName: 'Beta__c', required: true },
        { from: 'Outside', to: 'Alpha', fieldApiName: 'Outside__c', required: true },
      ],
      noLookups,
    );

    expect(needs).toEqual(depsOf([['Alpha', ['Beta']]]));
  });

  it('needs what the platform requires though the describe says the lookup may be empty', () => {
    const needs = atInsertDeps(
      ['PricebookEntry', 'QuoteLineItem'],
      [{ from: 'PricebookEntry', to: 'QuoteLineItem', fieldApiName: 'PricebookEntryId' }],
      noLookups,
    );

    expect(needs).toEqual(depsOf([['QuoteLineItem', ['PricebookEntry']]]));
  });

  it('needs what only a create can set, as the target describes it', () => {
    const edges = [{ from: 'Beta', to: 'Alpha', fieldApiName: 'Beta__c' }];
    const lookup = (updateable: boolean) => () => [
      { name: 'Beta__c', createable: true, updateable },
    ];

    expect(atInsertDeps(group, edges, lookup(false))).toEqual(depsOf([['Alpha', ['Beta']]]));
    expect(atInsertDeps(group, edges, lookup(true))).toEqual(new Map());
    expect(atInsertDeps(group, edges, noLookups)).toEqual(new Map());
  });
});

describe('waveGroupsOf', () => {
  it('reads a wave by the lookups between its objects, a self-reference apart', () => {
    const edges = [
      { from: 'Contact', to: 'Account', fieldApiName: 'Primary__c' },
      { from: 'Account', to: 'Contact', fieldApiName: 'AccountId' },
      { from: 'Account', to: 'Account', fieldApiName: 'ParentId' },
      { from: 'User', to: 'Account', fieldApiName: 'OwnerId' },
    ];

    const { within, deps, groups } = waveGroupsOf(['Account', 'Contact', 'Lead'], edges);

    expect(within.map((edge) => edge.fieldApiName)).toEqual(['Primary__c', 'AccountId']);
    expect(deps.get('Contact')).toEqual(new Set(['Account']));
    expect(groups).toEqual([['Account', 'Contact'], ['Lead']]);
  });
});

describe('writeOrderOf', () => {
  it('goes wave by wave, a cycle in the order its required lookups leave it', () => {
    const edges = [
      { from: 'Zeta', to: 'Alpha', fieldApiName: 'Zeta__c', required: true },
      { from: 'Alpha', to: 'Zeta', fieldApiName: 'Alpha__c' },
      { from: 'Root', to: 'Zeta', fieldApiName: 'Root__c' },
    ];

    expect(writeOrderOf([['Root'], ['Alpha', 'Zeta'], ['Leaf']], edges, () => null)).toEqual([
      'Root',
      'Zeta',
      'Alpha',
      'Leaf',
    ]);
  });

  it('puts inside one wave what a lookup says goes first, with no cycle', () => {
    expect(
      writeOrderOf(
        [['Alpha', 'Zeta']],
        [{ from: 'Zeta', to: 'Alpha', fieldApiName: 'Zeta__c' }],
        () => null,
      ),
    ).toEqual(['Zeta', 'Alpha']);
  });
});
