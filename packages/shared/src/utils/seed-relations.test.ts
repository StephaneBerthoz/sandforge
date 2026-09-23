import { describe, it, expect } from 'vitest';
import type { SeedObjectConfig, SeedRelation } from '../types/seed.types.js';
import {
  childrenPerParent,
  plannedChildCount,
  relationFor,
  seedDependencies,
} from './seed-relations.js';

/** A contact relation to accounts, with the parents and spread given. */
function contactsOf(
  parents: SeedRelation['parents'],
  distribution: SeedRelation['distribution'] = { mode: 'perParent', count: 3 },
): SeedRelation {
  return {
    childObject: 'Contact',
    lookupField: 'AccountId',
    parentObject: 'Account',
    parents,
    distribution,
  };
}

/** An object whose only rules are the reference rules given, as field → target. */
function objectWithLookups(
  objectApiName: string,
  lookups: Record<string, string>,
): Pick<SeedObjectConfig, 'objectApiName' | 'fieldRules'> {
  return {
    objectApiName,
    fieldRules: [
      { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company.name' } },
      ...Object.entries(lookups).map(([fieldApiName, referenceObject]) => ({
        fieldApiName,
        ruleType: 'reference' as const,
        config: { referenceObject, referenceField: 'Id' },
      })),
    ],
  };
}

describe('childrenPerParent', () => {
  it('gives every parent the same number when the count is fixed', () => {
    expect(childrenPerParent({ mode: 'perParent', count: 3 }, 4)).toEqual([3, 3, 3, 3]);
  });

  it('draws each parent a whole number inside the range, both ends included', () => {
    const draws = [0, 0.999999, 0.5];
    let at = 0;
    const counts = childrenPerParent({ mode: 'range', min: 1, max: 4 }, 3, () => draws[at++]);
    expect(counts).toEqual([1, 4, 3]);
  });

  it('stays inside the range even when the draw reaches its upper bound', () => {
    expect(childrenPerParent({ mode: 'range', min: 2, max: 5 }, 2, () => 1)).toEqual([5, 5]);
  });

  it('gives a child to every other parent at half a child per parent', () => {
    expect(childrenPerParent({ mode: 'ratio', ratio: 0.5 }, 6)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('alternates one and two at one and a half children per parent', () => {
    expect(childrenPerParent({ mode: 'ratio', ratio: 1.5 }, 4)).toEqual([1, 2, 1, 2]);
  });

  it('counts a ratio in whole hundredths, so a hundred parents at 0.29 get 29 children', () => {
    // Math.floor(100 * 0.29) is 28 in floating point.
    const counts = childrenPerParent({ mode: 'ratio', ratio: 0.29 }, 100);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(29);
    expect(Math.max(...counts)).toBe(1);
  });

  it('gives nothing to no parent', () => {
    expect(childrenPerParent({ mode: 'perParent', count: 3 }, 0)).toEqual([]);
  });
});

describe('plannedChildCount', () => {
  it('multiplies the parents by a fixed count', () => {
    expect(plannedChildCount({ mode: 'perParent', count: 3 }, 5)).toBe(15);
  });

  it('plans the ceiling of a range, the most the run can write', () => {
    expect(plannedChildCount({ mode: 'range', min: 1, max: 4 }, 5)).toBe(20);
  });

  it('plans exactly what a ratio spreads', () => {
    for (const ratio of [0.01, 0.29, 0.5, 1.5, 2.25]) {
      for (const parents of [1, 7, 100]) {
        const spread = childrenPerParent({ mode: 'ratio', ratio }, parents);
        expect(plannedChildCount({ mode: 'ratio', ratio }, parents)).toBe(
          spread.reduce((sum, n) => sum + n, 0),
        );
      }
    }
  });

  it('plans no child when the ratio gives every parent less than one in total', () => {
    expect(plannedChildCount({ mode: 'ratio', ratio: 0.1 }, 5)).toBe(0);
  });
});

describe('relationFor', () => {
  it('finds the relation that fills a lookup of the object', () => {
    const relation = contactsOf({ kind: 'generated' });
    expect(relationFor('Contact', [relation])).toBe(relation);
  });

  it('finds none for an object no relation fills', () => {
    expect(relationFor('Account', [contactsOf({ kind: 'generated' })])).toBeUndefined();
    expect(relationFor('Contact', undefined)).toBeUndefined();
  });
});

describe('seedDependencies', () => {
  it('lists the targets of the reference rules when no relation applies', () => {
    const contact = objectWithLookups('Contact', { AccountId: 'Account', ReportsToId: 'Lead' });
    expect(seedDependencies(contact, []).sort()).toEqual(['Account', 'Lead']);
  });

  it('adds the parent a relation draws from the records the run writes', () => {
    const contact = objectWithLookups('Contact', {});
    expect(seedDependencies(contact, [contactsOf({ kind: 'generated' })])).toEqual(['Account']);
  });

  it('depends on nothing the run writes when the parents are already in the org', () => {
    const contact = objectWithLookups('Contact', { AccountId: 'Account' });
    const relation = contactsOf({ kind: 'existing', limit: 10 });
    expect(seedDependencies(contact, [relation])).toEqual([]);
  });

  it('keeps the targets of the lookups the relation does not fill', () => {
    const opportunity = objectWithLookups('Opportunity', {
      AccountId: 'Account',
      CampaignId: 'Campaign',
    });
    const relation: SeedRelation = {
      ...contactsOf({ kind: 'existing', limit: 10 }),
      childObject: 'Opportunity',
    };
    expect(seedDependencies(opportunity, [relation])).toEqual(['Campaign']);
  });
});
