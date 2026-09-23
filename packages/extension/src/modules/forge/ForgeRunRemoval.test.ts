import { describe, expect, it } from 'vitest';
import type { ForgeRunObjectRecords } from '@sandforge/shared';

import { removeRunRecords, type RemovalOrg, type RunRemovalOptions } from './ForgeRunRemoval.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_STARTED = '2026-09-20T10:00:00.000Z';
const DURING_RUN = '2026-09-20T10:02:00.000+0000';
const RUN_ENDED = '2026-09-20T10:05:00.000Z';
const AFTER_RUN = '2026-09-20T11:00:00.000+0000';
const BEFORE_RUN = '2026-09-19T09:00:00.000+0000';

type Row = Record<string, unknown> & { Id: string };
interface Relationship {
  childSObject: string;
  field: string;
  cascadeDelete: boolean;
}

/**
 * An org in memory: rows per object, the relationships each object's describe
 * lists, and a delete that takes what cascades along — as the org does.
 */
class FakeOrg implements RemovalOrg {
  readonly rows = new Map<string, Row[]>();
  readonly relationships = new Map<string, Relationship[]>();
  /** Objects a person works with: every object holding rows, unless removed. */
  readonly notWorked = new Set<string>();
  /** Ids the org refuses to delete, with the error it answers. */
  readonly refusals = new Map<string, { statusCode: string; message: string }>();
  /** A refusal that depends on what the org holds at the time of the delete. */
  refuse?: (object: string, row: Row) => { statusCode: string; message: string } | undefined;
  /** Queries that fail, by a pattern of their text. */
  readonly failingQueries: RegExp[] = [];
  /** The columns an object keeps, where it keeps fewer than every column asked for. */
  readonly columns = new Map<string, string[]>();
  /** What a delete of a record does to others: a roll-up restamping its parent. */
  onDelete?: (object: string, row: Row) => void;
  readonly queries: string[] = [];
  readonly deletes: Array<{ object: string; ids: string[] }> = [];

  add(object: string, ...rows: Row[]): void {
    this.rows.set(object, [...(this.rows.get(object) ?? []), ...rows]);
  }

  has(object: string, recordId: string): boolean {
    return (this.rows.get(object) ?? []).some((r) => r.Id === recordId);
  }

  async describe(objectApiName: string): Promise<unknown> {
    return {
      name: objectApiName,
      label: objectApiName,
      fields: [],
      childRelationships: this.relationships.get(objectApiName) ?? [],
    };
  }

  async describeGlobal(): Promise<unknown> {
    const names = new Set([
      ...this.rows.keys(),
      ...[...this.relationships.values()].flat().map((r) => r.childSObject),
    ]);
    return {
      sobjects: [...names].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: !this.notWorked.has(name),
      })),
    };
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.queries.push(soql);
    if (this.failingQueries.some((pattern) => pattern.test(soql))) {
      throw new Error('INVALID_FIELD: No such column on entity');
    }
    const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, field, list] = match;
    const kept = this.columns.get(object);
    const missing = kept && columns.split(', ').find((c) => !kept.includes(c));
    if (missing)
      throw new Error(`INVALID_FIELD: No such column '${missing}' on entity '${object}'`);
    const wanted = new Set(list.split(', ').map((quoted) => quoted.slice(1, -1)));
    const records = (this.rows.get(object) ?? [])
      .filter((row) => wanted.has(String(row[field])))
      .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
    return { totalSize: records.length, records };
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.deletes.push({ object: objectApiName, ids: [...ids] });
    return ids.map((recordId) => {
      const row = (this.rows.get(objectApiName) ?? []).find((r) => r.Id === recordId);
      const refusal = this.refusals.get(recordId) ?? (row && this.refuse?.(objectApiName, row));
      if (refusal) return { id: recordId, success: false, errors: [{ ...refusal, fields: [] }] };
      if (!this.has(objectApiName, recordId)) {
        return {
          id: recordId,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }],
        };
      }
      this.remove(objectApiName, recordId);
      return { id: recordId, success: true, errors: [] };
    });
  }

  private remove(object: string, recordId: string): void {
    const row = (this.rows.get(object) ?? []).find((r) => r.Id === recordId);
    if (!row) return;
    this.rows.set(
      object,
      (this.rows.get(object) ?? []).filter((r) => r.Id !== recordId),
    );
    this.onDelete?.(object, row);
    for (const relationship of this.relationships.get(object) ?? []) {
      if (!relationship.cascadeDelete) continue;
      for (const child of this.rows.get(relationship.childSObject) ?? []) {
        if (child[relationship.field] === recordId)
          this.remove(relationship.childSObject, child.Id);
      }
    }
  }
}

/** A record the run created: written during it, not touched since. */
function runRow(recordId: string, fields: Record<string, unknown> = {}): Row {
  return { Id: recordId, CreatedDate: DURING_RUN, LastModifiedDate: DURING_RUN, ...fields };
}

const ACCOUNT_CHILDREN: Relationship[] = [
  { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
  { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
  { childSObject: 'Case', field: 'AccountId', cascadeDelete: false },
];

/** An org holding what a run created: one account and two contacts under it. */
function accountWithContacts(): { org: FakeOrg; plan: ForgeRunObjectRecords[] } {
  const org = new FakeOrg();
  org.relationships.set('Account', ACCOUNT_CHILDREN);
  org.add('Account', runRow(id('001', 1)));
  org.add(
    'Contact',
    runRow(id('003', 1), { AccountId: id('001', 1) }),
    runRow(id('003', 2), { AccountId: id('001', 1) }),
  );
  const plan = [
    { objectApiName: 'Contact', ids: [id('003', 2), id('003', 1)] },
    { objectApiName: 'Account', ids: [id('001', 1)] },
  ];
  return { org, plan };
}

function options(overrides: Partial<RunRemovalOptions> = {}): RunRemovalOptions {
  return {
    runStartedAt: new Date(RUN_STARTED),
    runEndedAt: new Date(RUN_ENDED),
    includeChanged: false,
    ...overrides,
  };
}

describe('removeRunRecords', () => {
  it('deletes the children before their parents, two hundred at a time', async () => {
    const org = new FakeOrg();
    const contacts = Array.from({ length: 250 }, (_, i) => id('003', i + 1));
    org.add('Account', runRow(id('001', 1)));
    org.add('Contact', ...contacts.map((c) => runRow(c)));

    const outcome = await removeRunRecords(
      org,
      [
        { objectApiName: 'Contact', ids: contacts },
        { objectApiName: 'Account', ids: [id('001', 1)] },
      ],
      options(),
    );

    expect(org.deletes.map((d) => [d.object, d.ids.length])).toEqual([
      ['Contact', 200],
      ['Contact', 50],
      ['Account', 1],
    ]);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.objects.map((o) => [o.objectApiName, o.planned, o.deleted])).toEqual([
      ['Contact', 250, 250],
      ['Account', 1, 1],
    ]);
  });

  it('counts a record no longer in the org as already gone, and never sends it', async () => {
    const { org, plan } = accountWithContacts();
    org.rows.set(
      'Contact',
      (org.rows.get('Contact') ?? []).filter((r) => r.Id !== id('003', 2)),
    );

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[0]).toMatchObject({ planned: 2, deleted: 1, alreadyGone: 1 });
    expect(org.deletes[0].ids).toEqual([id('003', 1)]);
  });

  it('counts a record deleted between its read and its delete as already gone', async () => {
    const { org, plan } = accountWithContacts();
    org.refusals.set(id('003', 2), {
      statusCode: 'ENTITY_IS_DELETED',
      message: 'entity is deleted',
    });

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[0]).toMatchObject({ deleted: 1, alreadyGone: 1, refused: 0 });
  });

  it('keeps a record modified since the run ended, and its parent with it', async () => {
    const { org, plan } = accountWithContacts();
    org.add('Contact', runRow(id('003', 3)));
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;

    const outcome = await removeRunRecords(
      org,
      [{ objectApiName: 'Contact', ids: [...plan[0].ids, id('003', 3)] }, plan[1]],
      options(),
    );

    expect(outcome.objects[0]).toMatchObject({ deleted: 2, keptChanged: 1 });
    // The account would take the kept contact with it.
    expect(outcome.objects[1]).toMatchObject({
      deleted: 0,
      keptDependents: 1,
      heldBy: ['Contact'],
    });
    expect(org.has('Contact', id('003', 1))).toBe(true);
    expect(org.has('Account', id('001', 1))).toBe(true);
  });

  it('removes records modified since the run too when asked to', async () => {
    const { org, plan } = accountWithContacts();
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;

    const outcome = await removeRunRecords(org, plan, options({ includeChanged: true }));

    expect(outcome.objects.map((o) => o.deleted)).toEqual([2, 1]);
    expect(outcome.objects[0].keptChanged).toBe(0);
    expect(org.rows.get('Account')).toEqual([]);
  });

  it('reads every object before it deletes anything: a parent its children restamp is not changed', async () => {
    // Deleting a child recalculates a roll-up on its parent, which the org
    // records as a modification of the parent.
    const { org, plan } = accountWithContacts();
    org.onDelete = (object, row) => {
      if (object !== 'Contact') return;
      const parent = (org.rows.get('Account') ?? []).find((a) => a.Id === row.AccountId);
      if (parent) parent.LastModifiedDate = AFTER_RUN;
    };

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({
      objectApiName: 'Account',
      deleted: 1,
      keptChanged: 0,
    });
  });

  it('keeps a parent that a record created since the run depends on', async () => {
    const { org, plan } = accountWithContacts();
    org.add('Task', {
      Id: id('00T', 1),
      WhatId: id('001', 1),
      CreatedDate: AFTER_RUN,
      LastModifiedDate: AFTER_RUN,
    });

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({ deleted: 0, keptDependents: 1, heldBy: ['Task'] });
    expect(org.has('Task', id('00T', 1))).toBe(true);
  });

  it('keeps a parent that a record older than the run was moved under, whatever the request', async () => {
    const { org, plan } = accountWithContacts();
    org.add('Task', {
      Id: id('00T', 1),
      WhatId: id('001', 1),
      CreatedDate: BEFORE_RUN,
      LastModifiedDate: AFTER_RUN,
    });

    const kept = await removeRunRecords(org, plan, options());
    const stillKept = await removeRunRecords(org, plan, options({ includeChanged: true }));

    expect(kept.objects[1]).toMatchObject({ deleted: 0, keptDependents: 1 });
    // The run never made it: asking for what changed since the run does not reach it.
    expect(stillKept.objects[1]).toMatchObject({ deleted: 0, keptDependents: 1 });
    expect(org.has('Task', id('00T', 1))).toBe(true);
  });

  it('lets what was added to a record since the run go with it when changes are included', async () => {
    // Editing a cloned record adds records of its own: a tracked change in its
    // feed, the duplicate rule's match.
    const { org, plan } = accountWithContacts();
    org.add('Task', {
      Id: id('00T', 1),
      WhatId: id('001', 1),
      CreatedDate: AFTER_RUN,
      LastModifiedDate: AFTER_RUN,
    });

    const outcome = await removeRunRecords(org, plan, options({ includeChanged: true }));

    expect(outcome.objects[1]).toMatchObject({ deleted: 1, keptDependents: 0 });
    expect(org.has('Task', id('00T', 1))).toBe(false);
  });

  it('deletes a parent with what came with the run: created while it went, untouched since', async () => {
    // A task a flow opened when the account was inserted.
    const { org, plan } = accountWithContacts();
    org.add('Task', runRow(id('00T', 1), { WhatId: id('001', 1) }));

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({ deleted: 1, keptDependents: 0 });
    expect(org.has('Task', id('00T', 1))).toBe(false);
  });

  it('reads only the relationships the org deletes along, to objects a person works with', async () => {
    const { org, plan } = accountWithContacts();
    org.relationships.set('Account', [
      ...ACCOUNT_CHILDREN,
      { childSObject: 'AccountShare', field: 'AccountId', cascadeDelete: true },
    ]);
    org.notWorked.add('AccountShare');

    await removeRunRecords(org, plan, options());

    const read = org.queries.map((q) => /FROM (\w+) WHERE (\w+)/.exec(q)?.slice(1).join('.'));
    expect(read).toContain('Task.WhatId');
    expect(read).not.toContain('Case.AccountId');
    expect(read).not.toContain('AccountShare.AccountId');
  });

  it('names a relationship the org does not let be read as not checked, and removes all the same', async () => {
    // A member of a sales engagement list can only be read by its list, never
    // by the record it points at: holding every account for it would leave
    // every run's accounts behind.
    const { org, plan } = accountWithContacts();
    org.failingQueries.push(/FROM Task WHERE/);

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({
      deleted: 1,
      keptDependents: 0,
      unchecked: ['Task'],
    });
    expect(org.queries.filter((q) => q.includes('FROM Task WHERE'))).toHaveLength(3);
  });

  it('reads a relationship without the usual dates by its system stamp', async () => {
    // A file's link to a record keeps no CreatedDate and no LastModifiedDate.
    const { org, plan } = accountWithContacts();
    org.relationships.set('Account', [
      ...ACCOUNT_CHILDREN,
      { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
    ]);
    org.columns.set('ContentDocumentLink', ['Id', 'LinkedEntityId', 'SystemModstamp']);
    org.add('ContentDocumentLink', {
      Id: id('06A', 1),
      LinkedEntityId: id('001', 1),
      SystemModstamp: AFTER_RUN,
    });

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({
      deleted: 0,
      keptDependents: 1,
      heldBy: ['ContentDocumentLink'],
      unchecked: [],
    });
  });

  it('lets a link stamped while the run went go with its record', async () => {
    const { org, plan } = accountWithContacts();
    org.relationships.set('Account', [
      { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
    ]);
    org.columns.set('ContentDocumentLink', ['Id', 'LinkedEntityId', 'SystemModstamp']);
    org.add('ContentDocumentLink', {
      Id: id('06A', 1),
      LinkedEntityId: id('001', 1),
      SystemModstamp: DURING_RUN,
    });

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({ deleted: 1, keptDependents: 0 });
  });

  it('takes a dependent read without any date as one that stays', async () => {
    const { org, plan } = accountWithContacts();
    org.relationships.set('Account', [
      { childSObject: 'Undated__c', field: 'Account__c', cascadeDelete: true },
    ]);
    org.columns.set('Undated__c', ['Id', 'Account__c']);
    org.add('Undated__c', { Id: id('a00', 1), Account__c: id('001', 1) });

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({
      deleted: 0,
      keptDependents: 1,
      heldBy: ['Undated__c'],
    });
  });

  it('keeps every record of an object it cannot describe, with the reason', async () => {
    const { org, plan } = accountWithContacts();
    org.describe = async () => {
      throw new Error('INVALID_TYPE: sObject type is not supported');
    };

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[0]).toMatchObject({
      deleted: 0,
      keptDependents: 2,
      reasons: ['INVALID_TYPE: sObject type is not supported'],
    });
  });

  it('reports what the org refused, per object with its reason, and goes on', async () => {
    const org = new FakeOrg();
    org.add('Case', runRow(id('500', 1)), runRow(id('500', 2)));
    org.add('Account', runRow(id('001', 1)));
    const reason = 'Your attempt to delete this case could not be completed.';
    org.refusals.set(id('500', 1), { statusCode: 'DELETE_FAILED', message: reason });

    const outcome = await removeRunRecords(
      org,
      [
        { objectApiName: 'Case', ids: [id('500', 2), id('500', 1)] },
        { objectApiName: 'Account', ids: [id('001', 1)] },
      ],
      options(),
    );

    expect(outcome.objects[0]).toMatchObject({
      deleted: 1,
      refused: 1,
      reasons: [`DELETE_FAILED: ${reason}`],
    });
    expect(outcome.objects[1]).toMatchObject({ deleted: 1 });
  });

  it('refuses a whole object it cannot read, and goes on with the next', async () => {
    const { org, plan } = accountWithContacts();
    org.failingQueries.push(/^SELECT Id, LastModifiedDate FROM Contact /);
    org.add('Opportunity', runRow(id('006', 1)));

    const outcome = await removeRunRecords(
      org,
      [plan[0], { objectApiName: 'Opportunity', ids: [id('006', 1)] }],
      options(),
    );

    expect(outcome.objects[0]).toMatchObject({
      planned: 2,
      deleted: 0,
      refused: 2,
      reasons: ['INVALID_FIELD: No such column on entity'],
    });
    expect(outcome.objects[1]).toMatchObject({ deleted: 1 });
  });

  it('stops before its next call to the org once cancelled, saying what it did by then', async () => {
    const org = new FakeOrg();
    const contacts = Array.from({ length: 250 }, (_, i) => id('003', i + 1));
    org.add('Contact', ...contacts.map((c) => runRow(c)));
    org.add('Account', runRow(id('001', 1)));
    const stop = new AbortController();

    const outcome = await removeRunRecords(
      org,
      [
        { objectApiName: 'Contact', ids: contacts },
        { objectApiName: 'Account', ids: [id('001', 1)] },
      ],
      options({
        signal: stop.signal,
        onProgress: (settled) => {
          if (settled >= 200) stop.abort();
        },
      }),
    );

    expect(outcome.cancelled).toBe(true);
    expect(org.deletes.map((d) => d.ids.length)).toEqual([200]);
    expect(outcome.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', deleted: 200 }),
    ]);
  });

  describe('a clone whose root the run wrote first', () => {
    const ACCOUNT = id('001', 1);
    const BOOK = id('01s', 1);
    const OPPORTUNITY = id('006', 1);

    /**
     * What a clone of a closed-won opportunity leaves: the opportunity, its
     * account, its contact and its price book. The run wrote the opportunity
     * first and its parents after, so reversed, the plan names it last. The
     * org refuses an account while a closed-won opportunity hangs from it,
     * and a price book while an opportunity is priced from it.
     */
    function closedWonClone(): { org: FakeOrg; plan: ForgeRunObjectRecords[] } {
      const org = new FakeOrg();
      org.add('Account', runRow(ACCOUNT));
      org.add('Pricebook2', runRow(BOOK));
      org.add('Contact', runRow(id('003', 1), { AccountId: ACCOUNT }));
      org.add(
        'Opportunity',
        runRow(OPPORTUNITY, { AccountId: ACCOUNT, Pricebook2Id: BOOK, StageName: 'Closed Won' }),
      );
      org.relationships.set('Account', [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
      ]);
      org.relationships.set('Pricebook2', [
        { childSObject: 'Opportunity', field: 'Pricebook2Id', cascadeDelete: false },
      ]);
      org.refuse = (object, row) => {
        const opportunities = org.rows.get('Opportunity') ?? [];
        if (object === 'Account' && opportunities.some((o) => o.AccountId === row.Id)) {
          return {
            statusCode: 'DELETE_FAILED',
            message: 'some opportunities of this account were closed won',
          };
        }
        if (object === 'Pricebook2' && opportunities.some((o) => o.Pricebook2Id === row.Id)) {
          return {
            statusCode: 'DELETE_FAILED',
            message: 'this price book is associated with the following opportunities',
          };
        }
        return undefined;
      };
      const plan = [
        { objectApiName: 'Contact', ids: [id('003', 1)] },
        { objectApiName: 'Pricebook2', ids: [BOOK] },
        { objectApiName: 'Account', ids: [ACCOUNT] },
        { objectApiName: 'Opportunity', ids: [OPPORTUNITY] },
      ];
      return { org, plan };
    }

    it('removes the root before the account and the price book it points at, in one pass', async () => {
      const { org, plan } = closedWonClone();

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects.map((o) => [o.objectApiName, o.deleted, o.refused])).toEqual([
        ['Contact', 1, 0],
        ['Opportunity', 1, 0],
        ['Pricebook2', 1, 0],
        ['Account', 1, 0],
      ]);
      expect([...org.rows.values()].flat()).toEqual([]);
      // Each record asked for once: nothing was refused on the way.
      expect(org.deletes.map((d) => d.object)).toEqual([
        'Contact',
        'Opportunity',
        'Pricebook2',
        'Account',
      ]);
    });

    it('tries a record refused for what hung from it again once the rest is gone', async () => {
      // An org that cannot say which objects point at the account: the plan's
      // order stands, and the account's turn comes before the opportunity's.
      const { org, plan } = closedWonClone();
      org.relationships.delete('Account');
      org.relationships.delete('Pricebook2');

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects.map((o) => [o.objectApiName, o.deleted, o.refused])).toEqual([
        ['Contact', 1, 0],
        ['Pricebook2', 1, 0],
        ['Account', 1, 0],
        ['Opportunity', 1, 0],
      ]);
      expect(outcome.objects.flatMap((o) => o.reasons)).toEqual([]);
      expect([...org.rows.values()].flat()).toEqual([]);
    });

    it('does not read the stamp its own refused delete left as a change made since the run', async () => {
      const { org, plan } = closedWonClone();
      org.relationships.delete('Account');
      org.relationships.delete('Pricebook2');
      const refuse = org.refuse;
      org.refuse = (object, row) => {
        const refusal = refuse?.(object, row);
        // A refused delete still leaves the record modified at that moment.
        if (refusal) row.LastModifiedDate = AFTER_RUN;
        return refusal;
      };

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects.map((o) => o.keptChanged)).toEqual([0, 0, 0, 0]);
      expect([...org.rows.values()].flat()).toEqual([]);
    });

    it('stops trying once a round deletes nothing more, and says why', async () => {
      const { org, plan } = closedWonClone();
      // Another opportunity, from before the run, hangs from the account.
      org.add('Opportunity', {
        Id: id('006', 9),
        AccountId: ACCOUNT,
        CreatedDate: BEFORE_RUN,
        LastModifiedDate: BEFORE_RUN,
      });
      org.relationships.set('Account', []);

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
        deleted: 0,
        refused: 1,
        reasons: ['DELETE_FAILED: some opportunities of this account were closed won'],
      });
      expect(org.deletes.filter((d) => d.object === 'Account')).toHaveLength(2);
    });
  });

  it('says how many of the run records are settled as it goes', async () => {
    const { org, plan } = accountWithContacts();
    const progress: Array<[number, number, string]> = [];

    await removeRunRecords(
      org,
      plan,
      options({ onProgress: (s, t, o) => progress.push([s, t, o]) }),
    );

    expect(progress.at(-1)).toEqual([3, 3, 'Account']);
    expect(progress.map(([settled]) => settled)).toEqual(
      [...progress.map(([s]) => s)].sort((a, b) => a - b),
    );
  });
});
