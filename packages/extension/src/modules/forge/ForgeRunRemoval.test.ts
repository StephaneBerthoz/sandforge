import { describe, expect, it, vi } from 'vitest';
import type { ForgeRunObjectRecords, ForgeUndoObjectResult } from '@sandforge/shared';

import {
  removeRunRecords,
  setBackToDraftOf,
  takenAlong,
  type RemovalOrg,
  type RunRemovalOptions,
} from './ForgeRunRemoval.js';
import { removalAuditObjects, removalMark, removalStatus } from './removalOutcome.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_STARTED = '2026-09-20T10:00:00.000Z';
const DURING_RUN = '2026-09-20T10:02:00.000+0000';
const RUN_ENDED = '2026-09-20T10:05:00.000Z';
const AFTER_RUN = '2026-09-20T11:00:00.000+0000';
const BEFORE_RUN = '2026-09-19T09:00:00.000+0000';

/** The user the removal runs as, and so writes as. */
const USER = id('005', 1);
/** Someone else working in the org. */
const COLLEAGUE = id('005', 2);

type Row = Record<string, unknown> & { Id: string };
interface Relationship {
  childSObject: string;
  field: string;
  cascadeDelete: boolean;
  /** The org refuses the parent's delete while such a child points at it. */
  restrictedDelete?: boolean;
}

/**
 * An org in memory: rows per object, the relationships each object's describe
 * lists, and a delete that takes what cascades along — as the org does.
 */
class FakeOrg implements RemovalOrg {
  readonly rows = new Map<string, Row[]>();
  readonly relationships = new Map<string, Relationship[]>();
  /** The fields an object's describe lists, where a test needs them. */
  readonly fields = new Map<string, string[]>();
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
  /** An update the org refuses, by what it would write. */
  refuseUpdate?: (
    object: string,
    record: Record<string, unknown>,
  ) => { statusCode: string; message: string } | undefined;
  /** Told of every query before it is answered. */
  onQuery?: (soql: string) => void;
  readonly queries: string[] = [];
  readonly deletes: Array<{ object: string; ids: string[] }> = [];
  /** How far the org's clock runs ahead of this machine's; behind when negative. */
  clockAheadMs = 0;

  /** The org's clock now, as it dates what it writes. */
  now(): string {
    return new Date(Date.now() + this.clockAheadMs).toISOString();
  }

  async serverTime(): Promise<string> {
    return this.now();
  }

  async userId(): Promise<string> {
    return USER;
  }

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
      fields: (this.fields.get(objectApiName) ?? []).map((name) => ({
        name,
        label: name,
        type: 'string',
      })),
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

  readonly updates: Array<{ object: string; records: Array<Record<string, unknown>> }> = [];

  async update(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown> {
    this.updates.push({ object: objectApiName, records: records.map((r) => ({ ...r })) });
    return records.map((record) => {
      const refusal = this.refuseUpdate?.(objectApiName, record);
      if (refusal) return { id: record.Id, success: false, errors: [{ ...refusal, fields: [] }] };
      const row = (this.rows.get(objectApiName) ?? []).find((r) => r.Id === record.Id);
      // Stamped by the org's clock, as written by the user the session runs as.
      if (row) Object.assign(row, record, { LastModifiedDate: this.now(), LastModifiedById: USER });
      return { id: record.Id, success: row !== undefined, errors: [] };
    });
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.queries.push(soql);
    this.onQuery?.(soql);
    if (this.failingQueries.some((pattern) => pattern.test(soql))) {
      throw new Error('INVALID_FIELD: No such column on entity');
    }
    // The statuses of a lifecycle object, each with its category.
    const statuses = /^SELECT ApiName, StatusCode FROM (\w+)$/.exec(soql);
    if (statuses) {
      const records = this.rows.get(statuses[1]) ?? [];
      return { totalSize: records.length, records };
    }
    // The standard prices among some price book entries.
    const standard =
      /^SELECT Id FROM PricebookEntry WHERE Id IN \((.*)\) AND Pricebook2\.IsStandard = true$/.exec(
        soql,
      );
    if (standard) {
      const wanted = new Set(standard[1].split(', ').map((quoted) => quoted.slice(1, -1)));
      const records = (this.rows.get('PricebookEntry') ?? [])
        .filter((row) => wanted.has(row.Id) && row.IsStandardPrice === true)
        .map((row) => ({ Id: row.Id }));
      return { totalSize: records.length, records };
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

  it('names the records that went, deleted or found gone, and none of those it kept', async () => {
    const { org, plan } = accountWithContacts();
    org.add('Contact', runRow(id('003', 3)));
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;
    org.rows.set(
      'Contact',
      (org.rows.get('Contact') ?? []).filter((r) => r.Id !== id('003', 2)),
    );

    const outcome = await removeRunRecords(
      org,
      [{ objectApiName: 'Contact', ids: [...plan[0].ids, id('003', 3)] }, plan[1]],
      options(),
    );

    // 003-2 was gone already, 003-3 deleted; 003-1 changed since, and the
    // account it hangs from, stay.
    expect(outcome.gone).toEqual([id('003', 2), id('003', 3)]);
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
    // feed.
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
    org.columns.set('ContentDocumentLink', [
      'Id',
      'ContentDocumentId',
      'LinkedEntityId',
      'SystemModstamp',
    ]);
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
    org.columns.set('ContentDocumentLink', [
      'Id',
      'ContentDocumentId',
      'LinkedEntityId',
      'SystemModstamp',
    ]);
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
      reasons: [
        'Refused at first, sent again once the rest had gone: 1 refused again.',
        `DELETE_FAILED: ${reason}`,
      ],
    });
    expect(outcome.objects[1]).toMatchObject({ deleted: 1 });
  });

  it('refuses a whole object it cannot read, and goes on with the next', async () => {
    const { org, plan } = accountWithContacts();
    org.failingQueries.push(
      /^SELECT Id, (CreatedDate, )?(LastModifiedDate|SystemModstamp) FROM Contact /,
    );
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

  it('stops before its next delete once cancelled, saying what it did by then', async () => {
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
      expect(outcome.objects.flatMap((o) => [o.objectApiName, ...o.reasons])).toEqual([
        'Contact',
        'Pricebook2',
        'Refused at first, sent again once the rest had gone: 1 deleted.',
        'Account',
        'Refused at first, sent again once the rest had gone: 1 deleted.',
        'Opportunity',
      ]);
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
        reasons: [
          'Refused at first, sent again once the rest had gone: 1 refused again.',
          'DELETE_FAILED: some opportunities of this account were closed won',
        ],
      });
      expect(org.deletes.filter((d) => d.object === 'Account')).toHaveLength(2);
    });
  });

  describe('a second try, once the rest of the plan has gone', () => {
    const CLASSIFICATION = id('11B', 1);
    const BOOK = id('01s', 1);
    const STANDARD_BOOK = id('01s', 9);
    const MODEL = id('0jP', 1);
    const PRODUCTS = [id('01t', 1), id('01t', 2)];
    const OPTIONS = [id('0iO', 1), id('0iO', 2)];
    const CUSTOM = [id('01u', 1), id('01u', 2)];
    const STANDARD = [id('01u', 3), id('01u', 4)];
    /**
     * The reverse of a run that wrote the options after the prices: the
     * options' turn comes first, as no lookup ties them to the prices.
     */
    const PLAN = [
      { objectApiName: 'ProductSellingModelOption', ids: OPTIONS },
      { objectApiName: 'PricebookEntry', ids: [...CUSTOM, ...STANDARD] },
      { objectApiName: 'Pricebook2', ids: [BOOK] },
      { objectApiName: 'Product2', ids: PRODUCTS },
      { objectApiName: 'ProductClassification', ids: [CLASSIFICATION] },
    ];

    /**
     * A catalog a clone wrote, as a sandbox held it: two products based on a
     * classification, each with a selling model option and an active price in
     * the standard book and in a book of the run's. The org refuses what the
     * sandbox refused: an option an active price is sold under, in its words
     * ("Impossible de retirer l'option de modèle de vente de produit …
     * associée à une entrée au catalogue de prix active"); a standard price
     * while a custom price of its product is left; a classification a product
     * is based on.
     */
    function catalogClone(): FakeOrg {
      const org = new FakeOrg();
      org.add('ProductClassification', runRow(CLASSIFICATION));
      org.add('Pricebook2', runRow(BOOK));
      org.add('Product2', ...PRODUCTS.map((p) => runRow(p, { BasedOnId: CLASSIFICATION })));
      org.add(
        'ProductSellingModelOption',
        ...OPTIONS.map((o, i) =>
          runRow(o, { Product2Id: PRODUCTS[i], ProductSellingModelId: MODEL }),
        ),
      );
      const price = (priceId: string, product: string, standard: boolean): Row =>
        runRow(priceId, {
          Product2Id: product,
          Pricebook2Id: standard ? STANDARD_BOOK : BOOK,
          ProductSellingModelId: MODEL,
          IsActive: true,
          IsStandardPrice: standard,
        });
      org.add(
        'PricebookEntry',
        ...CUSTOM.map((p, i) => price(p, PRODUCTS[i], false)),
        ...STANDARD.map((p, i) => price(p, PRODUCTS[i], true)),
      );
      org.relationships.set('ProductClassification', [
        {
          childSObject: 'Product2',
          field: 'BasedOnId',
          cascadeDelete: false,
          restrictedDelete: true,
        },
      ]);
      org.relationships.set('Product2', [
        {
          childSObject: 'PricebookEntry',
          field: 'Product2Id',
          cascadeDelete: true,
          restrictedDelete: true,
        },
        { childSObject: 'ProductSellingModelOption', field: 'Product2Id', cascadeDelete: true },
      ]);
      org.relationships.set('Pricebook2', [
        { childSObject: 'PricebookEntry', field: 'Pricebook2Id', cascadeDelete: true },
      ]);
      org.refuse = (object, row) => {
        const prices = org.rows.get('PricebookEntry') ?? [];
        const sameProduct = (p: Row): boolean =>
          p.Product2Id === row.Product2Id && p.ProductSellingModelId === row.ProductSellingModelId;
        if (
          object === 'ProductSellingModelOption' &&
          prices.some((p) => p.IsActive && sameProduct(p))
        ) {
          return {
            statusCode: 'UNKNOWN_EXCEPTION',
            message:
              "Impossible de retirer l'option de modèle de vente de produit. Cette combinaison " +
              'de produit et de modèle de vente de produit est associée à une entrée au ' +
              'catalogue de prix active.',
          };
        }
        if (
          object === 'PricebookEntry' &&
          row.IsStandardPrice === true &&
          prices.some((p) => p.IsStandardPrice === false && sameProduct(p))
        ) {
          return { statusCode: 'UNKNOWN_EXCEPTION', message: 'An unexpected error occurred.' };
        }
        if (
          object === 'ProductClassification' &&
          (org.rows.get('Product2') ?? []).some((p) => p.BasedOnId === row.Id)
        ) {
          return { statusCode: 'DELETE_FAILED', message: 'products are based on it' };
        }
        return undefined;
      };
      return org;
    }

    it('sends again what the org refused while a record removed after it stood, and takes the catalog in one removal', async () => {
      // Run for real on a sandbox, the options were refused while their
      // prices stood, the prices went next, and the options stayed, with the
      // products kept for them and the classification kept for the products,
      // until a second removal took them.
      const org = catalogClone();

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(
        outcome.objects.map((o) => [o.objectApiName, o.deleted, o.keptDependents, o.refused]),
      ).toEqual([
        ['ProductSellingModelOption', 2, 0, 0],
        ['PricebookEntry', 4, 0, 0],
        ['Pricebook2', 1, 0, 0],
        ['Product2', 2, 0, 0],
        ['ProductClassification', 1, 0, 0],
      ]);
      expect(outcome.objects[0].reasons).toEqual([
        'Refused at first, sent again once the rest had gone: 2 deleted.',
      ]);
      expect([...org.rows.values()].flat()).toEqual([]);
      // Every option asked for twice, and nothing else more than its own call.
      expect(org.deletes.map((d) => [d.object, d.ids.length])).toEqual([
        ['ProductSellingModelOption', 2],
        ['PricebookEntry', 2],
        ['PricebookEntry', 2],
        ['Pricebook2', 1],
        ['ProductSellingModelOption', 2],
        ['Product2', 2],
        ['ProductClassification', 1],
      ]);
      // The run's line, its audit entry and what is left of it say the same.
      expect(outcome.gone).toEqual(PLAN.flatMap((object) => object.ids));
      const finishedAt = '2026-09-20T12:00:00.000Z';
      const status = removalStatus(outcome.objects, outcome.cancelled);
      expect(status).toBe('success');
      expect(removalMark({ status, objects: outcome.objects, finishedAt }, 10)).toEqual({
        removedAt: finishedAt,
        deleted: 10,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      });
      expect(removalAuditObjects(outcome.objects).map((o) => [o.objectApiName, o.failed])).toEqual([
        ['ProductSellingModelOption', 0],
        ['PricebookEntry', 0],
        ['Pricebook2', 0],
        ['Product2', 0],
        ['ProductClassification', 0],
      ]);
    });

    it('sends a record the org refuses for another reason than records hanging from it once more, never a third time', async () => {
      // A round that deleted something is followed by another, for what is
      // refused for records hanging from it: a case a flow refuses is not in it.
      const org = new FakeOrg();
      const CASE = id('500', 1);
      const ACCOUNT = id('001', 1);
      const OPPORTUNITY = id('006', 1);
      org.add('Case', runRow(CASE));
      org.add('Account', runRow(ACCOUNT));
      org.add('Opportunity', runRow(OPPORTUNITY, { AccountId: ACCOUNT }));
      let caseTries = 0;
      org.refuse = (object, row) => {
        if (object === 'Case') {
          caseTries++;
          return {
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
            message: caseTries === 1 ? 'A flow refused it.' : 'A flow refused it again.',
          };
        }
        if (
          object === 'Account' &&
          (org.rows.get('Opportunity') ?? []).some((o) => o.AccountId === row.Id)
        ) {
          return { statusCode: 'DELETE_FAILED', message: 'some opportunities were closed won' };
        }
        return undefined;
      };

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'Case', ids: [CASE] },
          { objectApiName: 'Account', ids: [ACCOUNT] },
          { objectApiName: 'Opportunity', ids: [OPPORTUNITY] },
        ],
        options(),
      );

      expect(org.deletes.filter((d) => d.object === 'Case')).toHaveLength(2);
      expect(outcome.objects).toEqual([
        expect.objectContaining({
          objectApiName: 'Case',
          deleted: 0,
          refused: 1,
          reasons: [
            'Refused at first, sent again once the rest had gone: 1 refused again.',
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: A flow refused it again.',
          ],
        }),
        expect.objectContaining({ objectApiName: 'Account', deleted: 1, refused: 0 }),
        expect.objectContaining({ objectApiName: 'Opportunity', deleted: 1 }),
      ]);
    });

    it('counts a record its second try finds deleted as already gone, not refused', async () => {
      // The org answers ENTITY_IS_DELETED for a record deleted since: here a
      // contact the org deleted with its account through a relationship the
      // removal does not read.
      const org = new FakeOrg();
      const CONTACT = id('003', 1);
      const ACCOUNT = id('001', 1);
      org.add('Contact', runRow(CONTACT, { AccountId: ACCOUNT }));
      org.add('Account', runRow(ACCOUNT));
      org.refusals.set(CONTACT, {
        statusCode: 'UNKNOWN_EXCEPTION',
        message: 'An unexpected error occurred.',
      });
      org.onDelete = (object, row) => {
        if (object !== 'Account') return;
        org.refusals.delete(CONTACT);
        org.rows.set(
          'Contact',
          (org.rows.get('Contact') ?? []).filter((c) => c.AccountId !== row.Id),
        );
      };

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'Contact', ids: [CONTACT] },
          { objectApiName: 'Account', ids: [ACCOUNT] },
        ],
        options(),
      );

      expect(org.deletes.filter((d) => d.object === 'Contact')).toHaveLength(2);
      expect(outcome.objects[0]).toMatchObject({
        deleted: 0,
        alreadyGone: 1,
        refused: 0,
        reasons: ['Refused at first, sent again once the rest had gone: 1 already gone.'],
      });
      expect(outcome.gone).toEqual([CONTACT, ACCOUNT]);
    });

    it('never sends, nor takes for gone, a record of an object it could not read', async () => {
      // Unread when the removal began, the contacts are counted refused with
      // why. Read back by their ids alone once the rest had gone, a query that
      // missed them — out of the session's sight — counted them already gone.
      const org = new FakeOrg();
      const contacts = [id('003', 1), id('003', 2)];
      org.failingQueries.push(
        /^SELECT Id, (CreatedDate, )?(LastModifiedDate|SystemModstamp) FROM Contact /,
      );
      org.add('Account', runRow(id('001', 1)));

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'Contact', ids: contacts },
          { objectApiName: 'Account', ids: [id('001', 1)] },
        ],
        options(),
      );

      expect(outcome.objects[0]).toMatchObject({
        objectApiName: 'Contact',
        alreadyGone: 0,
        refused: 2,
        reasons: ['INVALID_FIELD: No such column on entity'],
      });
      expect(org.deletes.filter((d) => d.object === 'Contact')).toEqual([]);
      expect(outcome.gone).toEqual([id('001', 1)]);
    });

    it('says a refused record it could not read back was not checked, and leaves it refused', async () => {
      const org = new FakeOrg();
      const CASE = id('500', 1);
      org.add('Case', runRow(CASE));
      org.refusals.set(CASE, { statusCode: 'DELETE_FAILED', message: 'A flow refused it.' });
      org.failingQueries.push(/^SELECT Id FROM Case WHERE/);

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'Case', ids: [CASE] }],
        options(),
      );

      expect(outcome.objects[0]).toMatchObject({
        refused: 1,
        alreadyGone: 0,
        reasons: [
          'Not checked: 1 refused record(s) could not be read back once the rest had gone, to ' +
            'tell whether a parent deleted after them took them along — INVALID_FIELD: No such ' +
            'column on entity',
          'Refused at first, sent again once the rest had gone: 1 refused again.',
          'DELETE_FAILED: A flow refused it.',
        ],
      });
      expect(outcome.gone).toEqual([]);
    });
  });

  describe('what a clone with its orders and prices leaves', () => {
    it('reads an object that keeps no modified date by its system stamp', async () => {
      // An email message's relations keep a CreatedDate and a SystemModstamp,
      // and no LastModifiedDate: read by it, the object was refused whole.
      const org = new FakeOrg();
      org.columns.set('EmailMessageRelation', ['Id', 'SystemModstamp', 'CreatedDate']);
      org.add('EmailMessageRelation', {
        Id: id('0ER', 1),
        CreatedDate: DURING_RUN,
        SystemModstamp: DURING_RUN,
      });

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'EmailMessageRelation', ids: [id('0ER', 1)] }],
        options(),
      );

      expect(outcome.objects[0]).toMatchObject({ deleted: 1, refused: 0, reasons: [] });
    });

    it('lets go of what the org records about the removal while it runs', async () => {
      // Deleting an opportunity's line items changes its amount, and feed
      // tracking records the change on the opportunity: a feed item created
      // after the run, which held the opportunity as something added since.
      const org = new FakeOrg();
      const opportunity = id('006', 1);
      org.relationships.set('Opportunity', [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
      ]);
      org.add('Opportunity', runRow(opportunity));
      org.add('OpportunityLineItem', runRow(id('00k', 1), { OpportunityId: opportunity }));
      org.onDelete = (object) => {
        if (object !== 'OpportunityLineItem') return;
        const now = new Date().toISOString();
        org.add('FeedItem', {
          Id: id('0D5', 1),
          ParentId: opportunity,
          CreatedDate: now,
          LastModifiedDate: now,
          CreatedById: USER,
        });
      };

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'OpportunityLineItem', ids: [id('00k', 1)] },
          { objectApiName: 'Opportunity', ids: [opportunity] },
        ],
        options(),
      );

      expect(outcome.objects.map((o) => [o.objectApiName, o.deleted, o.keptDependents])).toEqual([
        ['OpportunityLineItem', 1, 0],
        ['Opportunity', 1, 0],
      ]);
      expect(org.has('Opportunity', opportunity)).toBe(false);
    });

    it('deletes the custom prices of a run before its standard ones, in calls of their own', async () => {
      // Asked for both in one call, the org refuses a standard price while a
      // custom price of its product is still there — UNKNOWN_EXCEPTION.
      const org = new FakeOrg();
      const standard = [1, 2].map((n) => id('01u', n));
      const custom = [3, 4].map((n) => id('01u', n));
      org.add(
        'PricebookEntry',
        ...standard.map((price, n) =>
          runRow(price, { Product2Id: `product${n}`, IsStandardPrice: true }),
        ),
        ...custom.map((price, n) =>
          runRow(price, { Product2Id: `product${n}`, IsStandardPrice: false }),
        ),
      );
      const call: string[] = [];
      org.refuse = (object, row) => {
        if (object !== 'PricebookEntry' || row.IsStandardPrice !== true) return undefined;
        const customLeft = (org.rows.get('PricebookEntry') ?? []).some(
          (price) =>
            price.IsStandardPrice === false &&
            price.Product2Id === row.Product2Id &&
            !call.includes(price.Id),
        );
        return customLeft
          ? { statusCode: 'UNKNOWN_EXCEPTION', message: 'An unexpected error occurred.' }
          : undefined;
      };
      const destroy = org.destroy.bind(org);
      org.destroy = async (object, ids) => {
        call.length = 0;
        return destroy(object, ids);
      };

      // Written standard first, so the plan names the custom ones first.
      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'PricebookEntry', ids: [...custom, ...standard] }],
        options(),
      );

      expect(outcome.objects[0]).toMatchObject({ deleted: 4, refused: 0 });
      expect(org.deletes.map((d) => d.ids)).toEqual([custom, standard]);
    });

    it('returns an activated order to a draft before deleting its items and itself', async () => {
      // An activated order keeps its products and itself from being deleted.
      const org = new FakeOrg();
      const order = id('801', 1);
      org.add('OrderStatus', { Id: 'status-open', ApiName: 'Open', StatusCode: 'Draft' });
      org.add('OrderStatus', { Id: 'status-live', ApiName: 'Live', StatusCode: 'Activated' });
      org.add('Order', runRow(order, { Status: 'Live' }));
      org.add('OrderItem', runRow(id('802', 1), { OrderId: order }));
      org.relationships.set('Order', [
        { childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true },
      ]);
      org.refuse = (object, row) => {
        const orderOf =
          object === 'Order'
            ? row
            : (org.rows.get('Order') ?? []).find((o) => o.Id === row.OrderId);
        return orderOf?.Status === 'Live'
          ? { statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'unable to modify activated order' }
          : undefined;
      };

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'OrderItem', ids: [id('802', 1)] },
          { objectApiName: 'Order', ids: [order] },
        ],
        options(),
      );

      expect(org.updates).toEqual([{ object: 'Order', records: [{ Id: order, Status: 'Open' }] }]);
      expect(outcome.objects.map((o) => [o.objectApiName, o.deleted, o.refused])).toEqual([
        ['OrderItem', 1, 0],
        ['Order', 1, 0],
      ]);
    });

    it('counts as gone, not refused, the relations an email message took along', async () => {
      // The org deletes an email message's relations only with their message.
      const org = new FakeOrg();
      const message = id('02s', 1);
      const relations = [1, 2, 3].map((n) => id('0ER', n));
      org.relationships.set('EmailMessage', [
        { childSObject: 'EmailMessageRelation', field: 'EmailMessageId', cascadeDelete: true },
      ]);
      org.notWorked.add('EmailMessageRelation');
      org.add('EmailMessage', runRow(message));
      org.add(
        'EmailMessageRelation',
        ...relations.map((relation) => runRow(relation, { EmailMessageId: message })),
      );
      org.refuse = (object) =>
        object === 'EmailMessageRelation'
          ? {
              statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
              message: 'can be updated only in a draft state',
            }
          : undefined;

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'EmailMessageRelation', ids: relations },
          { objectApiName: 'EmailMessage', ids: [message] },
        ],
        options(),
      );

      // Sent again once their message has gone, the org answers they are gone.
      expect(outcome.objects).toEqual([
        expect.objectContaining({
          objectApiName: 'EmailMessageRelation',
          deleted: 0,
          alreadyGone: 3,
          refused: 0,
          reasons: ['Refused at first, sent again once the rest had gone: 3 already gone.'],
        }),
        expect.objectContaining({ objectApiName: 'EmailMessage', deleted: 1 }),
      ]);
    });

    it('leaves an activated order it keeps as it was', async () => {
      const org = new FakeOrg();
      const order = id('801', 1);
      org.add('OrderStatus', { Id: 'status-open', ApiName: 'Open', StatusCode: 'Draft' });
      org.add('OrderStatus', { Id: 'status-live', ApiName: 'Live', StatusCode: 'Activated' });
      org.add('Order', { ...runRow(order, { Status: 'Live' }), LastModifiedDate: AFTER_RUN });

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'Order', ids: [order] }],
        options(),
      );

      expect(org.updates).toEqual([]);
      expect(outcome.objects[0]).toMatchObject({ keptChanged: 1, deleted: 0 });
    });
  });

  describe('an activated order the removal sets to Draft, then leaves in the org', () => {
    const ORDER = id('801', 1);
    const ITEM = id('802', 1);
    const PLAN = [
      { objectApiName: 'OrderItem', ids: [ITEM] },
      { objectApiName: 'Order', ids: [ORDER] },
    ];

    /**
     * An activated order and its item, as a clone writes them back: the org
     * refuses to delete either while the order is activated.
     */
    function activatedOrder(): FakeOrg {
      const org = new FakeOrg();
      org.add('OrderStatus', { Id: 'status-open', ApiName: 'Open', StatusCode: 'Draft' });
      org.add('OrderStatus', { Id: 'status-live', ApiName: 'Live', StatusCode: 'Activated' });
      org.add('Order', runRow(ORDER, { Status: 'Live' }));
      org.add('OrderItem', runRow(ITEM, { OrderId: ORDER }));
      org.relationships.set('Order', [
        { childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true },
      ]);
      org.refuse = (object, row) => {
        const orderOf =
          object === 'Order'
            ? row
            : (org.rows.get('Order') ?? []).find((o) => o.Id === row.OrderId);
        return orderOf?.Status === 'Live'
          ? { statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'unable to modify activated order' }
          : undefined;
      };
      return org;
    }

    const statusOf = (org: FakeOrg): unknown =>
      (org.rows.get('Order') ?? []).find((o) => o.Id === ORDER)?.Status;
    const REFUSED = {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'A validation rule refused it.',
    };

    it('gives an order its status back when the org refuses one of its items, which holds it', async () => {
      // Set to Draft before any delete, the order was then held by the item
      // the org refused, and stayed in the org deactivated without a word.
      const org = activatedOrder();
      org.refusals.set(ITEM, REFUSED);

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'OrderItem', deleted: 0, refused: 1 }),
        expect.objectContaining({
          objectApiName: 'Order',
          deleted: 0,
          keptDependents: 1,
          heldBy: ['OrderItem'],
          reasons: ['Status set to Open for the delete, then back to Live.'],
        }),
      ]);
      expect(statusOf(org)).toBe('Live');
    });

    it('gives an order the org refuses to delete its status back', async () => {
      const org = activatedOrder();
      org.refusals.set(ORDER, REFUSED);

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'OrderItem', deleted: 1 }),
        expect.objectContaining({
          objectApiName: 'Order',
          refused: 1,
          reasons: [
            'Status set to Open for the delete, then back to Live.',
            'Refused at first, sent again once the rest had gone: 1 refused again.',
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: A validation rule refused it.',
          ],
        }),
      ]);
      expect(statusOf(org)).toBe('Live');
    });

    it('sets no status once cancelled, even while it reads the statuses', async () => {
      const org = activatedOrder();
      const stop = new AbortController();
      org.onQuery = (soql) => {
        if (soql.includes('FROM OrderStatus')) stop.abort();
      };

      const outcome = await removeRunRecords(org, PLAN, options({ signal: stop.signal }));

      expect(outcome).toMatchObject({ cancelled: true, objects: [] });
      expect(org.updates).toEqual([]);
      expect(statusOf(org)).toBe('Live');
    });

    it("gives back the status it set when it is cancelled before the order's turn", async () => {
      const org = activatedOrder();
      const stop = new AbortController();

      const outcome = await removeRunRecords(
        org,
        PLAN,
        options({
          signal: stop.signal,
          onProgress: (settled) => {
            if (settled >= 1) stop.abort();
          },
        }),
      );

      expect(outcome.cancelled).toBe(true);
      // Back as it was, the order not reached is not named.
      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'OrderItem', deleted: 1 }),
      ]);
      expect(statusOf(org)).toBe('Live');
    });

    it('says an order stays in Draft when the org refuses its status back, reached or not', async () => {
      const org = activatedOrder();
      org.refuseUpdate = (_object, record) => (record.Status === 'Live' ? REFUSED : undefined);
      const stop = new AbortController();

      const outcome = await removeRunRecords(
        org,
        PLAN,
        options({
          signal: stop.signal,
          onProgress: (settled) => {
            if (settled >= 1) stop.abort();
          },
        }),
      );

      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'OrderItem', deleted: 1 }),
        expect.objectContaining({
          objectApiName: 'Order',
          planned: 1,
          deleted: 0,
          reasons: [
            'Status set to Open for the delete, and left there: the org refused Live back — FIELD_CUSTOM_VALIDATION_EXCEPTION: A validation rule refused it.',
          ],
        }),
      ]);
      expect(statusOf(org)).toBe('Open');
    });

    it('does not read what an earlier removal wrote to an order it left as a change since the run', async () => {
      // The first removal set the order to Draft and gave its status back: the
      // order's last stamp is that removal's, not anyone's since the run.
      const org = activatedOrder();
      org.refusals.set(ITEM, REFUSED);
      const first = await removeRunRecords(org, PLAN, options());
      org.refusals.delete(ITEM);

      const second = await removeRunRecords(org, PLAN, options({ removalStamps: first.stamps }));

      expect(first.stamps).toEqual({ [ORDER]: expect.any(String) });
      expect(second.objects.map((o) => [o.objectApiName, o.deleted, o.keptChanged])).toEqual([
        ['OrderItem', 1, 0],
        ['Order', 1, 0],
      ]);
      expect(org.rows.get('Order')).toEqual([]);
    });

    it('names no stamp for an order someone changed since the run, which the request included', async () => {
      const org = activatedOrder();
      (org.rows.get('Order') ?? [])[0].LastModifiedDate = AFTER_RUN;
      org.refusals.set(ITEM, REFUSED);

      const outcome = await removeRunRecords(org, PLAN, options({ includeChanged: true }));

      expect(statusOf(org)).toBe('Live');
      expect(outcome.stamps).toEqual({});
    });
  });

  describe('an activated order the removal keeps, and what the platform locks under it', () => {
    const ACCOUNT = id('001', 1);
    const BOOK = id('01s', 1);
    const STANDARD_BOOK = id('01s', 9);
    const MODEL = id('0jP', 1);
    const KEPT = id('801', 1);
    const DRAFTED = id('801', 2);
    const KEPT_ITEMS = [id('802', 1), id('802', 2)];
    const DRAFTED_ITEM = id('802', 3);
    const KEPT_ACTION = id('0YN', 1);
    const DRAFTED_ACTION = id('0YN', 2);
    const KEPT_PRODUCT = id('01t', 1);
    const DRAFTED_PRODUCT = id('01t', 2);
    const KEPT_STANDARD = id('01u', 1);
    const KEPT_CUSTOM = id('01u', 2);
    const DRAFTED_STANDARD = id('01u', 3);
    const DRAFTED_CUSTOM = id('01u', 4);
    const KEPT_OPTION = id('0iO', 1);
    const DRAFTED_OPTION = id('0iO', 2);
    const PDF = id('069', 1);
    const PDF_TITLE = 'OrderConfirmation-0001.pdf';
    /** In the order a load writes them, reversed. */
    const PLAN = [
      { objectApiName: 'OrderItem', ids: [...KEPT_ITEMS, DRAFTED_ITEM] },
      { objectApiName: 'OrderAction', ids: [KEPT_ACTION, DRAFTED_ACTION] },
      {
        objectApiName: 'PricebookEntry',
        ids: [KEPT_CUSTOM, DRAFTED_CUSTOM, KEPT_STANDARD, DRAFTED_STANDARD],
      },
      { objectApiName: 'Order', ids: [KEPT, DRAFTED] },
      { objectApiName: 'ProductSellingModelOption', ids: [KEPT_OPTION, DRAFTED_OPTION] },
      { objectApiName: 'Product2', ids: [KEPT_PRODUCT, DRAFTED_PRODUCT] },
      { objectApiName: 'Pricebook2', ids: [BOOK] },
      { objectApiName: 'Account', ids: [ACCOUNT] },
    ];
    const refusal = (statusCode: string, message: string) => ({ statusCode, message });

    /**
     * A load's two activated orders, as a client sandbox held them: on the
     * activation of one, the org generated a confirmation PDF and linked it to
     * the order after the load's last write. Each order has an action and
     * items; each item is priced from a custom price of its product, which
     * needs the product's standard price, and both sell under the product's
     * selling model option. The org refuses what a real one refused: an
     * activated order, and its items and action; a price an item uses; a
     * standard price while a custom price of its product under its selling
     * model is left; an option an active price sells under; a product an item
     * names.
     */
    function activatedOrders(): FakeOrg {
      const org = new FakeOrg();
      org.add('OrderStatus', { Id: 'status-open', ApiName: 'Open', StatusCode: 'Draft' });
      org.add('OrderStatus', { Id: 'status-live', ApiName: 'Live', StatusCode: 'Activated' });
      org.add('Account', runRow(ACCOUNT));
      org.add('Pricebook2', runRow(BOOK));
      org.add('Product2', runRow(KEPT_PRODUCT), runRow(DRAFTED_PRODUCT));
      const price = (priceId: string, product: string, standard: boolean): Row =>
        runRow(priceId, {
          Product2Id: product,
          Pricebook2Id: standard ? STANDARD_BOOK : BOOK,
          ProductSellingModelId: MODEL,
          IsActive: true,
          IsStandardPrice: standard,
        });
      org.add(
        'PricebookEntry',
        price(KEPT_STANDARD, KEPT_PRODUCT, true),
        price(KEPT_CUSTOM, KEPT_PRODUCT, false),
        price(DRAFTED_STANDARD, DRAFTED_PRODUCT, true),
        price(DRAFTED_CUSTOM, DRAFTED_PRODUCT, false),
      );
      org.add(
        'ProductSellingModelOption',
        runRow(KEPT_OPTION, { Product2Id: KEPT_PRODUCT, ProductSellingModelId: MODEL }),
        runRow(DRAFTED_OPTION, { Product2Id: DRAFTED_PRODUCT, ProductSellingModelId: MODEL }),
      );
      org.add(
        'Order',
        runRow(KEPT, { AccountId: ACCOUNT, Status: 'Live' }),
        runRow(DRAFTED, { AccountId: ACCOUNT, Status: 'Live' }),
      );
      org.add(
        'OrderAction',
        runRow(KEPT_ACTION, { OrderId: KEPT }),
        runRow(DRAFTED_ACTION, { OrderId: DRAFTED }),
      );
      org.add(
        'OrderItem',
        ...KEPT_ITEMS.map((item) =>
          runRow(item, { OrderId: KEPT, PricebookEntryId: KEPT_CUSTOM, Product2Id: KEPT_PRODUCT }),
        ),
        runRow(DRAFTED_ITEM, {
          OrderId: DRAFTED,
          PricebookEntryId: DRAFTED_CUSTOM,
          Product2Id: DRAFTED_PRODUCT,
        }),
      );
      org.add('ContentDocument', {
        Id: PDF,
        Title: PDF_TITLE,
        CreatedDate: AFTER_RUN,
        LastModifiedDate: AFTER_RUN,
      });
      org.columns.set('ContentDocumentLink', [
        'Id',
        'ContentDocumentId',
        'LinkedEntityId',
        'SystemModstamp',
      ]);
      org.add(
        'ContentDocumentLink',
        {
          Id: id('06A', 1),
          ContentDocumentId: PDF,
          LinkedEntityId: KEPT,
          SystemModstamp: AFTER_RUN,
        },
        {
          Id: id('06A', 2),
          ContentDocumentId: PDF,
          LinkedEntityId: COLLEAGUE,
          SystemModstamp: AFTER_RUN,
        },
      );
      org.relationships.set('Account', [
        { childSObject: 'Order', field: 'AccountId', cascadeDelete: true },
      ]);
      org.relationships.set('Order', [
        { childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true },
        { childSObject: 'OrderAction', field: 'OrderId', cascadeDelete: true },
        { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
      ]);
      org.relationships.set('PricebookEntry', [
        {
          childSObject: 'OrderItem',
          field: 'PricebookEntryId',
          cascadeDelete: false,
          restrictedDelete: true,
        },
      ]);
      org.relationships.set('Product2', [
        {
          childSObject: 'PricebookEntry',
          field: 'Product2Id',
          cascadeDelete: true,
          restrictedDelete: true,
        },
        { childSObject: 'ProductSellingModelOption', field: 'Product2Id', cascadeDelete: true },
        {
          childSObject: 'OrderItem',
          field: 'Product2Id',
          cascadeDelete: false,
          restrictedDelete: true,
        },
      ]);
      org.relationships.set('Pricebook2', [
        { childSObject: 'PricebookEntry', field: 'Pricebook2Id', cascadeDelete: true },
      ]);
      org.refuse = (object, row) => {
        const live = (orderId: unknown): boolean =>
          (org.rows.get('Order') ?? []).some((o) => o.Id === orderId && o.Status === 'Live');
        const items = org.rows.get('OrderItem') ?? [];
        const prices = org.rows.get('PricebookEntry') ?? [];
        if (object === 'Order' && row.Status === 'Live') {
          return refusal('DELETE_FAILED', 'cannot delete an activated order');
        }
        if (object === 'OrderItem' && live(row.OrderId)) {
          return refusal('DELETE_FAILED', 'unable to modify activated or superseded order');
        }
        if (object === 'OrderAction' && live(row.OrderId)) {
          return refusal('ENTITY_IS_LOCKED', 'not on an activated or superseded order');
        }
        if (object === 'PricebookEntry' && items.some((i) => i.PricebookEntryId === row.Id)) {
          return refusal('DELETE_FAILED', 'the products will not be removed from these orders');
        }
        const customLeft = prices.some(
          (p) =>
            p.IsStandardPrice === false &&
            p.Product2Id === row.Product2Id &&
            p.ProductSellingModelId === row.ProductSellingModelId,
        );
        if (object === 'PricebookEntry' && row.IsStandardPrice === true && customLeft) {
          return refusal('UNKNOWN_EXCEPTION', 'An unexpected error occurred.');
        }
        const sold = prices.some(
          (p) =>
            p.IsActive === true &&
            p.Product2Id === row.Product2Id &&
            p.ProductSellingModelId === row.ProductSellingModelId,
        );
        if (object === 'ProductSellingModelOption' && sold) {
          return refusal('UNKNOWN_EXCEPTION', 'associated with an active price book entry');
        }
        if (object === 'Product2' && items.some((i) => i.Product2Id === row.Id)) {
          return refusal('DELETE_FAILED', 'this product is on order products');
        }
        return undefined;
      };
      return org;
    }

    const byObject = (outcome: { objects: ForgeUndoObjectResult[] }): unknown[] =>
      outcome.objects.map((o) => [
        o.objectApiName,
        o.deleted,
        o.keptDependents,
        o.refused,
        o.heldBy,
      ]);
    const statusOf = (org: FakeOrg): unknown =>
      (org.rows.get('Order') ?? []).find((o) => o.Id === KEPT)?.Status;

    it('keeps with an order it keeps activated the items and action the platform locks under it, for the order', async () => {
      const org = activatedOrders();

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(outcome.objects.slice(0, 2)).toEqual([
        expect.objectContaining({
          objectApiName: 'OrderItem',
          deleted: 1,
          keptDependents: 2,
          refused: 0,
          heldBy: ['Order'],
          reasons: [],
        }),
        expect.objectContaining({
          objectApiName: 'OrderAction',
          deleted: 1,
          keptDependents: 1,
          refused: 0,
          heldBy: ['Order'],
          reasons: [],
        }),
      ]);
      // Held by the file the org attached to it, not by what it locks itself.
      expect(outcome.objects.find((o) => o.objectApiName === 'Order')).toMatchObject({
        deleted: 1,
        keptDependents: 1,
        heldBy: ['ContentDocumentLink'],
      });
      const sent = org.deletes.flatMap((d) => d.ids);
      for (const locked of [...KEPT_ITEMS, KEPT_ACTION]) expect(sent).not.toContain(locked);
      expect(statusOf(org)).toBe('Live');
    });

    it('keeps what those hold in turn — their price, its standard price, their option — sending no delete the org refuses', async () => {
      const org = activatedOrders();

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(byObject(outcome)).toEqual([
        ['OrderItem', 1, 2, 0, ['Order']],
        ['OrderAction', 1, 1, 0, ['Order']],
        ['PricebookEntry', 2, 2, 0, ['OrderItem', 'PricebookEntry']],
        ['Order', 1, 1, 0, ['ContentDocumentLink']],
        ['ProductSellingModelOption', 1, 1, 0, ['PricebookEntry']],
        ['Product2', 1, 1, 0, ['PricebookEntry', 'ProductSellingModelOption', 'OrderItem']],
        ['Pricebook2', 0, 1, 0, ['PricebookEntry']],
        ['Account', 0, 1, 0, ['Order']],
      ]);
      expect(outcome.objects.flatMap((o) => o.reasons)).toEqual([]);
      expect(org.deletes.flatMap((d) => d.ids).sort()).toEqual(
        [
          DRAFTED_ITEM,
          DRAFTED_ACTION,
          DRAFTED_CUSTOM,
          DRAFTED_STANDARD,
          DRAFTED,
          DRAFTED_OPTION,
          DRAFTED_PRODUCT,
        ].sort(),
      );
    });

    it.each<[string, (org: FakeOrg) => void, Partial<ForgeUndoObjectResult>]>([
      [
        'kept for a file the org attached since the run',
        () => undefined,
        { keptDependents: 1, heldBy: ['ContentDocumentLink'] },
      ],
      [
        'changed since the run',
        (org) => {
          const order = (org.rows.get('Order') ?? []).find((o) => o.Id === KEPT);
          if (order) order.LastModifiedDate = AFTER_RUN;
          org.rows.set(
            'ContentDocumentLink',
            (org.rows.get('ContentDocumentLink') ?? []).filter((l) => l.LinkedEntityId !== KEPT),
          );
        },
        { keptChanged: 1 },
      ],
    ])('keeps the items of an activated order it keeps: %s', async (_why, arrange, orderLine) => {
      const org = activatedOrders();
      arrange(org);

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(outcome.objects.find((o) => o.objectApiName === 'OrderItem')).toMatchObject({
        keptDependents: 2,
        refused: 0,
        heldBy: ['Order'],
      });
      expect(outcome.objects.find((o) => o.objectApiName === 'Order')).toMatchObject(orderLine);
      const sent = org.deletes.flatMap((d) => d.ids);
      for (const item of KEPT_ITEMS) expect(sent).not.toContain(item);
    });

    it('keeps an item the run added to an activated order it did not create', async () => {
      const org = activatedOrders();

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'OrderItem', ids: KEPT_ITEMS }],
        options(),
      );

      expect(outcome.objects).toEqual([
        expect.objectContaining({ keptDependents: 2, refused: 0, heldBy: ['Order'] }),
      ]);
      expect(org.deletes).toEqual([]);
    });

    it('lets the items of an order it set to Draft go', async () => {
      const org = activatedOrders();

      await removeRunRecords(org, PLAN, options());

      expect(org.has('OrderItem', DRAFTED_ITEM)).toBe(false);
      expect(org.has('OrderAction', DRAFTED_ACTION)).toBe(false);
    });

    it('names the file the org attached to an order it deletes, and leaves it in the org', async () => {
      // With the records changed since the run, what was added to them since
      // goes too: the order goes, and its link to the PDF with it.
      const org = activatedOrders();

      const outcome = await removeRunRecords(org, PLAN, options({ includeChanged: true }));

      expect(outcome.objects.find((o) => o.objectApiName === 'Order')).toMatchObject({
        deleted: 2,
        filesLeft: { count: 1, names: [PDF_TITLE] },
      });
      expect(
        outcome.objects.filter((o) => o.filesLeft !== undefined).map((o) => o.objectApiName),
      ).toEqual(['Order']);
      expect(PLAN.flatMap((p) => org.rows.get(p.objectApiName) ?? [])).toEqual([]);
      expect(org.has('ContentDocument', PDF)).toBe(true);
      expect(org.deletes.map((d) => d.object)).not.toContain('ContentDocument');
    });

    it('names a file by its id when its title cannot be read', async () => {
      const org = activatedOrders();
      org.failingQueries.push(/FROM ContentDocument WHERE/);

      const outcome = await removeRunRecords(org, PLAN, options({ includeChanged: true }));

      expect(outcome.objects.find((o) => o.objectApiName === 'Order')?.filesLeft).toEqual({
        count: 1,
        names: [PDF],
      });
    });

    it('names no file of an order it keeps: the file stays attached to it', async () => {
      const org = activatedOrders();

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(outcome.objects.some((o) => o.filesLeft !== undefined)).toBe(false);
    });
  });

  describe('an activated contract, and the item prices the platform locks under it', () => {
    const CONTRACT = id('800', 1);
    const PRICES = [id('1Au', 1), id('1Au', 2)];

    /**
     * A contract activated in the target and item prices under it, as a real
     * sandbox answered: it refuses to delete an item price while its contract
     * is activated, and to set the contract back to Draft; it deletes the
     * activated contract, and its item prices with it.
     */
    function activatedContract(contract: Row): FakeOrg {
      const org = new FakeOrg();
      org.add('ContractStatus', { Id: 'status-draft', ApiName: 'Draft', StatusCode: 'Draft' });
      org.add('ContractStatus', {
        Id: 'status-activated',
        ApiName: 'Activated',
        StatusCode: 'Activated',
      });
      org.add('Contract', contract);
      org.add(
        'ContractItemPrice',
        ...PRICES.map((price) => runRow(price, { ContractId: CONTRACT })),
      );
      org.relationships.set('Contract', [
        { childSObject: 'ContractItemPrice', field: 'ContractId', cascadeDelete: true },
      ]);
      org.refuse = (object, row) => {
        const activated = (org.rows.get('Contract') ?? []).some(
          (c) => c.Id === row.ContractId && c.Status === 'Activated',
        );
        return object === 'ContractItemPrice' && activated
          ? {
              statusCode: 'INVALID_INPUT',
              message: 'cannot delete a contract item price in an active contract',
            }
          : undefined;
      };
      org.refuseUpdate = (object, record) =>
        object === 'Contract' && record.Status === 'Draft'
          ? { statusCode: 'FAILED_ACTIVATION', message: 'Choose a valid contract status.' }
          : undefined;
      return org;
    }

    it('keeps the item prices the run added to an activated contract it did not create, for the contract', async () => {
      const org = activatedContract({
        Id: CONTRACT,
        CreatedDate: BEFORE_RUN,
        LastModifiedDate: BEFORE_RUN,
        Status: 'Activated',
      });

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'ContractItemPrice', ids: PRICES }],
        options(),
      );

      expect(outcome.objects).toEqual([
        expect.objectContaining({
          objectApiName: 'ContractItemPrice',
          deleted: 0,
          keptDependents: 2,
          refused: 0,
          heldBy: ['Contract'],
          reasons: [],
        }),
      ]);
      expect(org.deletes).toEqual([]);
    });

    it("lets the item prices go with an activated contract of the run's, which the org will not set back to Draft", async () => {
      const org = activatedContract(runRow(CONTRACT, { Status: 'Activated' }));

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'ContractItemPrice', ids: PRICES },
          { objectApiName: 'Contract', ids: [CONTRACT] },
        ],
        options(),
      );

      expect(outcome.objects).toEqual([
        expect.objectContaining({
          objectApiName: 'ContractItemPrice',
          deleted: 0,
          alreadyGone: 2,
          keptDependents: 0,
          refused: 0,
        }),
        expect.objectContaining({ objectApiName: 'Contract', deleted: 1, refused: 0 }),
      ]);
      // Sent first and refused, the item prices held their contract, and the
      // removal left both. Held for the contract, they no longer hold it: it
      // goes first, and takes them along.
      expect(org.deletes[0]).toEqual({ object: 'Contract', ids: [CONTRACT] });
      expect(org.rows.get('ContractItemPrice')).toEqual([]);
    });

    it("deletes an activated contract of the run's as it stands, sending no Draft update the org would refuse", async () => {
      const org = activatedContract(runRow(CONTRACT, { Status: 'Activated' }));

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'ContractItemPrice', ids: PRICES },
          { objectApiName: 'Contract', ids: [CONTRACT] },
        ],
        options(),
      );

      expect(org.updates).toEqual([]);
      expect(outcome.objects.find((o) => o.objectApiName === 'Contract')).toMatchObject({
        deleted: 1,
        reasons: [],
      });
    });

    it('says nothing of a status to give back to an activated contract that stays: it never lost one', async () => {
      // Its delete refused, the contract stays; set to Draft first, its status
      // was then read back to be restored, and a read that failed was said to
      // have left it at Draft.
      const org = activatedContract(runRow(CONTRACT, { Status: 'Activated' }));
      org.rows.set('ContractItemPrice', []);
      org.refusals.set(CONTRACT, { statusCode: 'DELETE_FAILED', message: 'A flow refused it.' });
      let statusReads = 0;
      org.onQuery = (soql) => {
        if (soql.startsWith('SELECT Id, Status FROM Contract ') && ++statusReads > 1) {
          org.failingQueries.push(/^SELECT Id, Status FROM Contract /);
        }
      };

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'Contract', ids: [CONTRACT] }],
        options(),
      );

      expect(outcome.objects).toEqual([
        expect.objectContaining({
          objectApiName: 'Contract',
          deleted: 0,
          refused: 1,
          reasons: [
            'Refused at first, sent again once the rest had gone: 1 refused again.',
            'DELETE_FAILED: A flow refused it.',
          ],
        }),
      ]);
      expect(org.updates).toEqual([]);
      expect(org.rows.get('Contract')?.[0]?.Status).toBe('Activated');
    });
  });

  describe('a record that would have the org refuse the delete of the one it points at', () => {
    const PRICE = id('01u', 1);
    const LINE_ITEM = id('00k', 9);

    /**
     * A price of the run's, and a line item someone else priced from it while
     * the run went: the org takes no line item along with its price, it
     * refuses the price's delete.
     */
    function pricedFrom(): FakeOrg {
      const org = new FakeOrg();
      org.add(
        'PricebookEntry',
        runRow(PRICE, { Product2Id: id('01t', 1), IsStandardPrice: false }),
      );
      org.add('OpportunityLineItem', {
        Id: LINE_ITEM,
        PricebookEntryId: PRICE,
        CreatedDate: DURING_RUN,
        LastModifiedDate: DURING_RUN,
        CreatedById: COLLEAGUE,
      });
      org.relationships.set('PricebookEntry', [
        {
          childSObject: 'OpportunityLineItem',
          field: 'PricebookEntryId',
          cascadeDelete: false,
          restrictedDelete: true,
        },
      ]);
      org.refuse = (object, row) =>
        object === 'PricebookEntry' &&
        (org.rows.get('OpportunityLineItem') ?? []).some((i) => i.PricebookEntryId === row.Id)
          ? { statusCode: 'DELETE_FAILED', message: 'this price is used by opportunity products' }
          : undefined;
      return org;
    }

    it('keeps a price another record is priced from, whenever that record came, and sends no delete', async () => {
      const org = pricedFrom();

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'PricebookEntry', ids: [PRICE] }],
        options({ includeChanged: true }),
      );

      expect(outcome.objects[0]).toMatchObject({
        deleted: 0,
        keptDependents: 1,
        refused: 0,
        heldBy: ['OpportunityLineItem'],
        reasons: [],
      });
      expect(org.deletes).toEqual([]);
    });

    it('names no such relationship as not checked when it cannot read it: the org says what it holds', async () => {
      const org = pricedFrom();
      org.failingQueries.push(/FROM OpportunityLineItem WHERE/);

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'PricebookEntry', ids: [PRICE] }],
        options(),
      );

      expect(outcome.objects[0]).toMatchObject({
        refused: 1,
        unchecked: [],
        reasons: [
          'Refused at first, sent again once the rest had gone: 1 refused again.',
          'DELETE_FAILED: this price is used by opportunity products',
        ],
      });
    });
  });

  it('keeps a standard price only for a custom price that stays under its own selling model', async () => {
    // Where the org sells by selling models, a custom price needs the
    // standard price of its product under its own model.
    const org = new FakeOrg();
    const product = id('01t', 1);
    const [oneTime, term] = [id('0jP', 1), id('0jP', 2)];
    const custom = id('01u', 1);
    const [standardOneTime, standardTerm] = [id('01u', 2), id('01u', 3)];
    org.fields.set('PricebookEntry', ['Id', 'Product2Id', 'ProductSellingModelId']);
    org.add(
      'PricebookEntry',
      // Changed since the run: kept.
      runRow(custom, {
        Product2Id: product,
        ProductSellingModelId: oneTime,
        IsStandardPrice: false,
        LastModifiedDate: AFTER_RUN,
      }),
      runRow(standardOneTime, {
        Product2Id: product,
        ProductSellingModelId: oneTime,
        IsStandardPrice: true,
      }),
      runRow(standardTerm, {
        Product2Id: product,
        ProductSellingModelId: term,
        IsStandardPrice: true,
      }),
    );
    org.refuse = (object, row) =>
      object === 'PricebookEntry' &&
      row.IsStandardPrice === true &&
      (org.rows.get('PricebookEntry') ?? []).some(
        (p) =>
          p.IsStandardPrice === false &&
          p.Product2Id === row.Product2Id &&
          p.ProductSellingModelId === row.ProductSellingModelId,
      )
        ? { statusCode: 'UNKNOWN_EXCEPTION', message: 'An unexpected error occurred.' }
        : undefined;

    const outcome = await removeRunRecords(
      org,
      [{ objectApiName: 'PricebookEntry', ids: [custom, standardOneTime, standardTerm] }],
      options(),
    );

    expect(outcome.objects[0]).toMatchObject({
      deleted: 1,
      keptChanged: 1,
      keptDependents: 1,
      refused: 0,
      heldBy: ['PricebookEntry'],
    });
    expect(org.deletes.flatMap((d) => d.ids)).toEqual([standardTerm]);
  });

  describe('a record the org restamps as the removal deletes, and the removal leaves', () => {
    const ACCOUNT = id('001', 1);
    const BOOK = id('01s', 1);
    const OPPORTUNITY = id('006', 1);
    const LINE_ITEMS = [id('00k', 1), id('00k', 2)];
    const PLAN = [
      { objectApiName: 'OpportunityLineItem', ids: LINE_ITEMS },
      { objectApiName: 'Opportunity', ids: [OPPORTUNITY] },
      { objectApiName: 'Pricebook2', ids: [BOOK] },
      { objectApiName: 'Account', ids: [ACCOUNT] },
    ];

    /**
     * A cloned opportunity with its line items, its account and its price
     * book, written by the user the removal runs as. Deleting a line item
     * changes the opportunity's amount: the org dates the opportunity then,
     * as modified by the user who deleted the item, and feed tracking records
     * the change on it, as created by that user — as a sandbox did. It
     * refuses the price book while an opportunity is priced from it.
     */
    function opportunityWithLineItems(): FakeOrg {
      const org = new FakeOrg();
      const written = (recordId: string, fields: Record<string, unknown> = {}): Row =>
        runRow(recordId, { ...fields, LastModifiedById: USER });
      org.add('Account', written(ACCOUNT));
      org.add('Pricebook2', written(BOOK));
      org.add('Opportunity', written(OPPORTUNITY, { AccountId: ACCOUNT, Pricebook2Id: BOOK }));
      org.add(
        'OpportunityLineItem',
        ...LINE_ITEMS.map((item) => written(item, { OpportunityId: OPPORTUNITY })),
      );
      org.relationships.set('Opportunity', [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
      ]);
      org.relationships.set('Account', [
        { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
      ]);
      org.relationships.set('Pricebook2', [
        { childSObject: 'Opportunity', field: 'Pricebook2Id', cascadeDelete: false },
      ]);
      org.refuse = (object, row) =>
        object === 'Pricebook2' &&
        (org.rows.get('Opportunity') ?? []).some((o) => o.Pricebook2Id === row.Id)
          ? {
              statusCode: 'DELETE_FAILED',
              message: 'this price book is associated with the following opportunities',
            }
          : undefined;
      org.onDelete = (object, row) => {
        const opportunity = (org.rows.get('Opportunity') ?? []).find(
          (o) => o.Id === row.OpportunityId,
        );
        if (object !== 'OpportunityLineItem' || !opportunity) return;
        const now = org.now();
        Object.assign(opportunity, { LastModifiedDate: now, LastModifiedById: USER });
        org.add('FeedItem', {
          Id: id('0D5', (org.rows.get('FeedItem') ?? []).length + 1),
          ParentId: opportunity.Id,
          CreatedDate: now,
          LastModifiedDate: now,
          CreatedById: USER,
        });
      };
      return org;
    }

    /** Stops the removal once the line items are deleted, before the opportunity's turn. */
    function cancelledAfterLineItems(): Partial<RunRemovalOptions> {
      const stop = new AbortController();
      return {
        signal: stop.signal,
        onProgress: (settled, _total, objectApiName) => {
          if (objectApiName === 'OpportunityLineItem' && settled === LINE_ITEMS.length) {
            stop.abort();
          }
        },
      };
    }

    const counts = (outcome: { objects: ForgeUndoObjectResult[] }): unknown[] =>
      outcome.objects.map((o) => [
        o.objectApiName,
        o.deleted,
        o.alreadyGone,
        o.keptChanged,
        o.keptDependents,
        o.refused,
      ]);

    it('names the stamp its line items left on the opportunity when cancelled, and when it ran: the next removal takes the opportunity', async () => {
      // The next removal comes a minute later: what the org wrote in answer
      // to the first cannot pass for the next one's own doing.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const org = opportunityWithLineItems();
        const started = Math.floor(Date.now() / 1000) * 1000;

        const first = await removeRunRecords(org, PLAN, options(cancelledAfterLineItems()));
        const restamped = String((org.rows.get('Opportunity') ?? [])[0].LastModifiedDate);
        vi.setSystemTime(Date.now() + 60_000);
        const second = await removeRunRecords(
          org,
          PLAN,
          options({
            removalStamps: first.stamps,
            removalSpans: first.span ? [first.span] : [],
          }),
        );

        expect(first.cancelled).toBe(true);
        expect(counts(first)).toEqual([['OpportunityLineItem', 2, 0, 0, 0, 0]]);
        // Modified after the run ended, by the removal's doing.
        expect(Date.parse(restamped)).toBeGreaterThan(Date.parse(RUN_ENDED));
        expect(first.stamps).toEqual({ [OPPORTUNITY]: restamped });
        expect(first.span).toEqual({
          first: new Date(started).toISOString(),
          last: expect.any(String),
          userId: USER.slice(0, 15),
        });
        expect(Date.parse(first.span?.last ?? '')).toBeGreaterThan(Date.parse(restamped));
        // The tracked changes the first removal made the org write go with the opportunity.
        expect(counts(second)).toEqual([
          ['OpportunityLineItem', 0, 2, 0, 0, 0],
          ['Opportunity', 1, 0, 0, 0, 0],
          ['Pricebook2', 1, 0, 0, 0, 0],
          ['Account', 1, 0, 0, 0, 0],
        ]);
        expect([...org.rows.values()].flat()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['by its user while it ran', USER, '2026-09-20T12:00:30.000Z', 1],
      ['by someone else while it ran', COLLEAGUE, '2026-09-20T12:00:30.000Z', 0],
      ['by its user once it was over', USER, '2026-09-20T12:05:00.000Z', 0],
      ['by its user before it started', USER, '2026-09-20T11:30:00.000Z', 0],
    ])(
      "takes a task created since the run for an earlier removal's doing only when created by its user while it ran: %s",
      async (_when, creator, createdAt, deleted) => {
        const { org, plan } = accountWithContacts();
        org.add('Task', {
          Id: id('00T', 1),
          WhatId: ACCOUNT,
          CreatedDate: createdAt,
          LastModifiedDate: createdAt,
          CreatedById: creator,
        });

        const outcome = await removeRunRecords(
          org,
          plan,
          options({
            removalSpans: [
              {
                first: '2026-09-20T12:00:00.000Z',
                last: '2026-09-20T12:01:00.000Z',
                userId: USER,
              },
            ],
          }),
        );

        expect(outcome.objects[1]).toMatchObject({
          objectApiName: 'Account',
          deleted,
          keptDependents: 1 - deleted,
        });
      },
    );

    it('names no stamp for a record someone else modified last, which the next removal keeps as changed', async () => {
      // A colleague edits the opportunity once its line items are gone.
      const org = opportunityWithLineItems();
      const rollUp = org.onDelete;
      org.onDelete = (object, row) => {
        rollUp?.(object, row);
        const opportunity = (org.rows.get('Opportunity') ?? [])[0];
        if (object === 'OpportunityLineItem' && opportunity) {
          Object.assign(opportunity, { LastModifiedDate: org.now(), LastModifiedById: COLLEAGUE });
        }
      };

      const first = await removeRunRecords(org, PLAN, options(cancelledAfterLineItems()));
      const second = await removeRunRecords(
        org,
        PLAN,
        options({
          removalStamps: first.stamps,
          removalSpans: first.span ? [first.span] : [],
        }),
      );

      expect(first.stamps).toEqual({});
      expect(counts(second)).toEqual([
        ['OpportunityLineItem', 0, 2, 0, 0, 0],
        ['Opportunity', 0, 0, 1, 0, 0],
        ['Pricebook2', 0, 0, 0, 0, 1],
        ['Account', 0, 0, 0, 1, 0],
      ]);
      expect(second.stamps).toEqual({});
      expect(org.has('Opportunity', OPPORTUNITY)).toBe(true);
    });

    it('names, as it ends, the stamp its deletes left on a record it keeps, which a later removal takes once nothing holds it', async () => {
      // A task logged on the account since the run holds it; deleting the
      // account's contacts restamps it, a roll-up counting them.
      const { org, plan } = accountWithContacts();
      org.add('Task', {
        Id: id('00T', 1),
        WhatId: ACCOUNT,
        CreatedDate: AFTER_RUN,
        LastModifiedDate: AFTER_RUN,
        CreatedById: COLLEAGUE,
      });
      org.onDelete = (object, row) => {
        const account = (org.rows.get('Account') ?? []).find((a) => a.Id === row.AccountId);
        if (object === 'Contact' && account) {
          Object.assign(account, { LastModifiedDate: org.now(), LastModifiedById: USER });
        }
      };

      const first = await removeRunRecords(org, plan, options());
      // The colleague deletes the task.
      org.rows.set('Task', []);
      const second = await removeRunRecords(org, plan, options({ removalStamps: first.stamps }));

      expect(first.objects[1]).toMatchObject({ keptDependents: 1, heldBy: ['Task'] });
      expect(first.stamps).toEqual({ [ACCOUNT]: expect.any(String) });
      expect(second.objects[1]).toMatchObject({ deleted: 1, keptChanged: 0 });
      expect(org.has('Account', ACCOUNT)).toBe(false);
    });

    it('leaves unstamped the records it cannot read back', async () => {
      const org = opportunityWithLineItems();
      org.failingQueries.push(/^SELECT Id, LastModifiedDate, LastModifiedById FROM Opportunity /);

      const outcome = await removeRunRecords(org, PLAN, options(cancelledAfterLineItems()));

      expect(outcome.cancelled).toBe(true);
      expect(counts(outcome)).toEqual([['OpportunityLineItem', 2, 0, 0, 0, 0]]);
      expect(outcome.stamps).toEqual({});
    });

    it('reads nothing back when it is cancelled before it wrote', async () => {
      const org = opportunityWithLineItems();
      const stop = new AbortController();

      const outcome = await removeRunRecords(
        org,
        PLAN,
        options({ signal: stop.signal, onProgress: () => stop.abort() }),
      );

      expect(outcome).toMatchObject({ cancelled: true, stamps: {} });
      expect(outcome.span).toBeUndefined();
      expect(org.deletes).toEqual([]);
      expect(org.queries.filter((q) => q.includes('LastModifiedById'))).toEqual([]);
    });

    it('reads nothing back once every record of the run went', async () => {
      const org = opportunityWithLineItems();

      const outcome = await removeRunRecords(org, PLAN, options());

      expect(outcome.stamps).toEqual({});
      expect([...org.rows.values()].flat()).toEqual([]);
      expect(org.queries.filter((q) => q.includes('LastModifiedById'))).toEqual([]);
    });

    it('reads back no object that keeps no modified date, and so no one who modified it', async () => {
      // An email message's relations keep a system stamp alone, and the org
      // deletes them only with their message: refused, then taken along.
      const org = new FakeOrg();
      const message = id('02s', 1);
      const relations = [1, 2].map((n) => id('0ER', n));
      org.columns.set('EmailMessageRelation', [
        'Id',
        'EmailMessageId',
        'CreatedDate',
        'SystemModstamp',
      ]);
      org.relationships.set('EmailMessage', [
        { childSObject: 'EmailMessageRelation', field: 'EmailMessageId', cascadeDelete: true },
      ]);
      org.notWorked.add('EmailMessageRelation');
      org.add('Account', runRow(ACCOUNT));
      org.add('EmailMessage', runRow(message));
      org.add(
        'EmailMessageRelation',
        ...relations.map((relation) => ({
          Id: relation,
          EmailMessageId: message,
          CreatedDate: DURING_RUN,
          SystemModstamp: DURING_RUN,
        })),
      );
      org.refuse = (object) =>
        object === 'EmailMessageRelation'
          ? {
              statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
              message: 'can be updated only in a draft state',
            }
          : undefined;
      const stop = new AbortController();

      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'EmailMessageRelation', ids: relations },
          { objectApiName: 'EmailMessage', ids: [message] },
          { objectApiName: 'Account', ids: [ACCOUNT] },
        ],
        options({
          signal: stop.signal,
          onProgress: (settled, _total, objectApiName) => {
            if (objectApiName === 'EmailMessage' && settled === 3) stop.abort();
          },
        }),
      );

      expect(outcome.cancelled).toBe(true);
      expect(org.deletes.map((d) => d.object)).toEqual(['EmailMessageRelation', 'EmailMessage']);
      expect(org.queries.filter((q) => q.includes('LastModifiedById'))).toEqual([
        `SELECT Id, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${ACCOUNT}')`,
      ]);
    });
  });

  describe("the org's clock, never this machine's", () => {
    /** A run's opportunity and line item, whose delete the org answers with a feed item. */
    function opportunityWithLineItem() {
      const org = new FakeOrg();
      const opportunity = id('006', 1);
      org.relationships.set('Opportunity', [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
      ]);
      org.add('Opportunity', runRow(opportunity));
      org.add('OpportunityLineItem', runRow(id('00k', 1), { OpportunityId: opportunity }));
      // The amount the line item made changes, and feed tracking says so,
      // dated by the org.
      org.onDelete = (object) => {
        if (object !== 'OpportunityLineItem') return;
        const now = org.now();
        org.add('FeedItem', {
          Id: id('0D5', 1),
          ParentId: opportunity,
          CreatedDate: now,
          LastModifiedDate: now,
          CreatedById: USER,
        });
      };
      const plan = [
        { objectApiName: 'OpportunityLineItem', ids: [id('00k', 1)] },
        { objectApiName: 'Opportunity', ids: [opportunity] },
      ];
      return { org, opportunity, plan };
    }

    it('dates its own start by the org: what the org records about it goes, the org half a minute behind', async () => {
      const { org, opportunity, plan } = opportunityWithLineItem();
      org.clockAheadMs = -30_000;

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects[1]).toMatchObject({ deleted: 1, keptDependents: 0 });
      expect(org.has('Opportunity', opportunity)).toBe(false);
    });

    it('never takes for its own what someone added just before it started, the org half a minute ahead', async () => {
      const { org, plan } = accountWithContacts();
      org.clockAheadMs = 30_000;
      const tenSecondsAgo = new Date(Date.parse(org.now()) - 10_000).toISOString();
      org.add('Task', {
        Id: id('00T', 1),
        WhatId: id('001', 1),
        CreatedDate: tenSecondsAgo,
        LastModifiedDate: tenSecondsAgo,
      });

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects[1]).toMatchObject({ deleted: 0, keptDependents: 1, heldBy: ['Task'] });
      expect(org.has('Task', id('00T', 1))).toBe(true);
    });

    it('takes nothing for its own when the org does not tell its clock', async () => {
      const { org, opportunity, plan } = opportunityWithLineItem();
      org.serverTime = async () => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      };

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects[1]).toMatchObject({
        deleted: 0,
        keptDependents: 1,
        heldBy: ['FeedItem'],
      });
      expect(org.has('Opportunity', opportunity)).toBe(true);
      // Nor for a later removal's.
      expect(outcome.span).toBeUndefined();
    });

    it("dates a run that kept no dates by its records': from the first created, for as long as it took", async () => {
      // Created on the org's clock at 10:00:02, whatever this machine's said;
      // one contact updated by the run three seconds in, one by someone a
      // minute later; a task a flow opened on the account as it went.
      const at = (seconds: number): string =>
        new Date(Date.parse('2026-09-20T10:00:00.000Z') + seconds * 1000).toISOString();
      const org = new FakeOrg();
      org.relationships.set('Account', ACCOUNT_CHILDREN);
      org.add('Account', { Id: id('001', 1), CreatedDate: at(2), LastModifiedDate: at(2) });
      org.add(
        'Contact',
        { Id: id('003', 1), AccountId: id('001', 1), CreatedDate: at(3), LastModifiedDate: at(5) },
        { Id: id('003', 2), AccountId: id('001', 1), CreatedDate: at(3), LastModifiedDate: at(62) },
      );
      org.add('Task', {
        Id: id('00T', 1),
        WhatId: id('001', 1),
        CreatedDate: at(4),
        LastModifiedDate: at(4),
      });
      const plan = [
        { objectApiName: 'Contact', ids: [id('003', 1), id('003', 2)] },
        { objectApiName: 'Account', ids: [id('001', 1)] },
      ];

      const outcome = await removeRunRecords(org, plan, {
        runDurationMs: 5_000,
        includeChanged: false,
      });

      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', deleted: 1, keptChanged: 1 }),
        // Held by the contact changed since, and by nothing that came with the run.
        expect.objectContaining({
          objectApiName: 'Account',
          keptDependents: 1,
          heldBy: ['Contact'],
        }),
      ]);
      expect(org.has('Contact', id('003', 1))).toBe(false);
    });

    it('dates a run that kept no dates by when it was recorded: what changed after it ended stays, however long it read', async () => {
      // Four minutes of reading the source, one of writing, recorded as it
      // ended on a machine whose clock agrees with the org's. Two minutes
      // later a colleague edited a contact and logged a task on the account.
      const at = (minutes: number): string =>
        new Date(Date.parse('2026-09-20T10:00:00.000Z') + minutes * 60_000).toISOString();
      const org = new FakeOrg();
      org.relationships.set('Account', ACCOUNT_CHILDREN);
      org.add('Account', { Id: id('001', 1), CreatedDate: at(4), LastModifiedDate: at(4) });
      org.add(
        'Contact',
        {
          Id: id('003', 1),
          AccountId: id('001', 1),
          CreatedDate: at(4.5),
          LastModifiedDate: at(5),
        },
        {
          Id: id('003', 2),
          AccountId: id('001', 1),
          CreatedDate: at(4.5),
          LastModifiedDate: at(7),
        },
      );
      org.add('Task', {
        Id: id('00T', 1),
        WhatId: id('001', 1),
        CreatedDate: at(7),
        LastModifiedDate: at(7),
        CreatedById: COLLEAGUE,
      });
      const plan = [
        { objectApiName: 'Contact', ids: [id('003', 1), id('003', 2)] },
        { objectApiName: 'Account', ids: [id('001', 1)] },
      ];

      const outcome = await removeRunRecords(org, plan, {
        runDurationMs: 5 * 60_000,
        runRecordedAt: new Date(at(5)),
        includeChanged: false,
      });

      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', deleted: 1, keptChanged: 1 }),
        expect.objectContaining({
          objectApiName: 'Account',
          deleted: 0,
          keptDependents: 1,
          heldBy: ['Contact', 'Task'],
        }),
      ]);
      expect(org.has('Task', id('00T', 1))).toBe(true);
    });

    it('starts a run that kept no dates when it began, not at the creation dates it copied from the source', async () => {
      // The run's user may set audit fields in both orgs, so its account
      // carries the source's creation date, years before the run. A contact
      // created two months before the run was moved under it since.
      const org = new FakeOrg();
      org.relationships.set('Account', ACCOUNT_CHILDREN);
      org.add('Account', {
        Id: id('001', 1),
        CreatedDate: '2019-05-01T08:00:00.000+0000',
        LastModifiedDate: '2019-06-01T08:00:00.000+0000',
      });
      org.add('Contact', {
        Id: id('003', 9),
        AccountId: id('001', 1),
        CreatedDate: '2026-07-20T09:00:00.000+0000',
        LastModifiedDate: AFTER_RUN,
        CreatedById: COLLEAGUE,
      });

      const outcome = await removeRunRecords(
        org,
        [{ objectApiName: 'Account', ids: [id('001', 1)] }],
        { runDurationMs: 5 * 60_000, runRecordedAt: new Date(RUN_ENDED), includeChanged: true },
      );

      // The run never made it: asking for what changed since the run does not reach it.
      expect(outcome.objects[0]).toMatchObject({
        deleted: 0,
        keptDependents: 1,
        heldBy: ['Contact'],
      });
      expect(org.has('Contact', id('003', 9))).toBe(true);
    });

    it('keeps a parent someone else added a record under while the removal ran, and that record', async () => {
      // A colleague logs a task on the cloned account while the removal is
      // deleting its contacts: created once the removal started, and still
      // not the removal's doing.
      const { org, plan } = accountWithContacts();
      org.onDelete = (object) => {
        if (object !== 'Contact' || org.has('Task', id('00T', 1))) return;
        const now = org.now();
        org.add('Task', {
          Id: id('00T', 1),
          WhatId: id('001', 1),
          CreatedDate: now,
          LastModifiedDate: now,
          CreatedById: COLLEAGUE,
        });
      };

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects[1]).toMatchObject({
        objectApiName: 'Account',
        deleted: 0,
        keptDependents: 1,
        heldBy: ['Task'],
      });
      expect(org.has('Task', id('00T', 1))).toBe(true);
    });

    it('takes nothing for its own when the org does not say who it runs as', async () => {
      const { org, opportunity, plan } = opportunityWithLineItem();
      org.userId = async () => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      };

      const outcome = await removeRunRecords(org, plan, options());

      expect(outcome.objects[1]).toMatchObject({
        deleted: 0,
        keptDependents: 1,
        heldBy: ['FeedItem'],
      });
      expect(org.has('Opportunity', opportunity)).toBe(true);
    });
  });

  it('lets a duplicate rule report on a run record go with it, whenever the platform wrote it', async () => {
    // The rule matched the cloned account with accounts the org held and
    // added it to their set a second after the run's last write.
    const { org, plan } = accountWithContacts();
    org.relationships.set('Account', [
      ...ACCOUNT_CHILDREN,
      { childSObject: 'DuplicateRecordItem', field: 'RecordId', cascadeDelete: true },
    ]);
    const aSecondAfter = new Date(Date.parse(RUN_ENDED) + 1_000).toISOString();
    org.add('DuplicateRecordItem', {
      Id: id('0GL', 1),
      RecordId: id('001', 1),
      DuplicateRecordSetId: id('0GK', 1),
      CreatedDate: aSecondAfter,
      LastModifiedDate: aSecondAfter,
    });

    const outcome = await removeRunRecords(org, plan, options());

    expect(outcome.objects[1]).toMatchObject({ deleted: 1, keptDependents: 0, heldBy: [] });
    expect(org.has('Account', id('001', 1))).toBe(false);
    expect(org.has('DuplicateRecordItem', id('0GL', 1))).toBe(false);
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

describe('takenAlong', () => {
  const seenAll = (): boolean => true;

  it('names the refused records the org no longer holds, whichever length their id comes back in', async () => {
    const refused = [id('0ER', 1), id('0ER', 2), id('0ER', 3)];

    const readBack = await takenAlong(
      refused,
      async () => [{ Id: refused[1].slice(0, 15) }],
      seenAll,
    );

    expect(readBack).toEqual({ gone: [refused[0], refused[2]], unchecked: [] });
  });

  it('takes none for gone when they cannot be read, says so, and reads nothing for none', async () => {
    const failing = vi.fn(async (): Promise<Array<Record<string, unknown>>> => {
      throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
    });
    const idle = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);

    await expect(takenAlong([id('0ER', 1)], failing, seenAll)).resolves.toEqual({
      gone: [],
      unchecked: [id('0ER', 1)],
      failure: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
    });
    await expect(takenAlong([], idle, seenAll)).resolves.toEqual({ gone: [], unchecked: [] });
    expect(idle).not.toHaveBeenCalled();
  });

  it('never takes for gone a record the session did not read before: it may be out of its sight', async () => {
    // A query does not answer a record a sharing rule hides any more than a
    // deleted one: only a record the session read before its delete, and
    // misses now, went with a parent.
    const refused = [id('0ER', 1), id('0ER', 2)];

    const readBack = await takenAlong(
      refused,
      async () => [],
      (recordId) => recordId === refused[0],
    );

    expect(readBack).toEqual({ gone: [refused[0]], unchecked: [refused[1]] });
  });
});

describe('setBackToDraftOf', () => {
  it('names the objects whose records past Draft a removal sets back to Draft, and not a contract, deleted as it stands', () => {
    expect(setBackToDraftOf(['Account', 'Order', 'Contract', 'OrderItem'])).toEqual(['Order']);
  });
});
