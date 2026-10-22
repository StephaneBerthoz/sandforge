import { describe, expect, it } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';

import type { RemovalOrg } from './ForgeRunRemoval.js';
import {
  HAND_WORK_OBJECTS,
  SWEEP_OBJECT_BOUND,
  SWEEP_SIDE_OBJECTS,
  listSweep,
  sweepAuditDetails,
  sweepAuditObjects,
  sweepAutomationOf,
  sweepFoundCount,
  sweepFoundObjects,
  sweepMarkOf,
  sweepRunRecords,
  sweepWindowOf,
  type SweepInput,
} from './ForgeRunSweep.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The user the run wrote as. */
const RUN_USER = id('005', 1);
/** Someone else working in the org. */
const COLLEAGUE = id('005', 2);

const FIRST_WRITE = '2026-10-15T09:00:00.000Z';
const LAST_WRITE = '2026-10-15T09:02:00.000Z';
const DURING = '2026-10-15T09:01:00.000+0000';
/** Half a minute after the last write: an asynchronous path's record, inside the window. */
const JUST_AFTER = '2026-10-15T09:02:30.000+0000';
const BEFORE = '2026-10-15T08:00:00.000+0000';
const LONG_AFTER = '2026-10-15T11:00:00.000+0000';

type Row = Record<string, unknown> & { Id: string };

/** The fields a describe lists unless a test says otherwise. */
const DEFAULT_FIELDS = [
  'Id',
  'Name',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'LastModifiedById',
];

/**
 * An org in memory that answers the sweep's queries as the org would: by the
 * creator, the creation dates and the id the query names, a page at a time.
 */
class SweepOrg implements RemovalOrg {
  readonly rows = new Map<string, Row[]>();
  /** Records deleted, kept in the recycle bin. */
  readonly bin = new Map<string, Row[]>();
  readonly fields = new Map<string, string[]>();
  readonly children = new Map<string, Array<{ childSObject: string; field: string }>>();
  readonly notDeletable = new Set<string>();
  /** Ids the org refuses to delete, until `freed` lets them go. */
  readonly refusals = new Map<string, string>();
  /** Ids a refusal holds only on the first try. */
  readonly freedOnRetry = new Set<string>();
  readonly deletes: Array<{ object: string; ids: string[] }> = [];
  readonly queries: string[] = [];
  /** An org that answers every row of an object, whatever the query asks: what the sweep checks again. */
  answersEverything = false;
  /** Told after each delete. */
  onDelete?: () => void;

  add(object: string, ...rows: Row[]): void {
    this.rows.set(object, [...(this.rows.get(object) ?? []), ...rows]);
  }

  ids(object: string): string[] {
    return (this.rows.get(object) ?? []).map((row) => row.Id);
  }

  async describe(objectApiName: string): Promise<unknown> {
    if (!this.rows.has(objectApiName) && !this.fields.has(objectApiName)) {
      throw new Error(`INVALID_TYPE: sObject type '${objectApiName}' is not supported.`);
    }
    return {
      name: objectApiName,
      label: objectApiName,
      queryable: true,
      deletable: !this.notDeletable.has(objectApiName),
      fields: (this.fields.get(objectApiName) ?? DEFAULT_FIELDS).map((name) => ({
        name,
        label: name,
        type: 'string',
        ...(name === 'Name' ? { nameField: true } : {}),
      })),
      childRelationships: (this.children.get(objectApiName) ?? []).map((child) => ({
        ...child,
        cascadeDelete: false,
      })),
    };
  }

  async describeGlobal(): Promise<unknown> {
    return {
      sobjects: [...new Set([...this.rows.keys(), ...this.fields.keys()])].map((name) => ({
        name,
      })),
    };
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.queries.push(soql);
    const match =
      /^SELECT (.+) FROM (\w+) WHERE CreatedById = '(\w+)' AND CreatedDate >= (\S+) AND CreatedDate <= (\S+?)(?: AND Id > '(\w+)')?(?: ORDER BY Id LIMIT (\d+))?$/.exec(
        soql,
      );
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, user, from, to, after, limit] = match;
    let rows = [...(this.rows.get(object) ?? [])].sort((a, b) => a.Id.localeCompare(b.Id));
    if (!this.answersEverything) {
      rows = rows.filter((row) => {
        const created = Date.parse(String(row.CreatedDate));
        return row.CreatedById === user && created >= Date.parse(from) && created <= Date.parse(to);
      });
    }
    if (after) rows = rows.filter((row) => row.Id > after);
    if (columns === 'COUNT()') return { totalSize: rows.length, records: [] };
    const page = limit ? rows.slice(0, Number(limit)) : rows;
    return { totalSize: page.length, records: page.map((row) => ({ ...row })) };
  }

  async queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    const match = /^SELECT CreatedById FROM (\w+) WHERE Id IN \((.*)\)$/.exec(soql);
    if (!match) throw new Error(`unexpected query of the recycle bin: ${soql}`);
    const wanted = new Set(match[2].split(', ').map((quoted) => quoted.slice(1, -1)));
    const all = [...(this.rows.get(match[1]) ?? []), ...(this.bin.get(match[1]) ?? [])];
    return {
      records: all
        .filter((row) => wanted.has(row.Id))
        .map((row) => ({ CreatedById: row.CreatedById })),
    };
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.deletes.push({ object: objectApiName, ids: [...ids] });
    const answer = ids.map((recordId) => {
      const refusal = this.refusals.get(recordId);
      if (refusal) {
        if (this.freedOnRetry.has(recordId)) this.refusals.delete(recordId);
        return {
          id: recordId,
          success: false,
          errors: [{ statusCode: 'DELETE_FAILED', message: refusal }],
        };
      }
      const rows = this.rows.get(objectApiName) ?? [];
      const row = rows.find((r) => r.Id === recordId);
      if (!row) {
        return {
          id: recordId,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
        };
      }
      this.rows.set(
        objectApiName,
        rows.filter((r) => r.Id !== recordId),
      );
      this.bin.set(objectApiName, [...(this.bin.get(objectApiName) ?? []), row]);
      return { id: recordId, success: true, errors: [] };
    });
    this.onDelete?.();
    return answer;
  }

  async update(): Promise<unknown> {
    throw new Error('a sweep updates nothing');
  }

  async serverTime(): Promise<string> {
    return new Date().toISOString();
  }

  async userId(): Promise<string> {
    return RUN_USER;
  }
}

/** A record created by `by` at `created`, last modified then unless told. */
function rec(
  recordId: string,
  name: string,
  by: string,
  created: string,
  modified: { at?: string; by?: string } = {},
): Row {
  return {
    Id: recordId,
    Name: name,
    CreatedById: by,
    CreatedDate: created,
    LastModifiedDate: modified.at ?? created,
    LastModifiedById: modified.by ?? by,
  };
}

/**
 * The org after a clone of one case and its contact into it, the run's own
 * records still there (or in the recycle bin once removed): every other
 * object the tests read starts empty.
 */
function orgAfterRun(): SweepOrg {
  const org = new SweepOrg();
  org.add('Case', rec(id('500', 1), 'Cloned case', RUN_USER, DURING));
  org.add('Contact', rec(id('003', 1), 'Cloned contact', RUN_USER, DURING));
  for (const object of ['Task', 'FeedItem', 'Asset', 'Opportunity', 'Account']) org.add(object);
  return org;
}

/** What a sweep is told of that run: its window, its records, its remap. */
function input(overrides: Partial<SweepInput> = {}): SweepInput {
  const created = [
    { objectApiName: 'Case', ids: [id('500', 1)] },
    { objectApiName: 'Contact', ids: [id('003', 1)] },
  ];
  const remap = new Set(created.flatMap((object) => object.ids.map((x) => x.slice(0, 15))));
  return {
    writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
    created,
    remap,
    automation: { creates: ['Asset'] },
    ...overrides,
  };
}

const NO_SPANS = { includeChanged: false, removalSpans: [] };

describe('sweepWindowOf', () => {
  it('runs from a second before the first write to a minute after the last, to the second', () => {
    expect(
      sweepWindowOf({ first: '2026-10-15T09:00:00.400Z', last: '2026-10-15T09:02:00.200Z' }),
    ).toEqual({ from: '2026-10-15T08:59:59Z', to: '2026-10-15T09:03:01Z' });
  });

  it('is none for a run whose writes were not dated', () => {
    expect(sweepWindowOf(undefined)).toBeUndefined();
    expect(sweepWindowOf({ first: 'not a date', last: LAST_WRITE })).toBeUndefined();
  });
});

describe('sweepAutomationOf', () => {
  const flow = (overrides: Partial<ForgeTargetFlow>): ForgeTargetFlow => ({
    apiName: 'F',
    label: 'F',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  });
  const automation = (
    objects: ForgeTargetAutomation['objects'],
    unread: ForgeTargetAutomation['unread'] = [],
  ): ForgeTargetAutomation =>
    ({ objectsRead: ['Case'], objects, unread }) as unknown as ForgeTargetAutomation;

  it('names the objects the flows and processes of the run’s objects create, each once', () => {
    const read = sweepAutomationOf(
      automation([
        {
          objectApiName: 'Case',
          flows: [flow({ creates: ['Asset', 'Task'] })],
          triggers: [],
          processes: [flow({ creates: ['task', 'Insured_Risk__c'] })],
        },
      ]),
    );
    expect(read).toEqual({ creates: ['Asset', 'Task', 'Insured_Risk__c'] });
  });

  it('leaves out a flow that starts on a delete, which fires on the removal and not on the run', () => {
    const read = sweepAutomationOf(
      automation([
        {
          objectApiName: 'Case',
          flows: [flow({ startsOn: 'delete', timing: 'beforeDelete', creates: ['Task'] })],
          triggers: [],
        },
      ]),
    );
    expect(read).toEqual({ creates: [] });
  });

  it('says the flows whose metadata was not read, the triggers that write, and the parts refused', () => {
    const read = sweepAutomationOf(
      automation(
        [
          {
            objectApiName: 'Case',
            flows: [flow({ condition: 'notRead' }), flow({ condition: 'unreadable' })],
            triggers: [
              { name: 'CaseTrigger', events: ['afterInsert'] },
              { name: 'CaseDeleteLog', events: ['afterDelete'] },
            ],
          },
        ],
        [{ part: 'processes', reason: 'INSUFFICIENT_ACCESS' }],
      ),
    );
    expect(read.gaps).toEqual({ flowsNotRead: 2, triggers: 1, error: 'INSUFFICIENT_ACCESS' });
  });

  it('says why when the automation could not be read at all', () => {
    expect(sweepAutomationOf({ error: 'REQUEST_LIMIT_EXCEEDED' })).toEqual({
      creates: [],
      gaps: { flowsNotRead: 0, triggers: 0, error: 'REQUEST_LIMIT_EXCEEDED' },
    });
  });
});

describe('listSweep', () => {
  it('lists, per object, what the run’s user created in the window that the run’s remap does not hold', async () => {
    const org = orgAfterRun();
    org.add(
      'Task',
      rec(id('00T', 1), 'Welcome call', RUN_USER, DURING),
      rec(id('00T', 2), 'Follow up', RUN_USER, JUST_AFTER),
    );
    org.add('Asset', rec(id('02i', 1), 'Insured risk', RUN_USER, DURING));

    const listing = await listSweep(org, input());

    expect(listing.refusal).toBeUndefined();
    expect(listing.window).toEqual({ from: '2026-10-15T08:59:59Z', to: '2026-10-15T09:03:00Z' });
    expect(listing.found).toEqual([
      { objectApiName: 'Task', count: 2, names: ['Welcome call', 'Follow up'] },
      { objectApiName: 'Asset', count: 1, names: ['Insured risk'] },
    ]);
    // The run's own case and contact are in its remap: never listed.
    expect(listing.found.map((found) => found.objectApiName)).not.toContain('Case');
    expect(listing.handWork).toEqual([]);
    expect(org.deletes).toEqual([]);
  });

  it('looks at the objects the run wrote, the side objects the org has, and what the automation creates', async () => {
    const org = orgAfterRun();
    const listing = await listSweep(org, input());
    expect(listing.looked).toEqual(['Case', 'Contact', 'Task', 'FeedItem', 'Asset']);
    // Side objects the org does not have are no object to sweep, and not said.
    expect(listing.unread).toEqual([]);
    expect(SWEEP_SIDE_OBJECTS).toEqual(
      expect.arrayContaining(['Task', 'Event', 'FeedItem', 'EmailMessage', 'CaseComment']),
    );
  });

  it('says an object it cannot tell creators by, and one the automation creates that the org lacks', async () => {
    const org = orgAfterRun();
    org.fields.set('ContentDocumentLink', ['Id', 'LinkedEntityId', 'SystemModstamp']);
    const listing = await listSweep(org, input({ automation: { creates: ['Insured_Risk__c'] } }));
    expect(listing.unread).toEqual([
      { objectApiName: 'Insured_Risk__c', reason: 'The org has no such object.' },
      {
        objectApiName: 'ContentDocumentLink',
        reason: expect.stringContaining('keeps no creator or creation date'),
      },
    ]);
  });

  it('refuses a run whose writes the target did not date, and reads nothing more', async () => {
    const org = orgAfterRun();
    const listing = await listSweep(org, input({ writtenBetween: undefined }));
    expect(listing.refusal).toMatch(/did not date this run’s writes/);
    expect(org.queries).toEqual([]);
  });

  it('reads the run’s user from its records in the recycle bin once a removal took them', async () => {
    const org = orgAfterRun();
    await org.destroy('Case', [id('500', 1)]);
    await org.destroy('Contact', [id('003', 1)]);
    org.add('Task', rec(id('00T', 1), 'Welcome call', RUN_USER, DURING));
    org.deletes.length = 0;

    const listing = await listSweep(org, input());

    expect(listing.refusal).toBeUndefined();
    expect(listing.found).toEqual([{ objectApiName: 'Task', count: 1, names: ['Welcome call'] }]);
  });

  it('takes the user it is told for a run that created nothing: a Sync run that only wrote over records', async () => {
    const org = orgAfterRun();
    // It created no case and no contact.
    org.rows.set('Case', []);
    org.rows.set('Contact', []);
    org.add('Task', rec(id('00T', 1), 'Account updated', RUN_USER, DURING));
    org.add('Task', rec(id('00T', 2), 'A colleague’s', COLLEAGUE, DURING));

    const listing = await listSweep(org, input({ created: [], user: RUN_USER }));

    expect(listing.refusal).toBeUndefined();
    expect(listing.found).toEqual([
      { objectApiName: 'Task', count: 1, names: ['Account updated'] },
    ]);
  });

  it('refuses a run that created nothing when no user is told, and lists nothing', async () => {
    const org = orgAfterRun();
    org.add('Task', rec(id('00T', 1), 'Account updated', RUN_USER, DURING));

    const listing = await listSweep(org, input({ created: [] }));

    expect(listing.refusal).toMatch(/^The run created nothing, and none of the records it wrote/);
    expect(listing.found).toEqual([]);
  });

  it('reads the user from the records the run created, whatever it is told', async () => {
    const org = orgAfterRun();
    org.add('Task', rec(id('00T', 1), 'Welcome call', RUN_USER, DURING));

    const listing = await listSweep(org, input({ user: COLLEAGUE }));

    expect(listing.found).toEqual([{ objectApiName: 'Task', count: 1, names: ['Welcome call'] }]);
  });

  it('refuses when the run’s records name more than one creator', async () => {
    const org = orgAfterRun();
    org.rows.set('Contact', [rec(id('003', 1), 'Cloned contact', COLLEAGUE, DURING)]);
    const listing = await listSweep(org, input());
    expect(listing.refusal).toMatch(/created by 2 different users/);
  });

  it('refuses a window in which the run’s user created records the run and its automation do not reach', async () => {
    const org = orgAfterRun();
    org.add('Task', rec(id('00T', 1), 'Welcome call', RUN_USER, DURING));
    org.add('Opportunity', rec(id('006', 1), 'Typed by hand', RUN_USER, DURING));

    const listing = await listSweep(org, input());

    expect(listing.handWork).toEqual([{ objectApiName: 'Opportunity', count: 1 }]);
    expect(listing.refusal).toMatch(/hand work, likely/);
    expect(listing.refusal).toContain('Opportunity: 1');
    expect(HAND_WORK_OBJECTS).toContain('Opportunity');
  });

  it('takes no record the automation creates for hand work', async () => {
    const org = orgAfterRun();
    // Asset is a hand-work object, but the target's Case flow creates assets.
    org.add('Asset', rec(id('02i', 1), 'Insured risk', RUN_USER, DURING));
    const listing = await listSweep(org, input());
    expect(listing.handWork).toEqual([]);
    expect(listing.found).toEqual([{ objectApiName: 'Asset', count: 1, names: ['Insured risk'] }]);
  });

  it('counts an object past the bound as over it, and stops reading it there', async () => {
    const org = orgAfterRun();
    org.add(
      'FeedItem',
      ...Array.from({ length: SWEEP_OBJECT_BOUND + 1 }, (_, n) =>
        rec(id('0D5', n + 1), `Post ${n}`, RUN_USER, DURING),
      ),
    );
    const listing = await listSweep(org, input());
    expect(listing.found).toEqual([
      {
        objectApiName: 'FeedItem',
        count: SWEEP_OBJECT_BOUND,
        names: ['Post 0', 'Post 1', 'Post 2'],
        overBound: true,
      },
    ]);
  });
});

describe('sweepRunRecords', () => {
  it('deletes what the run’s user created in the window, and nothing created outside it or by anyone else', async () => {
    const org = orgAfterRun();
    const swept = [
      rec(id('00T', 1), 'Welcome call', RUN_USER, DURING),
      rec(id('00T', 2), 'Follow up', RUN_USER, JUST_AFTER),
    ];
    const kept = [
      rec(id('00T', 3), 'Before the run', RUN_USER, BEFORE),
      rec(id('00T', 4), 'Long after the run', RUN_USER, LONG_AFTER),
      rec(id('00T', 5), 'A colleague’s task', COLLEAGUE, DURING),
    ];
    org.add('Task', ...swept, ...kept);
    // An org that answers every row whatever the query asks: each row is
    // checked again before its delete is sent.
    org.answersEverything = true;

    const result = await sweepRunRecords(org, input(), NO_SPANS);

    const deleted = org.deletes.flatMap((call) => call.ids);
    expect(deleted.sort()).toEqual([id('00T', 1), id('00T', 2)]);
    expect(org.ids('Task').sort()).toEqual(kept.map((row) => row.Id).sort());
    // The run's own records, still there, are in its remap: never deleted.
    expect(org.ids('Case')).toEqual([id('500', 1)]);
    expect(result.status).toBe('success');
    expect(result.objects).toEqual([
      {
        objectApiName: 'Task',
        found: 2,
        deleted: 2,
        alreadyGone: 0,
        keptChanged: 0,
        refused: 0,
        reasons: [],
      },
    ]);
  });

  it('deletes nothing when the sweep is refused', async () => {
    const org = orgAfterRun();
    org.add('Task', rec(id('00T', 1), 'Welcome call', RUN_USER, DURING));
    org.add('Opportunity', rec(id('006', 1), 'Typed by hand', RUN_USER, DURING));

    const result = await sweepRunRecords(org, input(), NO_SPANS);

    expect(result.status).toBe('refused');
    expect(result.refusal).toMatch(/hand work/);
    expect(result.handWork).toEqual([{ objectApiName: 'Opportunity', count: 1 }]);
    expect(org.deletes).toEqual([]);
  });

  it('keeps what someone changed since the run, unless the request includes it', async () => {
    const changedByColleague = rec(id('00T', 1), 'Edited task', RUN_USER, DURING, {
      at: LONG_AFTER,
      by: COLLEAGUE,
    });
    const org = orgAfterRun();
    org.add('Task', changedByColleague, rec(id('00T', 2), 'Untouched', RUN_USER, DURING));

    const result = await sweepRunRecords(org, input(), NO_SPANS);
    expect(result.objects[0]).toMatchObject({ found: 2, deleted: 1, keptChanged: 1 });
    expect(result.status).toBe('partial');
    expect(org.ids('Task')).toEqual([id('00T', 1)]);

    const again = await sweepRunRecords(org, input(), { ...NO_SPANS, includeChanged: true });
    expect(again.objects[0]).toMatchObject({ found: 1, deleted: 1, keptChanged: 0 });
    expect(org.ids('Task')).toEqual([]);
  });

  it('takes what a removal of the run changed while it ran for no change since', async () => {
    const org = orgAfterRun();
    org.add(
      'Task',
      rec(id('00T', 1), 'Restamped by the removal', RUN_USER, DURING, {
        at: '2026-10-15T10:00:05.000+0000',
        by: RUN_USER,
      }),
    );
    const removalSpans = [
      { first: '2026-10-15T10:00:00.000Z', last: '2026-10-15T10:00:30.000Z', userId: RUN_USER },
    ];
    const result = await sweepRunRecords(org, input(), { includeChanged: false, removalSpans });
    expect(result.objects[0]).toMatchObject({ deleted: 1, keptChanged: 0 });
  });

  it('deletes children before their parents', async () => {
    const org = orgAfterRun();
    // A contact the target's automation created beside the run's, and a task
    // on it: the contacts are looked at first, as an object the run wrote.
    org.add('Contact', rec(id('003', 2), 'Created by a flow', RUN_USER, DURING));
    org.add('Task', rec(id('00T', 1), 'On that contact', RUN_USER, DURING));
    org.children.set('Contact', [{ childSObject: 'Task', field: 'WhoId' }]);

    await sweepRunRecords(org, input(), NO_SPANS);

    expect(org.deletes.map((call) => call.object)).toEqual(['Task', 'Contact']);
    expect(org.ids('Contact')).toEqual([id('003', 1)]);
  });

  it('stops between two calls when asked, and says it was cancelled', async () => {
    const org = orgAfterRun();
    org.add(
      'Task',
      ...Array.from({ length: 250 }, (_, n) =>
        rec(id('00T', n + 1), `Task ${n}`, RUN_USER, DURING),
      ),
    );
    const stop = new AbortController();
    org.onDelete = () => stop.abort();

    const result = await sweepRunRecords(org, input({ signal: stop.signal }), NO_SPANS);

    expect(result.status).toBe('cancelled');
    expect(org.deletes).toHaveLength(1);
    expect(org.ids('Task')).toHaveLength(50);
  });

  it('counts what the org refuses with its reason, and sends it once more once the rest has gone', async () => {
    const org = orgAfterRun();
    org.add(
      'Task',
      rec(id('00T', 1), 'Held a moment', RUN_USER, DURING),
      rec(id('00T', 2), 'Refused for good', RUN_USER, DURING),
      rec(id('00T', 3), 'Free', RUN_USER, DURING),
    );
    org.refusals.set(id('00T', 1), 'records still hang from it');
    org.freedOnRetry.add(id('00T', 1));
    org.refusals.set(id('00T', 2), 'a flow refuses the delete');

    const result = await sweepRunRecords(org, input(), NO_SPANS);

    expect(result.objects[0]).toMatchObject({
      found: 3,
      deleted: 2,
      refused: 1,
      reasons: ['DELETE_FAILED: a flow refuses the delete'],
    });
    expect(result.status).toBe('partial');
  });

  it('leaves an object past the bound unswept, and says so', async () => {
    const org = orgAfterRun();
    org.add(
      'FeedItem',
      ...Array.from({ length: SWEEP_OBJECT_BOUND + 1 }, (_, n) =>
        rec(id('0D5', n + 1), `Post ${n}`, RUN_USER, DURING),
      ),
    );
    const result = await sweepRunRecords(org, input(), NO_SPANS);
    expect(org.deletes).toEqual([]);
    expect(result.unread).toEqual([
      {
        objectApiName: 'FeedItem',
        reason: expect.stringContaining(`More than ${SWEEP_OBJECT_BOUND}`),
      },
    ]);
  });
});

describe('the sweep asked before its first delete', () => {
  it('stops before any delete when the approval refuses, and says why', async () => {
    const org = orgAfterRun();
    org.add('Task', rec(id('00T', 1), 'Welcome call', RUN_USER, DURING));
    const asked: number[] = [];

    const result = await sweepRunRecords(org, input(), {
      ...NO_SPANS,
      approve: async (listing) => {
        asked.push(sweepFoundCount(listing));
        return 'Operation blocked by Production Guard: production org';
      },
    });

    expect(asked).toEqual([1]);
    expect(result).toMatchObject({
      status: 'refused',
      refusal: 'Operation blocked by Production Guard: production org',
      objects: [],
    });
    expect(org.deletes).toEqual([]);
  });

  it('asks nothing when nothing was found', async () => {
    const org = orgAfterRun();
    let asked = false;
    const result = await sweepRunRecords(org, input(), {
      ...NO_SPANS,
      approve: async () => {
        asked = true;
        return 'refused';
      },
    });
    expect(asked).toBe(false);
    expect(result.status).toBe('success');
  });
});

describe('what a sweep leaves on the run and in the audit trail', () => {
  const result = {
    status: 'partial' as const,
    objects: [
      {
        objectApiName: 'Task',
        found: 3,
        deleted: 2,
        alreadyGone: 0,
        keptChanged: 1,
        refused: 0,
        reasons: [],
      },
      {
        objectApiName: 'Asset',
        found: 2,
        deleted: 1,
        alreadyGone: 0,
        keptChanged: 0,
        refused: 1,
        reasons: ['DELETE_FAILED: held'],
      },
      {
        objectApiName: 'FeedItem',
        found: 1,
        deleted: 0,
        alreadyGone: 1,
        keptChanged: 0,
        refused: 0,
        reasons: [],
      },
    ],
    unread: [],
    handWork: [],
  };

  it('adds what it deleted to the earlier sweeps, and says what the last one kept and had refused', () => {
    expect(
      sweepMarkOf(result, '2026-10-15T10:00:00.000Z', {
        sweptAt: '2026-10-15T09:30:00.000Z',
        deleted: 4,
        keptChanged: 2,
        refused: 0,
      }),
    ).toEqual({ sweptAt: '2026-10-15T10:00:00.000Z', deleted: 7, keptChanged: 1, refused: 1 });
  });

  it('marks nothing for a sweep that would not run', () => {
    expect(
      sweepMarkOf({ ...result, status: 'refused', objects: [] }, '2026-10-15T10:00:00.000Z'),
    ).toBeUndefined();
  });

  it('counts what it deleted and what the org refused per object, and its totals beside a sweep detail', () => {
    expect(sweepAuditObjects(result)).toEqual([
      { objectApiName: 'Task', created: 0, updated: 0, deleted: 2, failed: 0 },
      { objectApiName: 'Asset', created: 0, updated: 0, deleted: 1, failed: 1 },
    ]);
    expect(sweepAuditDetails(result, 'forge-1')).toEqual({
      sweep: true,
      forgeId: 'forge-1',
      found: 6,
      deleted: 3,
      keptChanged: 1,
      refused: 1,
      handWork: 0,
    });
  });

  it('counts and names what a listing found', () => {
    const found = [
      { objectApiName: 'Task', count: 3, names: [] },
      { objectApiName: 'Asset', count: 2, names: [] },
    ];
    expect(sweepFoundCount({ found })).toBe(5);
    expect(sweepFoundObjects({ found })).toEqual(['Task', 'Asset']);
  });
});
