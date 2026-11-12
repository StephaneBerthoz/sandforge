import { describe, it, expect } from 'vitest';
import {
  MODIFY_ALL_DATA_SOQL,
  OBJECT_PERMISSIONS,
  createFactsOnce,
  everCreatableSoql,
  noUserCreates,
  notCreatableBy,
  parentsToEdit,
  readCreateFacts,
  readEverCreatable,
  type CreateFacts,
  type CreateFactsDeps,
  type ParentField,
} from './targetCreators.js';
import type { QueryAnswer } from './TargetAutomationReader.js';

/**
 * Some of what a scratch org's `ObjectPermissions` describe lists in its
 * `SobjectType` picklist, as given: what a permission set can give Create on.
 */
const COVERABLE = [
  'Account',
  'ApprovalWorkItem',
  'Campaign',
  'Contact',
  'FinanceBalanceSnapshot',
  'Invoice',
  'Opportunity',
  'Order',
  'Pricebook2',
  'Product2',
  'Quote',
  'Thing__c',
];

/** The facts of that org, as read by a user who holds Modify All Data or not. */
function factsOf(modifyAllData: boolean | undefined): CreateFacts {
  return {
    coverable: new Set(COVERABLE.map((name) => name.toLowerCase())),
    ...(modifyAllData === undefined ? {} : { modifyAllData }),
  };
}

describe('notCreatableBy', () => {
  it('says no user creates the setup an administrator holding Modify All Data may not, which no permission set covers', () => {
    // Read on a scratch org as its administrator: none of these createable,
    // none in ObjectPermissions' picklist, and IsEverCreatable true for each.
    for (const name of [
      'Report',
      'Dashboard',
      'DashboardComponent',
      'AppDefinition',
      'TabDefinition',
      'DeleteEvent',
      'Calendar',
      'SlaProcess',
      'AccountCleanInfo',
      'ProcessInstanceWorkitem',
      'SessionHijackingEventStore',
    ]) {
      const by = notCreatableBy(name, factsOf(true), true);
      expect(by, name).toBe('setup');
      expect(noUserCreates(by), name).toBe(true);
    }
  });

  it('says a feature or licence closes what a permission set covers and an administrator holding Modify All Data still may not create', () => {
    for (const name of ['Invoice', 'ApprovalWorkItem', 'FinanceBalanceSnapshot', 'invoice']) {
      const by = notCreatableBy(name, factsOf(true), true);
      expect(by, name).toBe('feature');
      expect(noUserCreates(by), name).toBe(false);
    }
  });

  it('leaves to the user, with the grant that opens it, what a permission set covers and they may not create without Modify All Data', () => {
    expect(notCreatableBy('Thing__c', factsOf(false), true)).toBe('user');
    expect(notCreatableBy('Thing__c', factsOf(undefined), true)).toBe('user');
  });

  it('says what no permission set covers closed through what it hangs from for a user without Modify All Data, never left out', () => {
    // An opportunity's products and a task read the same as a report to a
    // user without Modify All Data: none of the three in the picklist.
    for (const name of ['OpportunityLineItem', 'Task', 'Report']) {
      for (const modifyAllData of [false, undefined]) {
        const by = notCreatableBy(name, factsOf(modifyAllData), true);
        expect(by, name).toBe('parent');
        expect(noUserCreates(by), name).toBe(false);
      }
    }
  });

  it('takes the target at its word when it says no user ever creates an object, whoever asks', () => {
    for (const facts of [factsOf(true), factsOf(false), {}]) {
      expect(notCreatableBy('FlowRecord', facts, false)).toBe('platform');
    }
  });

  it('leaves an object to the user when the target would not say what a permission set covers', () => {
    expect(notCreatableBy('Report', { modifyAllData: true }, true)).toBe('user');
    expect(notCreatableBy('Report', {}, undefined)).toBe('user');
  });
});

/** Fake target answering the two reads, and what it was asked. */
function fakeTarget(
  answer: {
    picklist?: readonly string[];
    modifyAllData?: unknown;
    refuseDescribe?: boolean;
    refuseQuery?: boolean;
    held?: boolean;
  } = {},
) {
  const asked: string[] = [];
  const deps: CreateFactsDeps = {
    describeFields: async (orgId, objectApiName) => {
      asked.push(`describe ${orgId} ${objectApiName}`);
      if (answer.refuseDescribe) throw new Error(`INVALID_TYPE: ${objectApiName}`);
      return {
        fields: [
          { name: 'ParentId', picklistValues: [] },
          { name: 'SobjectType', picklistValues: answer.picklist ?? [] },
        ],
        sent: answer.held !== true,
      };
    },
    query: async (orgId, soql): Promise<QueryAnswer> => {
      asked.push(`query ${orgId} ${soql}`);
      if (answer.refuseQuery) throw new Error('INVALID_TYPE: UserPermissionAccess');
      return {
        records:
          answer.modifyAllData === undefined
            ? []
            : [{ PermissionsModifyAllData: answer.modifyAllData }],
        requests: 1,
      };
    },
  };
  return { deps, asked };
}

describe('readCreateFacts', () => {
  it('reads what a permission set covers from one describe and Modify All Data from one query', async () => {
    const target = fakeTarget({ picklist: COVERABLE, modifyAllData: true });

    const { facts, requests } = await readCreateFacts(target.deps, 'tgt');

    expect(target.asked).toEqual([
      `describe tgt ${OBJECT_PERMISSIONS}`,
      `query tgt ${MODIFY_ALL_DATA_SOQL}`,
    ]);
    expect(requests).toBe(2);
    expect(facts.modifyAllData).toBe(true);
    expect(facts.coverable?.has('thing__c')).toBe(true);
    expect(facts.coverable?.has('report')).toBe(false);
  });

  it('counts no request for a describe the run held already', async () => {
    const target = fakeTarget({ picklist: COVERABLE, modifyAllData: false, held: true });

    const { facts, requests } = await readCreateFacts(target.deps, 'tgt');

    expect(requests).toBe(1);
    expect(facts.modifyAllData).toBe(false);
  });

  it('leaves out of the facts what the target refused or did not answer, and counts its requests', async () => {
    const refused = await readCreateFacts(
      fakeTarget({ refuseDescribe: true, refuseQuery: true }).deps,
      'tgt',
    );
    const unanswered = await readCreateFacts(fakeTarget({ modifyAllData: 'true' }).deps, 'tgt');

    expect(refused).toEqual({ facts: {}, requests: 2 });
    // A picklist with no value, and a permission the org did not give as one.
    expect(unanswered.facts).toEqual({});
  });
});

describe('readEverCreatable', () => {
  it('asks the target once for the objects named, and keeps what it answered', async () => {
    const asked: string[] = [];
    const { answered, requests } = await readEverCreatable(
      async (_orgId, soql) => {
        asked.push(soql);
        return {
          records: [
            { QualifiedApiName: 'FlowRecord', IsEverCreatable: false },
            { QualifiedApiName: 'Report', IsEverCreatable: true },
            { QualifiedApiName: 'Calendar', IsEverCreatable: 'true' },
          ],
          requests: 1,
        };
      },
      'tgt',
      ['FlowRecord', 'Report', 'Calendar', "bad'name"],
    );

    expect(asked).toEqual([everCreatableSoql(['FlowRecord', 'Report', 'Calendar'])]);
    expect(requests).toBe(1);
    expect([...answered]).toEqual([
      ['flowrecord', false],
      ['report', true],
    ]);
  });

  it('says nothing of any object when the target refuses, and asks nothing for none', async () => {
    const refused = await readEverCreatable(
      async () => {
        throw new Error('INSUFFICIENT_ACCESS: View Setup');
      },
      'tgt',
      ['Report'],
    );
    let asked = 0;
    const none = await readEverCreatable(
      async () => {
        asked++;
        return { records: [], requests: 1 };
      },
      'tgt',
      [],
    );

    expect(refused).toEqual({ answered: new Map(), requests: 1 });
    expect(none).toEqual({ answered: new Map(), requests: 0 });
    expect(asked).toBe(0);
  });
});

describe('parentsToEdit', () => {
  const reference = (name: string, referenceTo: string[], nillable = false): ParentField => ({
    name,
    type: 'reference',
    nillable,
    referenceTo,
  });

  it('names the objects a permission set covers among those the required lookups point at', () => {
    // An opportunity's product: its opportunity and its price book entry are
    // required, and only the opportunity is one a permission set opens.
    const fields = [
      reference('OpportunityId', ['Opportunity']),
      reference('PricebookEntryId', ['PricebookEntry']),
      reference('Product2Id', ['Product2'], true),
      { name: 'Quantity', type: 'double', nillable: false, referenceTo: [] },
    ];

    expect(parentsToEdit(fields, factsOf(false))).toEqual(['Opportunity']);
  });

  it('names none for an object whose required lookups point at no object a permission set covers, or when the target did not say', () => {
    // A task's owner is a user or a queue, which no permission set covers.
    expect(parentsToEdit([reference('OwnerId', ['User', 'Group'])], factsOf(false))).toEqual([]);
    expect(parentsToEdit([reference('OpportunityId', ['Opportunity'])], {})).toEqual([]);
  });
});

describe('createFactsOnce', () => {
  it('reads an org once while its describes are kept, then again', async () => {
    let reads = 0;
    let clock = 0;
    const read = createFactsOnce(
      async () => {
        reads++;
        return { modifyAllData: true };
      },
      1_000,
      () => clock,
    );

    await Promise.all([read('tgt'), read('tgt')]);
    clock = 999;
    await read('tgt');
    expect(reads).toBe(1);
    await read('other');
    expect(reads).toBe(2);
    clock = 1_000;
    await read('tgt');
    expect(reads).toBe(3);
  });

  it('keeps no read that failed', async () => {
    let reads = 0;
    const read = createFactsOnce(async () => {
      reads++;
      if (reads === 1) throw new Error('socket hang up');
      return {};
    }, 60_000);

    await expect(read('tgt')).rejects.toThrow('socket hang up');
    await expect(read('tgt')).resolves.toEqual({});
    expect(reads).toBe(2);
  });
});
