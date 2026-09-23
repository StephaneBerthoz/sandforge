import { describe, it, expect } from 'vitest';
import type { SeedRelationDraft } from '../../stores/useSeedWizardStore';
import type { FieldConfig, ObjectFieldConfig } from './Step3_ConfigureFields';
import {
  DEFAULT_PARENT_LIMIT,
  canDrawFromRun,
  checkRelations,
  draftForLookup,
  newRelationDraft,
  relationLookups,
  settledNumber,
  typedNumber,
} from './seedRelationDrafts';
import type { RelationLookup } from './seedRelationDrafts';

/** A described field; a lookup when it names what it points at. */
function field(fieldApiName: string, referenceTo: string[] = []): FieldConfig {
  return {
    fieldApiName,
    label: fieldApiName,
    type: referenceTo.length > 0 ? 'reference' : 'string',
    required: false,
    ruleType: referenceTo.length > 0 ? 'reference' : 'faker',
    config: referenceTo.length > 0 ? { referenceObject: referenceTo[0] } : {},
    ...(referenceTo.length > 0 ? { referenceTo } : {}),
  };
}

/** The describes of the objects the tests seed. */
const FIELD_CONFIGS: ObjectFieldConfig[] = [
  {
    objectApiName: 'Account',
    objectLabel: 'Account',
    fields: [field('Name'), field('ParentId', ['Account'])],
  },
  {
    objectApiName: 'Contact',
    objectLabel: 'Contact',
    fields: [field('LastName'), field('AccountId', ['Account']), field('OwnerId', ['User'])],
  },
  { objectApiName: 'Case', objectLabel: 'Case', fields: [field('ContactId', ['Contact'])] },
  { objectApiName: 'Task', objectLabel: 'Task', fields: [field('WhoId', ['Contact', 'Lead'])] },
];

/** A row with the settings given, the rest at the editor's defaults. */
function row(overrides: Partial<SeedRelationDraft>): SeedRelationDraft {
  return {
    key: 'r',
    childObject: 'Contact',
    lookupField: 'AccountId',
    parentObject: 'Account',
    source: 'generated',
    where: '',
    limit: DEFAULT_PARENT_LIMIT,
    mode: 'perParent',
    count: 3,
    min: 1,
    max: 3,
    ratio: 0.5,
    ...overrides,
  };
}

/** The rows checked with Account, Contact and Case seeded, five accounts asked for. */
function check(rows: SeedRelationDraft[], selectedObjects = ['Account', 'Contact', 'Case']) {
  return checkRelations(rows, {
    selectedObjects,
    volumes: { Account: { count: 5, batchSize: 200 } },
    lookups: relationLookups(FIELD_CONFIGS, selectedObjects),
  });
}

describe('relationLookups', () => {
  it('lists the lookups of the selected objects, with what the org says they point at', () => {
    const lookups = relationLookups(FIELD_CONFIGS, ['Contact', 'Task']);

    expect(lookups).toEqual([
      {
        childObject: 'Contact',
        lookupField: 'AccountId',
        label: 'AccountId',
        parents: ['Account'],
      },
      { childObject: 'Contact', lookupField: 'OwnerId', label: 'OwnerId', parents: ['User'] },
      { childObject: 'Task', lookupField: 'WhoId', label: 'WhoId', parents: ['Contact', 'Lead'] },
    ]);
  });

  it('still knows a lookup whose rule the author changed', () => {
    const configs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Contact',
        objectLabel: 'Contact',
        fields: [{ ...field('AccountId', ['Account']), ruleType: 'static', config: {} }],
      },
    ];

    expect(relationLookups(configs, ['Contact'])[0].parents).toEqual(['Account']);
  });
});

describe('canDrawFromRun', () => {
  it('draws from the records this run writes for another seeded object', () => {
    expect(canDrawFromRun('Contact', 'Account', ['Account', 'Contact'])).toBe(true);
  });

  it('cannot draw from an object the run does not seed, nor from the insert of the object itself', () => {
    expect(canDrawFromRun('Contact', 'Account', ['Contact'])).toBe(false);
    expect(canDrawFromRun('Account', 'Account', ['Account'])).toBe(false);
  });
});

describe('draftForLookup', () => {
  const contactAccount: RelationLookup = {
    childObject: 'Contact',
    lookupField: 'AccountId',
    label: 'Account ID',
    parents: ['Account'],
  };

  it('draws from this run when the run seeds the parent', () => {
    expect(draftForLookup(contactAccount, ['Account', 'Contact']).source).toBe('generated');
  });

  it('reads the parents from the org when the run does not seed them', () => {
    expect(draftForLookup(contactAccount, ['Contact']).source).toBe('existing');
  });

  it('takes the parent named for a lookup that may point at several objects', () => {
    const whoId: RelationLookup = { ...contactAccount, parents: ['Contact', 'Lead'] };
    expect(draftForLookup(whoId, ['Contact', 'Task'], 'Lead')).toMatchObject({
      parentObject: 'Lead',
      source: 'existing',
    });
  });
});

describe('newRelationDraft', () => {
  it('starts on a lookup whose parents the run creates', () => {
    const lookups = relationLookups(FIELD_CONFIGS, ['Account', 'Contact']);

    const draft = newRelationDraft(lookups, ['Account', 'Contact'], [], 'r1');

    expect(draft).toMatchObject({
      key: 'r1',
      childObject: 'Contact',
      lookupField: 'AccountId',
      parentObject: 'Account',
      source: 'generated',
      mode: 'perParent',
      count: 3,
    });
  });

  it('moves on to an object no row fills yet', () => {
    const selected = ['Account', 'Contact', 'Case'];
    const lookups = relationLookups(FIELD_CONFIGS, selected);

    const draft = newRelationDraft(lookups, selected, [row({})], 'r2');

    expect(draft).toMatchObject({
      childObject: 'Case',
      lookupField: 'ContactId',
      source: 'generated',
    });
  });

  it('reads the parents from the org when the run creates none a lookup could take', () => {
    const lookups = relationLookups(FIELD_CONFIGS, ['Account']);

    const draft = newRelationDraft(lookups, ['Account'], [], 'r1');

    expect(draft).toMatchObject({
      childObject: 'Account',
      lookupField: 'ParentId',
      source: 'existing',
    });
  });

  it('starts nothing when no selected object has a lookup', () => {
    expect(newRelationDraft([], ['Lead'], [], 'r1')).toBeNull();
  });
});

describe('checkRelations', () => {
  it('plans the children from the records the run writes for the parent', () => {
    const [checked] = check([row({})]);

    expect(checked).toEqual({
      relation: {
        childObject: 'Contact',
        lookupField: 'AccountId',
        parentObject: 'Account',
        parents: { kind: 'generated' },
        distribution: { mode: 'perParent', count: 3 },
      },
      parents: 5,
      children: 15,
      problem: null,
    });
  });

  it('counts a parent never given a count at the hundred records the run writes for it', () => {
    const [checked] = checkRelations([row({})], {
      selectedObjects: ['Account', 'Contact'],
      volumes: {},
      lookups: relationLookups(FIELD_CONFIGS, ['Account', 'Contact']),
    });

    expect(checked.parents).toBe(100);
    expect(checked.children).toBe(300);
  });

  it('counts parents that are the children of another relation as that relation plans them', () => {
    const [contacts, cases] = check([
      row({}),
      row({
        key: 'r2',
        childObject: 'Case',
        lookupField: 'ContactId',
        parentObject: 'Contact',
        count: 2,
      }),
    ]);

    expect(contacts.children).toBe(15);
    expect(cases).toMatchObject({ parents: 15, children: 30, problem: null });
  });

  it('plans records already in the org from the bound, with the filter as typed and trimmed', () => {
    const [checked] = check(
      [row({ source: 'existing', where: "  Industry = 'Energy' ", limit: 4 })],
      ['Contact'],
    );

    expect(checked.relation?.parents).toEqual({
      kind: 'existing',
      where: "Industry = 'Energy'",
      limit: 4,
    });
    expect(checked.children).toBe(12);
  });

  it('sends no filter when none is typed', () => {
    const [checked] = check([row({ source: 'existing', where: '   ' })], ['Contact']);

    expect(checked.relation?.parents).toEqual({ kind: 'existing', limit: DEFAULT_PARENT_LIMIT });
  });

  it('plans the ceiling of a range and what a ratio spreads', () => {
    const [range] = check([row({ mode: 'range', min: 0, max: 4 })]);
    const [ratio] = check([row({ mode: 'ratio', ratio: 1.5 })]);

    expect(range.children).toBe(20);
    expect(ratio.children).toBe(7);
  });

  it('refuses a second row on a child another row already fills', () => {
    const [first, second] = check([row({}), row({ key: 'r2' })]);

    expect(first.problem).toBeNull();
    expect(second).toMatchObject({ relation: null, problem: 'duplicate' });
  });

  it('refuses parents from this run the run does not write before the child', () => {
    expect(check([row({})], ['Contact'])[0].problem).toBe('generatedParent');
    expect(
      check([row({ childObject: 'Account', lookupField: 'ParentId' })], ['Account'])[0].problem,
    ).toBe('generatedParent');
  });

  it('refuses two relations drawing from the records of each other', () => {
    const configs: ObjectFieldConfig[] = [
      FIELD_CONFIGS[1],
      {
        objectApiName: 'Account',
        objectLabel: 'Account',
        fields: [field('Primary_Contact__c', ['Contact'])],
      },
    ];
    const rows = [
      row({}),
      row({
        key: 'r2',
        childObject: 'Account',
        lookupField: 'Primary_Contact__c',
        parentObject: 'Contact',
      }),
    ];

    const checked = checkRelations(rows, {
      selectedObjects: ['Account', 'Contact'],
      volumes: {},
      lookups: relationLookups(configs, ['Account', 'Contact']),
    });

    expect(checked.some((c) => c.problem === 'generatedParent')).toBe(true);
  });

  it('refuses numbers outside their bounds, and a field left empty', () => {
    for (const overrides of [
      { count: Number.NaN },
      { count: 0 },
      { mode: 'range' as const, min: 4, max: 2 },
      { mode: 'ratio' as const, ratio: 0 },
      { source: 'existing' as const, limit: 0 },
      { source: 'existing' as const, limit: 2001 },
    ]) {
      expect(check([row(overrides)])[0].problem).toBe('numbers');
    }
  });

  it('refuses a spread that plans no child, and says how many parents it had', () => {
    const [checked] = check([row({ mode: 'ratio', ratio: 0.1 })]);

    expect(checked).toMatchObject({
      relation: null,
      parents: 5,
      children: 0,
      problem: 'noChildren',
    });
  });

  it('refuses a row on a lookup the selected objects do not have', () => {
    expect(check([row({ lookupField: 'Nope__c' })])[0].problem).toBe('incomplete');
    expect(check([row({ parentObject: 'Lead' })])[0].problem).toBe('incomplete');
  });
});

describe('typedNumber', () => {
  it('reads a number as typed, and nothing from an emptied field', () => {
    expect(typedNumber('12')).toBe(12);
    expect(typedNumber('0.5')).toBe(0.5);
    expect(typedNumber('')).toBeNaN();
  });
});

describe('settledNumber', () => {
  it('brings a number left out of bounds back within them', () => {
    expect(settledNumber(0, 1, 1000)).toBe(1);
    expect(settledNumber(5000, 1, 1000)).toBe(1000);
  });

  it('gives an emptied field its lowest value', () => {
    expect(settledNumber(Number.NaN, 1, 1000)).toBe(1);
  });

  it('keeps a whole number whole, and an average to the hundredth', () => {
    expect(settledNumber(2.6, 1, 1000)).toBe(3);
    expect(settledNumber(0.333, 0.01, 1000, false)).toBe(0.33);
  });
});
