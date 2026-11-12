import { describe, expect, it, vi } from 'vitest';
import { sweepTakenObjects } from '@sandforge/shared';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';

import { sweepOrgOf } from '../../bridge/handlers/removalSweep.js';
import { tiedTargetOrg } from '../../test/tiedTargetOrg.js';
import { compositeReader, type CompositeQueryConnection } from '../checkpoint/compositeQueries.js';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';
import {
  HAND_WORK_OBJECTS,
  NEVER_SWEPT,
  SWEEP_LOOK_BOUND,
  SWEEP_OBJECT_BOUND,
  SWEEP_SIDE_OBJECTS,
  listSweep,
  sweepAuditDetails,
  sweepAuditObjects,
  sweepAutomationOf,
  sweepCountsOf,
  sweepFoundCount,
  sweepFoundObjects,
  sweepMarkOf,
  sweepParts,
  sweepRunRecords,
  sweepWindowOf,
  type SweepInput,
  type SweepOptions,
  type SweepOrg as CountingOrg,
  type SweepTies,
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
/** Half a minute after the run's records: within a minute of them, still made for the run. */
const SOON_AFTER = '2026-10-15T09:01:30.000+0000';
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
 * object the tests read starts empty. What hangs from them goes by its own
 * delete: nothing cascades.
 */
function orgAfterRun(): TiedOrg {
  const org = new TiedOrg();
  org.shape('Case', {
    children: [
      { childSObject: 'Task', field: 'WhatId' },
      { childSObject: 'FeedItem', field: 'ParentId' },
    ],
  });
  org.shape('Contact', {
    references: { Source_Case__c: ['Case'] },
    children: [
      { childSObject: 'Task', field: 'WhoId' },
      { childSObject: 'Asset', field: 'ContactId' },
    ],
  });
  org.shape('Task', { references: { WhatId: ['Case'], WhoId: ['Contact'] } });
  org.shape('FeedItem', { references: { ParentId: ['Case'] } });
  org.shape('Asset', { references: { ContactId: ['Contact'] } });
  org.add('Case', rec(id('500', 1), 'Cloned case', RUN_USER, DURING));
  org.add('Contact', rec(id('003', 1), 'Cloned contact', RUN_USER, DURING));
  for (const object of ['Opportunity', 'Account']) org.add(object);
  return org;
}

/** A task on the run's case, by the run's user unless told, as the case's flow opens one. */
function onCase(
  n: number,
  name: string,
  by = RUN_USER,
  created = DURING,
  modified: { at?: string; by?: string } = {},
): Row {
  return { ...rec(id('00T', n), name, by, created, modified), WhatId: id('500', 1) };
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
    ties: {},
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

describe('sweepParts, what it takes and what it leaves', () => {
  const USER_ID = '005000000000001AAA';
  const CONTACT = '003000000000001AAA';
  const FIRST = '2026-09-20T10:00:00.000Z';
  const LAST = '2026-09-20T10:05:00.000Z';
  const made = (recordId: string, created: string, lookups: Record<string, string> = {}) => ({
    Id: recordId,
    Name: recordId,
    CreatedById: USER_ID,
    CreatedDate: created,
    LastModifiedDate: created,
    LastModifiedById: USER_ID,
    SystemModstamp: created,
    ...lookups,
  });
  const IN_THE_RUN = '2026-09-20T10:04:59.000+0000';
  const JUST_AFTER = '2026-09-20T10:05:00.000+0000';
  const LATER = '2026-09-20T10:10:00.000+0000';

  /** A contact of the run, and around it a task made for it, an event made late, a task tied to nothing. */
  function orgOfTheRun() {
    const org = tiedTargetOrg(USER_ID);
    org.shape('Contact', {
      children: [
        { childSObject: 'Task', field: 'WhoId' },
        { childSObject: 'Event', field: 'WhoId' },
      ],
    });
    org.shape('Task', { references: { WhoId: ['Contact'] } });
    org.shape('Event', { references: { WhoId: ['Contact'] } });
    org.add('Contact', made(CONTACT, IN_THE_RUN));
    org.add('Task', made('00T000000000001AAA', JUST_AFTER, { WhoId: CONTACT }));
    org.add('Event', made('00U000000000001AAA', LATER, { WhoId: CONTACT }));
    org.add('Task', made('00T000000000002AAA', JUST_AFTER));
    return org;
  }
  const run = (): SweepInput => ({
    writtenBetween: { first: FIRST, last: LAST },
    created: [{ objectApiName: 'Contact', ids: [CONTACT] }],
    remap: new Set([CONTACT.slice(0, 15)]),
    automation: { creates: [] },
    runUserId: USER_ID,
    ties: {},
  });
  const partsOf = (org: ReturnType<typeof orgOfTheRun>, options: Partial<SweepOptions> = {}) =>
    sweepParts(sweepOrgOf(org.conn as never, 'test'), run(), {
      includeChanged: false,
      removalSpans: [],
      ...options,
    });

  it('says the objects it deletes records of once it has read, what the listing’s classes say', async () => {
    const plain = partsOf(orgOfTheRun());
    expect(plain.takes).toEqual([]);
    await plain.ask();
    expect(plain.takes).toEqual(['Task']);
    expect(plain.takes).toEqual(sweepTakenObjects(plain.listing!, {}));

    const late = partsOf(orgOfTheRun(), { sweepLate: true });
    await late.ask();
    expect([...late.takes].sort()).toEqual(['Event', 'Task']);
    expect([...late.takes].sort()).toEqual(
      [...sweepTakenObjects(late.listing!, { sweepLate: true })].sort(),
    );
  });

  it('takes nothing of what a refused question would have taken', async () => {
    const parts = partsOf(orgOfTheRun(), { approve: async () => 'Declined.' });
    await parts.ask();

    expect(parts.takes).toEqual([]);
    expect(parts.result().left).toBeUndefined();
  });

  it('says with its result what it left, by class, its status unchanged', async () => {
    const org = orgOfTheRun();
    const parts = partsOf(org);
    await parts.first();
    await parts.afterRemoval();

    const result = parts.result();
    expect(result.status).toBe('success');
    expect(result.left).toEqual([
      { class: 'late', objects: [{ objectApiName: 'Event', count: 1 }], option: '--sweep-late' },
      {
        class: 'untied',
        objects: [{ objectApiName: 'Task', count: 1 }],
        option: '--sweep-untied',
      },
    ]);
  });

  it('leaves out of what it left the class it was asked to take', async () => {
    const parts = partsOf(orgOfTheRun(), { sweepLate: true, sweepUntied: true });
    await parts.first();
    await parts.afterRemoval();

    expect(parts.result().left).toBeUndefined();
  });

  it('says what is tied to nothing left, and why, when taking it is refused', async () => {
    const org = orgOfTheRun();
    const input = { ...run(), ties: { otherRuns: [{ ids: ['001000000000009AAA'] }] } };
    const parts = sweepParts(sweepOrgOf(org.conn as never, 'test'), input, {
      includeChanged: false,
      removalSpans: [],
      sweepUntied: true,
    });
    await parts.first();
    await parts.afterRemoval();

    expect(parts.result().left).toEqual([
      expect.objectContaining({ class: 'late' }),
      expect.objectContaining({
        class: 'untied',
        option: '--sweep-untied',
        refusal: expect.stringContaining('Another run of this machine'),
      }),
    ]);
  });

  it('ends partial, never a success, when it was asked to take what is tied to nothing and that was refused', async () => {
    // Run for real, a refused --sweep-untied ended "sweep: SUCCESS", exit 0,
    // above the thirty tasks it left.
    const others = { otherRuns: [{ ids: ['001000000000009AAA'] }] };
    const asked = sweepParts(
      sweepOrgOf(orgOfTheRun().conn as never, 'test'),
      { ...run(), ties: others },
      { includeChanged: false, removalSpans: [], sweepUntied: true },
    );
    await asked.first();
    await asked.afterRemoval();
    expect(asked.result()).toMatchObject({
      status: 'partial',
      objects: [expect.objectContaining({ objectApiName: 'Task', deleted: 1 })],
    });

    // Nothing else to take: it deleted nothing, and says so.
    const untiedOnly = orgOfTheRun();
    untiedOnly.rows.set(
      'Task',
      (untiedOnly.rows.get('Task') ?? []).filter((task) => task.Id === '00T000000000002AAA'),
    );
    untiedOnly.rows.set('Event', []);
    const none = sweepParts(
      sweepOrgOf(untiedOnly.conn as never, 'test'),
      { ...run(), ties: others },
      { includeChanged: false, removalSpans: [], sweepUntied: true },
    );
    await none.first();
    await none.afterRemoval();
    expect(none.result().status).toBe('failure');

    // Not asked, what it kept was no part of what it had to do.
    const unasked = sweepParts(
      sweepOrgOf(orgOfTheRun().conn as never, 'test'),
      { ...run(), ties: others },
      { includeChanged: false, removalSpans: [] },
    );
    await unasked.first();
    await unasked.afterRemoval();
    expect(unasked.result().status).toBe('success');
  });
});

describe('listSweep', () => {
  it('lists, per object, what the run’s user created in the window that the run’s remap does not hold', async () => {
    const org = orgAfterRun();
    org.add('Task', onCase(1, 'Welcome call'), onCase(2, 'Follow up', RUN_USER, JUST_AFTER));
    org.add('Asset', {
      ...rec(id('02i', 1), 'Insured risk', RUN_USER, DURING),
      ContactId: id('003', 1),
    });

    const listing = await listSweep(org, input());

    expect(listing.refusal).toBeUndefined();
    expect(listing.window).toEqual({ from: '2026-10-15T08:59:59Z', to: '2026-10-15T09:03:00Z' });
    expect(listing.found).toMatchObject([
      { objectApiName: 'Task', count: 2, names: ['Welcome call', 'Follow up'] },
      { objectApiName: 'Asset', count: 1, names: ['Insured risk'] },
    ]);
    // The run's own case and contact are in its remap: never listed.
    expect(listing.found.map((found) => found.objectApiName)).not.toContain('Case');
    expect(listing.handWork).toEqual([]);
    expect(org.deletes).toEqual([]);
  });

  it('looks at the objects the run wrote, the side objects the org has, what the automation creates and the hand-work objects', async () => {
    const org = orgAfterRun();
    const listing = await listSweep(org, input());
    expect(listing.looked).toEqual([
      'Case',
      'Contact',
      'Task',
      'FeedItem',
      'Asset',
      'Account',
      'Opportunity',
    ]);
    // Side objects the org does not have are no object to sweep, and not said.
    expect(listing.unread).toEqual([]);
    expect(SWEEP_SIDE_OBJECTS).toEqual(
      expect.arrayContaining(['Task', 'Event', 'FeedItem', 'EmailMessage', 'CaseComment']),
    );
    expect(HAND_WORK_OBJECTS).toContain('Opportunity');
  });

  it('says an object it cannot tell creators by, and one the automation creates that the org lacks', async () => {
    const org = orgAfterRun();
    org.shape('ContentDocumentLink', { fields: ['Id', 'LinkedEntityId', 'SystemModstamp'] });
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
    org.add('Task', onCase(1, 'Welcome call'));
    org.deletes.length = 0;

    const listing = await listSweep(org, input());

    expect(listing.refusal).toBeUndefined();
    expect(listing.found).toMatchObject([
      { objectApiName: 'Task', count: 1, names: ['Welcome call'] },
    ]);
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
    expect(listing.found).toMatchObject([
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
    org.add('Task', onCase(1, 'Welcome call'));

    const listing = await listSweep(org, input({ user: COLLEAGUE }));

    expect(listing.found).toMatchObject([
      { objectApiName: 'Task', count: 1, names: ['Welcome call'] },
    ]);
  });

  it('refuses when the run’s records name more than one creator', async () => {
    const org = orgAfterRun();
    org.rows.set('Contact', [rec(id('003', 1), 'Cloned contact', COLLEAGUE, DURING)]);
    const listing = await listSweep(org, input());
    expect(listing.refusal).toMatch(/created by 2 different users/);
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
  it('deletes what is tied to the run, and nothing created outside its window or by anyone else', async () => {
    const org = orgAfterRun();
    const swept = [onCase(1, 'Welcome call'), onCase(2, 'Follow up', RUN_USER, SOON_AFTER)];
    const kept = [
      onCase(3, 'Before the run', RUN_USER, BEFORE),
      onCase(4, 'Long after the run', RUN_USER, LONG_AFTER),
      onCase(5, 'A colleague’s task', COLLEAGUE, DURING),
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
    org.add('Task', onCase(1, 'Welcome call'));

    const result = await sweepRunRecords(org, input({ writtenBetween: undefined }), NO_SPANS);

    expect(result.status).toBe('refused');
    expect(result.refusal).toMatch(/did not date this run’s writes/);
    expect(org.deletes).toEqual([]);
  });

  it('keeps what someone changed since the run, unless the request includes it', async () => {
    const changedByColleague = onCase(1, 'Edited task', RUN_USER, DURING, {
      at: LONG_AFTER,
      by: COLLEAGUE,
    });
    const org = orgAfterRun();
    org.add('Task', changedByColleague, onCase(2, 'Untouched'));

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
      onCase(1, 'Restamped by the removal', RUN_USER, DURING, {
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
    // A contact the target's automation created under the run's case, and a
    // task on it: the contacts are looked at first, as an object the run wrote.
    org.add('Contact', {
      ...rec(id('003', 2), 'Created by a flow', RUN_USER, DURING),
      Source_Case__c: id('500', 1),
    });
    org.add('Task', {
      ...rec(id('00T', 1), 'On that contact', RUN_USER, DURING),
      WhoId: id('003', 2),
    });

    await sweepRunRecords(org, input(), NO_SPANS);

    expect(org.deletes.map((call) => call.object)).toEqual(['Task', 'Contact']);
    expect(org.ids('Contact')).toEqual([id('003', 1)]);
  });

  it('stops between two calls when asked, and says it was cancelled', async () => {
    const org = orgAfterRun();
    org.add('Task', ...Array.from({ length: 250 }, (_, n) => onCase(n + 1, `Task ${n}`)));
    const stop = new AbortController();
    org.onDelete = () => stop.abort();

    const result = await sweepRunRecords(org, input({ signal: stop.signal }), NO_SPANS);

    expect(result.status).toBe('cancelled');
    expect(org.deletes).toHaveLength(1);
    expect(org.ids('Task')).toHaveLength(50);
  });

  it('counts what the org refuses with its reason, and sends it once more once the rest has gone', async () => {
    const org = orgAfterRun();
    org.add('Task', onCase(1, 'Held a moment'), onCase(2, 'Refused for good'), onCase(3, 'Free'));
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

  /** What a trap org answered every record of a delete its trigger, querying per record, refused. */
  const LIMIT = {
    statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
    message: 'Task_Trigger: System.LimitException: Too many SOQL queries: 101',
  };

  /** The org, its trigger on Task refusing whole a call of more than `most`, or one holding `heavy`. */
  function limitedOnTasks(
    org: ReturnType<typeof orgAfterRun>,
    most: number,
    heavy = new Set<string>(),
  ) {
    const destroy = org.destroy.bind(org);
    org.destroy = async (objectApiName: string, ids: string[]): Promise<unknown> => {
      if (
        objectApiName === 'Task' &&
        (ids.length > most || ids.some((recordId) => heavy.has(recordId)))
      ) {
        org.deletes.push({ object: objectApiName, ids: [...ids] });
        return ids.map((recordId) => ({ id: recordId, success: false, errors: [LIMIT] }));
      }
      return destroy(objectApiName, ids);
    };
  }

  it('sends again smaller what the target’s automation refused for a limit, and says so', async () => {
    const org = orgAfterRun();
    org.add('Task', onCase(1, 'One'), onCase(2, 'Two'), onCase(3, 'Three'));
    limitedOnTasks(org, 1);

    const result = await sweepRunRecords(org, input(), NO_SPANS);

    expect(
      org.deletes.filter((call) => call.object === 'Task').map((call) => call.ids.length),
    ).toEqual([3, 1, 2, 1, 1]);
    expect(org.ids('Task')).toEqual([]);
    expect(result.objects[0]).toMatchObject({
      found: 3,
      deleted: 3,
      refused: 0,
      reasons: [
        'Task_Trigger hit Too many SOQL queries on a call of 3: sent 1 at a time, 4 calls more.',
      ],
    });
  });

  it('sends no second time a record refused for a limit sent on its own', async () => {
    const org = orgAfterRun();
    org.add('Task', onCase(1, 'Heavy'), onCase(2, 'Two'), onCase(3, 'Three'), onCase(4, 'Four'));
    limitedOnTasks(org, 200, new Set([id('00T', 1)]));

    const result = await sweepRunRecords(org, input(), NO_SPANS);

    // The call of 4; the heavy one on its own, then another; the two left.
    expect(
      org.deletes.filter((call) => call.object === 'Task').map((call) => call.ids.length),
    ).toEqual([4, 1, 1, 2]);
    expect(org.ids('Task')).toEqual([id('00T', 1)]);
    expect(result.objects[0]).toMatchObject({ deleted: 3, refused: 1 });
    expect(result.objects[0].reasons).toContain(`${LIMIT.statusCode}: ${LIMIT.message}`);
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
    org.add('Task', onCase(1, 'Welcome call'));
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

// ─── What ties a record to the run ───────────────────────────────────────────

/** What the org says of an object beyond its records: its lookups, its children, its flags. */
interface ObjectShape {
  /** Its columns in place of the usual ones: a read of any other is refused, as the org refuses it. */
  fields?: string[];
  /** Its lookups, by field, to the objects they may point at. */
  references?: Record<string, string[]>;
  children?: Array<{
    childSObject: string;
    field: string;
    cascadeDelete?: boolean;
    restrictedDelete?: boolean;
  }>;
  listed?: { queryable?: boolean; deletable?: boolean; createable?: boolean; layoutable?: boolean };
}

/** A 15- or 18-character id, as the org compares two: by its first fifteen characters. */
const ID_LIKE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const sameValue = (held: unknown, asked: string): boolean =>
  typeof held === 'string' && ID_LIKE.test(held) && ID_LIKE.test(asked)
    ? held.slice(0, 15) === asked.slice(0, 15)
    : held === asked;

/**
 * Answer `soql` from `rows` as the org does, for the statements a sweep
 * sends: `SELECT <fields> | COUNT() FROM <object>`, a WHERE of `=`,
 * `IN (…)`, `>=`, `<=` and `>` terms under AND, `ORDER BY Id`, `LIMIT`. An
 * id compares by its first fifteen characters, a polymorphic lookup's too.
 */
function answerSoql(soql: string, rows: Row[]): { totalSize: number; records: unknown[] } {
  const parts = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?( ORDER BY Id)?(?: LIMIT (\d+))?$/.exec(
    soql,
  );
  if (!parts) throw new Error(`MALFORMED_QUERY: ${soql}`);
  const [, columns, , where, ordered, limit] = parts;
  let kept = [...rows];
  for (const term of where ? where.split(' AND ') : []) {
    const inList = /^(\w+) IN \((.*)\)$/.exec(term);
    if (inList) {
      const values = inList[2].split(', ').map((quoted) => quoted.slice(1, -1));
      kept = kept.filter((row) => values.some((value) => sameValue(row[inList[1]], value)));
      continue;
    }
    const compared = /^(\w+) (=|>=|<=|>) (.+)$/.exec(term);
    if (!compared) throw new Error(`MALFORMED_QUERY: ${term}`);
    const [, field, op, raw] = compared;
    const quoted = raw.startsWith("'") ? raw.slice(1, -1) : undefined;
    kept = kept.filter((row) => {
      const held = row[field];
      if (op === '=') return sameValue(held, quoted ?? raw);
      if (op === '>') return String(held) > (quoted ?? raw);
      const time = Date.parse(String(held));
      return op === '>=' ? time >= Date.parse(raw) : time <= Date.parse(raw);
    });
  }
  if (ordered) kept.sort((a, b) => a.Id.localeCompare(b.Id));
  if (limit) kept = kept.slice(0, Number(limit));
  if (columns === 'COUNT()') return { totalSize: kept.length, records: [] };
  const names = columns.split(', ');
  return {
    totalSize: kept.length,
    records: kept.map((row) => Object.fromEntries(names.map((name) => [name, row[name] ?? null]))),
  };
}

/**
 * An org in memory a sweep works on: lookups and child relationships by
 * describe, a delete the org refuses while a restricting
 * lookup names the record (`Case.AssetId`, DELETE_FAILED), cascades, and a
 * lookup the org clears as the record it names goes (`Task.AccountId`).
 * Each call is counted where a run's write path is: a read, or a write.
 */
class TiedOrg implements CountingOrg {
  readonly rows = new Map<string, Row[]>();
  readonly bin = new Map<string, Row[]>();
  readonly shapes = new Map<string, ObjectShape>();
  readonly deletes: Array<{ object: string; ids: string[] }> = [];
  readonly queries: string[] = [];
  readonly events: WritePathStep[] = [];
  /** Ids the org refuses to delete, with its reason, until `freedOnRetry` lets them go. */
  readonly refusals = new Map<string, string>();
  /** Ids a refusal holds only on the first try. */
  readonly freedOnRetry = new Set<string>();
  /** An org that answers every row of an object, whatever the query asks: what the sweep checks again. */
  answersEverything = false;
  /** Told after each delete. */
  onDelete?: () => void;
  counts?: CountingOrg['counts'];

  add(object: string, ...rows: Row[]): void {
    this.rows.set(object, [...(this.rows.get(object) ?? []), ...rows]);
  }

  shape(object: string, shape: ObjectShape): void {
    this.shapes.set(object, { ...this.shapes.get(object), ...shape });
    if (!this.rows.has(object)) this.rows.set(object, []);
  }

  ids(object: string): string[] {
    return (this.rows.get(object) ?? []).map((row) => row.Id);
  }

  row(object: string, recordId: string): Row | undefined {
    return (this.rows.get(object) ?? []).find((row) => row.Id === recordId);
  }

  async describeGlobal(): Promise<unknown> {
    this.events.push('reads');
    return {
      sobjects: [...this.rows.keys()].map((name) => ({
        name,
        queryable: true,
        deletable: true,
        createable: true,
        layoutable: true,
        ...this.shapes.get(name)?.listed,
      })),
    };
  }

  async describe(objectApiName: string): Promise<unknown> {
    this.events.push('reads');
    if (!this.rows.has(objectApiName)) {
      throw new Error(`INVALID_TYPE: sObject type '${objectApiName}' is not supported.`);
    }
    const shape = this.shapes.get(objectApiName) ?? {};
    return {
      name: objectApiName,
      label: objectApiName,
      queryable: true,
      deletable: true,
      fields: [
        ...(shape.fields ?? DEFAULT_FIELDS).map((name) => ({
          name,
          label: name,
          type: name.endsWith('ById') ? 'reference' : 'string',
          ...(name.endsWith('ById') ? { referenceTo: ['User'] } : {}),
          ...(name === 'Name' ? { nameField: true } : {}),
        })),
        ...Object.entries(shape.references ?? {}).map(([name, referenceTo]) => ({
          name,
          label: name,
          type: 'reference',
          referenceTo,
        })),
      ],
      childRelationships: shape.children ?? [],
    };
  }

  /** What the org answers, without counting the call: a composite's subrequest. */
  answer(soql: string): { totalSize: number; records: unknown[] } {
    const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
    const columns = this.shapes.get(object)?.fields;
    const unknown = /(\w+) (?:=|>=|<=|>|IN) /
      .exec(soql.slice(soql.indexOf(' WHERE ')))
      ?.slice(1)
      .find((column) => columns && !columns.includes(column));
    if (unknown) throw new Error(`INVALID_FIELD: No such column '${unknown}' on ${object}`);
    return answerSoql(
      this.answersEverything
        ? soql.replace(/ WHERE CreatedById .*? AND CreatedDate <= \S+( AND )?/, (_, and) =>
            and ? ' WHERE ' : '',
          )
        : soql,
      this.rows.get(object) ?? [],
    );
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.events.push('reads');
    this.queries.push(soql);
    return this.answer(soql);
  }

  async queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    this.events.push('reads');
    this.queries.push(soql);
    const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
    return answerSoql(soql, [...(this.rows.get(object) ?? []), ...(this.bin.get(object) ?? [])]);
  }

  /** The live records whose `field` of `child` names `recordId`. */
  private naming(child: string, field: string, recordId: string): Row[] {
    return (this.rows.get(child) ?? []).filter((row) => sameValue(row[field], recordId));
  }

  /** Take a record out, what cascades from it along, and clear what only names it. */
  private remove(object: string, row: Row): void {
    this.rows.set(
      object,
      (this.rows.get(object) ?? []).filter((r) => r.Id !== row.Id),
    );
    this.bin.set(object, [...(this.bin.get(object) ?? []), row]);
    for (const relation of this.shapes.get(object)?.children ?? []) {
      for (const child of this.naming(relation.childSObject, relation.field, row.Id)) {
        if (relation.cascadeDelete) this.remove(relation.childSObject, child);
        else if (!relation.restrictedDelete) child[relation.field] = null;
      }
    }
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.events.push('write');
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
      const row = this.row(objectApiName, recordId);
      if (!row) {
        return {
          id: recordId,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
        };
      }
      const holders = (this.shapes.get(objectApiName)?.children ?? [])
        .filter((relation) => relation.restrictedDelete)
        .flatMap((relation) => this.naming(relation.childSObject, relation.field, recordId));
      if (holders.length > 0) {
        return {
          id: recordId,
          success: false,
          errors: [
            {
              statusCode: 'DELETE_FAILED',
              message: `Your attempt to delete ${String(row.Name)} could not be completed because it is associated with the following cases.: ${holders.length}`,
            },
          ],
        };
      }
      this.remove(objectApiName, row);
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

/** When the run created its case: a minute into its writes. */
const AT_CASE = '2026-10-15T09:01:00.000+0000';
/** `seconds` after the run created its case, as the org writes a date. */
const at = (seconds: number): string =>
  new Date(Date.parse('2026-10-15T09:01:00.000Z') + seconds * 1000)
    .toISOString()
    .replace('Z', '+0000');

/** The org's Automated Process user. */
const AUTOMATED_PROCESS = id('005', 9);

const ACCOUNT = id('001', 1);
const CONTACT = id('003', 1);
const CASE = id('500', 1);
/** The account the run linked a record to, in its id map: never one of its records. */
const LINKED_ACCOUNT = id('001', 9);

/** A record with its lookups. */
const recWith = (
  recordId: string,
  name: string,
  by: string,
  created: string,
  lookups: Record<string, string | null>,
): Row => ({ ...rec(recordId, name, by, created), ...lookups });

/**
 * The org after a clone of an account, its contact and a case into it, and
 * what came of it: the case's flow cloned the insured risk into an asset and
 * named it on the case (`Case.AssetId`, a lookup the org restricts the
 * asset's delete by), opened a task on the case and posted on its feed, a
 * comment followed; the account's flow opened a task naming the account
 * alone (`Task.AccountId`, cleared as the account goes). Then what is not the
 * run's to take unasked: a task tied to nothing, one on an account the run
 * only matched — tied to nothing of the run either —, a task on the contact
 * five minutes later, one the Automated Process user opened on the case, a
 * colleague's; and the mute's permission set assignment.
 */
function tiedOrg(): TiedOrg {
  const org = new TiedOrg();
  org.shape('Account', {
    children: [
      { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Case', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      { childSObject: 'Task', field: 'AccountId' },
      { childSObject: 'Asset', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'AccountHistory', field: 'AccountId', cascadeDelete: true },
    ],
  });
  org.shape('Contact', {
    references: { AccountId: ['Account'] },
    children: [
      { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
      { childSObject: 'Case', field: 'ContactId' },
    ],
  });
  org.shape('Case', {
    references: { AccountId: ['Account'], ContactId: ['Contact'], AssetId: ['Asset'] },
    children: [
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
    ],
  });
  org.shape('Asset', {
    references: { AccountId: ['Account'] },
    children: [{ childSObject: 'Case', field: 'AssetId', restrictedDelete: true }],
  });
  org.shape('Task', {
    references: {
      WhatId: ['Account', 'Case', 'Opportunity', 'Asset'],
      WhoId: ['Contact'],
      AccountId: ['Account'],
    },
  });
  org.shape('FeedItem', {
    references: { ParentId: ['Account', 'Case', 'Asset'] },
    children: [{ childSObject: 'FeedComment', field: 'FeedItemId', cascadeDelete: true }],
  });
  org.shape('FeedComment', { references: { FeedItemId: ['FeedItem'] } });
  org.shape('Opportunity', { references: { AccountId: ['Account'] } });
  // What the org keeps for itself behind an account: never looked at.
  org.shape('AccountHistory', { listed: { createable: false, layoutable: false } });
  org.shape('PermissionSetAssignment', { references: { PermissionSetId: ['PermissionSet'] } });
  org.add('User', {
    ...rec(AUTOMATED_PROCESS, 'Automated Process', COLLEAGUE, BEFORE),
    UserType: 'AutomatedProcess',
  });

  org.add('Account', recWith(ACCOUNT, 'Cloned account', RUN_USER, AT_CASE, {}));
  // A colleague's, made half a minute before: the run matched it, and a task
  // under it is no more the run's for coming soon after.
  org.add('Account', recWith(LINKED_ACCOUNT, 'Matched account', COLLEAGUE, at(-30), {}));
  org.add('Contact', recWith(CONTACT, 'Cloned contact', RUN_USER, AT_CASE, { AccountId: ACCOUNT }));
  org.add(
    'Case',
    recWith(CASE, 'Cloned case', RUN_USER, AT_CASE, {
      AccountId: ACCOUNT,
      ContactId: CONTACT,
      AssetId: id('02i', 1),
    }),
  );
  // Hung from nothing but the case that names it, as the client's assets were.
  org.add('Asset', recWith(id('02i', 1), 'Insured risk', RUN_USER, at(1), {}));
  org.add(
    'Task',
    recWith(id('00T', 1), 'Case follow-up', RUN_USER, at(1), { WhatId: CASE }),
    recWith(id('00T', 2), 'Account review', RUN_USER, at(20), { AccountId: ACCOUNT }),
    recWith(id('00T', 3), 'Loose task', RUN_USER, at(30), {}),
    recWith(id('00T', 4), 'Contact call', RUN_USER, at(5 * 60), { WhoId: CONTACT }),
    recWith(id('00T', 5), 'Queued check', AUTOMATED_PROCESS, at(10), { WhatId: CASE }),
    recWith(id('00T', 6), 'A colleague’s', COLLEAGUE, at(5), { WhatId: CASE }),
    recWith(id('00T', 7), 'On the matched account', RUN_USER, at(5), { WhatId: LINKED_ACCOUNT }),
  );
  org.add('FeedItem', recWith(id('0D5', 1), 'Case posted', RUN_USER, at(1), { ParentId: CASE }));
  org.add(
    'FeedComment',
    recWith(id('0D7', 1), 'Comment', RUN_USER, at(8), { FeedItemId: id('0D5', 1) }),
  );
  org.add(
    'PermissionSetAssignment',
    recWith(id('0Pa', 1), 'Bypass', RUN_USER, at(-50), { PermissionSetId: id('0PS', 1) }),
  );
  return org;
}

/** What a sweep is told of that run. */
function tiedInput(ties: SweepTies = {}, overrides: Partial<SweepInput> = {}): SweepInput {
  const created = [
    { objectApiName: 'Account', ids: [ACCOUNT] },
    { objectApiName: 'Contact', ids: [CONTACT] },
    { objectApiName: 'Case', ids: [CASE] },
  ];
  return {
    writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
    created,
    remap: new Set([ACCOUNT, CONTACT, CASE, LINKED_ACCOUNT].map((x) => x.slice(0, 15))),
    automation: { creates: ['Asset', 'PermissionSetAssignment'] },
    runUserId: RUN_USER,
    ties,
    ...overrides,
  };
}

/** The ids deleted, over every call. */
const deletedIds = (org: TiedOrg): string[] => org.deletes.flatMap((call) => call.ids);

describe('what a sweep lists', () => {
  it('lists each record in its class, hand work apart, and refuses only what is tied to nothing', async () => {
    const org = tiedOrg();
    org.add('Opportunity', rec(id('006', 1), 'Typed by hand', RUN_USER, at(40)));

    const listing = await listSweep(org, tiedInput());

    expect(listing.refusal).toBeUndefined();
    expect(listing.found).toEqual([
      {
        objectApiName: 'Task',
        count: 6,
        // The tasks it takes first.
        names: ['Case follow-up', 'Account review', 'Contact call'],
        classes: { made: 2, sameSave: 1, madeOver: 0, late: 2, untied: 2 },
      },
      {
        objectApiName: 'FeedItem',
        count: 1,
        names: ['Case posted'],
        classes: { made: 1, sameSave: 1, madeOver: 0, late: 0, untied: 0 },
      },
      {
        objectApiName: 'FeedComment',
        count: 1,
        names: ['Comment'],
        classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
      },
      {
        objectApiName: 'Asset',
        count: 1,
        names: ['Insured risk'],
        classes: { made: 1, sameSave: 1, madeOver: 0, late: 0, untied: 0 },
      },
    ]);
    expect(listing.handWork).toEqual([{ objectApiName: 'Opportunity', count: 1 }]);
    expect(listing.untied).toEqual({
      objects: [{ objectApiName: 'Task', count: 2 }],
      refusal: expect.stringMatching(/Opportunity: 1\): hand work, likely/),
    });
    expect(listing.untied?.refusal).toMatch(/runs of another machine, or of a CI/);
    expect(listing.late).toEqual([{ objectApiName: 'Task', count: 2 }]);
    expect(org.deletes).toEqual([]);
  });

  it('looks at the children of the run’s objects people work with, and at none of what the org keeps for itself', async () => {
    const org = tiedOrg();
    const listing = await listSweep(org, tiedInput());
    expect(listing.looked).toEqual(
      expect.arrayContaining(['Account', 'Contact', 'Case', 'Task', 'Asset', 'Opportunity']),
    );
    expect(listing.looked).not.toContain('AccountHistory');
    expect(listing.notLooked).toBeUndefined();
  });

  it('never lists the assignments a run’s mute made, even where the automation is said to create them', async () => {
    const org = tiedOrg();
    const listing = await listSweep(org, tiedInput({ leased: [id('0Pa', 1)] }));
    expect(NEVER_SWEPT).toContain('PermissionSetAssignment');
    expect(listing.looked).not.toContain('PermissionSetAssignment');
    expect(listing.found.map((found) => found.objectApiName)).not.toContain(
      'PermissionSetAssignment',
    );
    expect(org.queries.some((soql) => soql.includes('FROM PermissionSetAssignment'))).toBe(false);
  });

  it('ties a polymorphic lookup by the record’s first fifteen characters, whichever length the run kept', async () => {
    const org = tiedOrg();
    const fifteen = tiedInput(
      {},
      {
        created: [
          { objectApiName: 'Account', ids: [ACCOUNT.slice(0, 15)] },
          { objectApiName: 'Contact', ids: [CONTACT.slice(0, 15)] },
          { objectApiName: 'Case', ids: [CASE.slice(0, 15)] },
        ],
      },
    );
    const listing = await listSweep(org, fifteen);
    expect(listing.found.find((found) => found.objectApiName === 'Task')?.classes).toMatchObject({
      made: 2,
    });
  });

  it('names the objects past the bound it did not look at, and counts five a composite', async () => {
    const org = tiedOrg();
    const children = Array.from({ length: 320 }, (_, n) => `Child${n}__c`);
    for (const child of children) org.shape(child, {});
    org.shape('Account', {
      children: [
        ...(org.shapes.get('Account')?.children ?? []),
        ...children.map((childSObject) => ({ childSObject, field: 'Account__c' })),
      ],
    });
    const calls: number[] = [];
    const conn: CompositeQueryConnection = {
      version: '66.0',
      request: async (request) => {
        const body = JSON.parse(request.body ?? '{}') as {
          compositeRequest: Array<{ url: string; referenceId: string }>;
        };
        calls.push(body.compositeRequest.length);
        return {
          compositeResponse: body.compositeRequest.map((sub) => ({
            referenceId: sub.referenceId,
            httpStatusCode: 200,
            body: {
              totalSize: org.answer(decodeURIComponent(sub.url.replace(/^.*\?q=/, ''))).totalSize,
              done: true,
              records: [],
            },
          })),
        };
      },
      query: async () => {
        throw new Error('each count goes in a composite');
      },
      queryMore: async () => {
        throw new Error('a count has one page');
      },
    };
    org.counts = sweepCountsOf(compositeReader(conn));

    const listing = await listSweep(org, tiedInput());

    expect(SWEEP_LOOK_BOUND).toBe(300);
    expect(listing.looked).toHaveLength(SWEEP_LOOK_BOUND);
    const all = new Set([...listing.looked, ...(listing.notLooked ?? [])]);
    expect(listing.notLooked).toHaveLength(all.size - SWEEP_LOOK_BOUND);
    expect(listing.notLooked?.at(-1)).toBe('Child319__c');
    // Three hundred counts in sixty composites of five, none of them alone.
    expect(calls).toHaveLength(SWEEP_LOOK_BOUND / 5);
    expect(calls.every((subrequests) => subrequests === 5)).toBe(true);
    expect(org.queries.filter((soql) => soql.startsWith('SELECT COUNT()'))).toEqual([]);
    // What was found is listed all the same.
    expect(listing.found.map((found) => found.objectApiName)).toContain('Asset');
  });
});

describe('what a sweep takes', () => {
  it('keeps what is tied to nothing unasked, takes it when asked, and not while another run of this machine wrote in the window', async () => {
    const loose = id('00T', 3);
    let org = tiedOrg();
    const plain = await sweepRunRecords(org, tiedInput(), NO_SPANS);
    expect(plain.objects.find((o) => o.objectApiName === 'Task')).toMatchObject({ found: 2 });
    expect(deletedIds(org)).not.toContain(loose);
    expect(org.ids('Task')).toContain(loose);

    org = tiedOrg();
    await sweepRunRecords(org, tiedInput(), { ...NO_SPANS, sweepUntied: true });
    expect(deletedIds(org)).toContain(loose);

    // Another run of this machine, whose own task is never listed.
    org = tiedOrg();
    org.add('Task', rec(id('00T', 8), 'The other run’s', RUN_USER, at(35)));
    const others = { otherRuns: [{ ids: [id('00T', 8)] }] };
    const listing = await listSweep(org, tiedInput(others));
    expect(listing.untied?.refusal).toMatch(/^Another run of this machine wrote to the target/);
    expect(listing.untied?.objects).toEqual([{ objectApiName: 'Task', count: 2 }]);
    await sweepRunRecords(org, tiedInput(others), { ...NO_SPANS, sweepUntied: true });
    expect(deletedIds(org)).not.toContain(loose);
    expect(deletedIds(org)).not.toContain(id('00T', 8));
  });

  it('takes an asset the case’s flow linked though assets are hand work, and refuses only what is tied to nothing for one it did not', async () => {
    const org = tiedOrg();
    const listing = await listSweep(org, tiedInput());
    expect(listing.handWork).toEqual([]);
    expect(listing.untied?.refusal).toBeUndefined();
    expect(HAND_WORK_OBJECTS).toContain('Asset');

    // An asset hanging from nothing of the run, made in the run's window.
    org.add('Asset', rec(id('02i', 2), 'Typed by hand', RUN_USER, at(45)));
    const unlinked = await listSweep(org, tiedInput());
    expect(unlinked.handWork).toEqual([{ objectApiName: 'Asset', count: 1 }]);
    expect(unlinked.untied?.refusal).toMatch(/hand work/);
    expect(unlinked.refusal).toBeUndefined();
    expect(unlinked.found.find((found) => found.objectApiName === 'Asset')).toMatchObject({
      count: 1,
      classes: { made: 1 },
    });
    await sweepRunRecords(org, tiedInput(), { ...NO_SPANS, sweepUntied: true });
    expect(org.ids('Asset')).toContain(id('02i', 2));
    expect(org.ids('Task')).toContain(id('00T', 3));
  });

  it('takes what the Automated Process user made only when what came late is asked for', async () => {
    let org = tiedOrg();
    await sweepRunRecords(org, tiedInput(), NO_SPANS);
    expect(org.ids('Task')).toEqual(expect.arrayContaining([id('00T', 4), id('00T', 5)]));

    org = tiedOrg();
    await sweepRunRecords(org, tiedInput(), { ...NO_SPANS, sweepLate: true });
    expect(deletedIds(org)).toEqual(expect.arrayContaining([id('00T', 4), id('00T', 5)]));
    // A colleague's task on the run's case, and one on an account the run
    // only linked to, are never taken.
    expect(org.ids('Task')).toEqual(expect.arrayContaining([id('00T', 6), id('00T', 7)]));
  });

  it('deletes an asset a case of the run names only once the case is gone, never before', async () => {
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), NO_SPANS);

    expect(await parts.first()).toBe(true);
    // Before the run's records: only what neither goes with them nor waits.
    expect(deletedIds(org)).toEqual([id('00T', 2)]);
    expect([...parts.automationMade].sort()).toEqual(
      [id('00T', 1), id('00T', 2), id('0D5', 1), id('0D7', 1), id('02i', 1)].sort(),
    );
    expect([...parts.made].sort()).toEqual([...parts.automationMade].sort());

    // The removal deletes the run's records: the case takes its task, its
    // feed item and the comment on it along.
    await org.destroy('Case', [CASE]);
    await org.destroy('Contact', [CONTACT]);
    await org.destroy('Account', [ACCOUNT]);

    expect(await parts.afterRemoval()).toBe(true);
    const caseDeleted = org.deletes.findIndex((call) => call.object === 'Case');
    const assetDeleted = org.deletes.findIndex((call) => call.object === 'Asset');
    expect(assetDeleted).toBeGreaterThan(caseDeleted);
    expect(org.ids('Asset')).toEqual([]);
    const result = parts.result();
    expect(result.status).toBe('success');
    expect(result.objects.find((o) => o.objectApiName === 'Asset')).toMatchObject({
      found: 1,
      deleted: 1,
      afterRemoval: 1,
    });
    expect(result.objects.find((o) => o.objectApiName === 'FeedComment')).toMatchObject({
      deleted: 0,
      alreadyGone: 1,
    });
    // What is not the run's to take unasked stays, or went with the run's
    // records, never by the sweep's hand.
    expect(org.ids('Task')).toEqual([id('00T', 3), id('00T', 7)]);
    const swept = org.deletes.filter(
      (call) => !['Case', 'Contact', 'Account'].includes(call.object),
    );
    for (const kept of [3, 4, 5, 6, 7]) {
      expect(swept.flatMap((call) => call.ids)).not.toContain(id('00T', kept));
    }
  });

  it('counts gone, not refused, what the org refused that went with a record of the run, and ends a success', async () => {
    // Team Selling on, the org adds an opportunity's owner to its team as the
    // opportunity goes in, and its describe calls the lookup no cascade. Run
    // for real, the sweep's delete of that member, before the opportunity,
    // was refused; the opportunity then took it along, nothing was left, and
    // the sweep still said it refused one: the removal ended partial, exit 3.
    const org = tiedOrg();
    const opportunity = id('006', 1);
    const member = id('00q', 1);
    org.shape('Opportunity', {
      children: [{ childSObject: 'OpportunityTeamMember', field: 'OpportunityId' }],
    });
    org.shape('OpportunityTeamMember', { references: { OpportunityId: ['Opportunity'] } });
    org.add('Opportunity', recWith(opportunity, 'Cloned deal', RUN_USER, AT_CASE, {}));
    org.add(
      'OpportunityTeamMember',
      recWith(member, 'User User', RUN_USER, AT_CASE, { OpportunityId: opportunity }),
    );
    const destroy = org.destroy.bind(org);
    org.destroy = async (objectApiName: string, ids: string[]): Promise<unknown> => {
      if (objectApiName === 'OpportunityTeamMember') {
        org.deletes.push({ object: objectApiName, ids: [...ids] });
        return ids.map((recordId) => ({
          id: recordId,
          success: false,
          errors: [
            { statusCode: 'INVALID_CROSS_REFERENCE_KEY', message: 'invalid cross reference id' },
          ],
        }));
      }
      // The org takes the member along with its opportunity, whatever its
      // describe says of the lookup.
      const along = (org.rows.get('OpportunityTeamMember') ?? []).filter(
        (row) => objectApiName === 'Opportunity' && ids.includes(String(row.OpportunityId)),
      );
      const answer = await destroy(objectApiName, ids);
      org.rows.set(
        'OpportunityTeamMember',
        (org.rows.get('OpportunityTeamMember') ?? []).filter((row) => !along.includes(row)),
      );
      return answer;
    };
    const runInput = tiedInput(
      {},
      { created: [...tiedInput().created, { objectApiName: 'Opportunity', ids: [opportunity] }] },
    );
    const parts = sweepParts(org, runInput, NO_SPANS);

    await parts.first();
    expect(org.deletes.some((call) => call.object === 'OpportunityTeamMember')).toBe(true);
    await org.destroy('Opportunity', [opportunity]);
    await org.destroy('Case', [CASE]);
    await org.destroy('Contact', [CONTACT]);
    await org.destroy('Account', [ACCOUNT]);
    await parts.afterRemoval();

    expect(org.ids('OpportunityTeamMember')).toEqual([]);
    const result = parts.result();
    expect(result.objects.find((o) => o.objectApiName === 'OpportunityTeamMember')).toMatchObject({
      found: 1,
      deleted: 0,
      alreadyGone: 1,
      refused: 0,
      reasons: [],
    });
    expect(result.status).toBe('success');
  });

  it('keeps refused, in the org’s words, what it refused that is still there once the removal ended', async () => {
    const org = tiedOrg();
    org.refusals.set(id('00T', 2), 'W47 gate: this task cannot be deleted.');
    const parts = sweepParts(org, tiedInput(), NO_SPANS);

    await parts.first();
    await org.destroy('Case', [CASE]);
    await org.destroy('Contact', [CONTACT]);
    await org.destroy('Account', [ACCOUNT]);
    await parts.afterRemoval();

    expect(org.ids('Task')).toContain(id('00T', 2));
    expect(parts.result().objects.find((o) => o.objectApiName === 'Task')).toMatchObject({
      refused: 1,
      reasons: ['DELETE_FAILED: W47 gate: this task cannot be deleted.'],
    });
  });

  it('says the asset the org refused while the case that names it stays, in the org’s words', async () => {
    const org = tiedOrg();
    const result = await sweepRunRecords(org, tiedInput(), NO_SPANS);
    expect(org.ids('Asset')).toEqual([id('02i', 1)]);
    expect(result.status).toBe('partial');
    expect(result.objects.find((o) => o.objectApiName === 'Asset')).toMatchObject({
      deleted: 0,
      refused: 1,
      reasons: [expect.stringMatching(/^DELETE_FAILED: .*associated with the following cases/)],
    });
  });

  it('keeps what someone changed since, out of what the removal is told goes along', async () => {
    const org = tiedOrg();
    const task = org.row('Task', id('00T', 1));
    if (task) Object.assign(task, { LastModifiedDate: LONG_AFTER, LastModifiedById: COLLEAGUE });

    const listing = await listSweep(org, tiedInput());
    expect(listing.found[0]?.classes).toMatchObject({
      made: 2,
      changed: 1,
      changedIn: { made: 1 },
    });

    const parts = sweepParts(org, tiedInput(), NO_SPANS);
    await parts.first();
    expect(parts.automationMade.has(id('00T', 1))).toBe(false);
    expect(parts.result().objects.find((o) => o.objectApiName === 'Task')).toMatchObject({
      keptChanged: 1,
    });
  });

  it('says left only what the org still holds once the run’s records went, the rest gone along with them', async () => {
    // Run for real on the trap org: "left, made late: DuplicateRecordItem: 25"
    // once the removal was through, of items the org had deleted with their
    // contacts.
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), NO_SPANS);
    await parts.first();
    const lateBefore = parts.result().left?.find((kept) => kept.class === 'late');
    expect(lateBefore?.objects).toEqual([{ objectApiName: 'Task', count: 2 }]);

    // The removal deletes the case: the org takes along the task its
    // Automated Process made under it, and keeps the call on the contact.
    await org.destroy('Case', [CASE]);
    await parts.afterRemoval();

    const result = parts.result();
    expect(result.left?.find((kept) => kept.class === 'late')?.objects).toEqual([
      { objectApiName: 'Task', count: 1 },
    ]);
    expect(result.goneAlong).toEqual([
      { class: 'late', objects: [{ objectApiName: 'Task', count: 1 }] },
    ]);
    expect(org.ids('Task')).toContain(id('00T', 4));
    expect(org.ids('Task')).not.toContain(id('00T', 5));
    // What is tied to nothing stays, and is said left.
    expect(result.left?.find((kept) => kept.class === 'untied')).toBeDefined();
  });

  it('names as gone what it deleted and what it said went along, never what it left', async () => {
    // Run for real on the trap org: the mapping kept as made late the 25
    // duplicate record items the same removal said no longer in the org.
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), NO_SPANS);
    await parts.first();
    await org.destroy('Case', [CASE]);
    await parts.afterRemoval();

    expect(parts.result().goneAlong).toEqual([
      { class: 'late', objects: [{ objectApiName: 'Task', count: 1 }] },
    ]);
    // The Automated Process's task went with the case; the account review
    // the sweep deleted; the call on the contact and the loose task stay.
    expect(parts.gone.has(id('00T', 5))).toBe(true);
    expect(parts.gone.has(id('00T', 2))).toBe(true);
    expect(parts.gone.has(id('00T', 4))).toBe(false);
    expect(parts.gone.has(id('00T', 3))).toBe(false);
    for (const left of parts.gone) expect(org.ids('Task')).not.toContain(left);
  });

  it('says nothing left of a class whose records all went along, and ends a success it was asked to take', async () => {
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), NO_SPANS);
    await parts.first();
    // The account goes last, its contact and its case with it, and every
    // task under them.
    await org.destroy('Case', [CASE]);
    await org.destroy('Contact', [CONTACT]);
    await parts.afterRemoval();

    const result = parts.result();
    expect(result.left?.map((kept) => kept.class)).not.toContain('late');
    expect(result.goneAlong).toEqual([
      { class: 'late', objects: [{ objectApiName: 'Task', count: 2 }] },
    ]);
  });

  it('leaves said left what it could not read back', async () => {
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), NO_SPANS);
    await parts.first();
    await org.destroy('Case', [CASE]);
    const query = org.query.bind(org);
    vi.spyOn(org, 'query').mockImplementation(async (soql: string) => {
      if (/^SELECT Id FROM Task WHERE Id IN /.test(soql)) throw new Error('REQUEST_LIMIT_EXCEEDED');
      return query(soql);
    });
    await parts.afterRemoval();

    const result = parts.result();
    expect(result.left?.find((kept) => kept.class === 'late')?.objects).toEqual([
      { objectApiName: 'Task', count: 2 },
    ]);
    expect(result.goneAlong).toBeUndefined();
  });

  it('counts as changed since, by class, a record the run’s own user changed after the run, which the sweep keeps', async () => {
    // Run for real on the trap org: a follow-up task the run's user edited
    // after the load was listed among what --sweep-untied deletes, "changed
    // since by someone else", and the reload kept it.
    const org = tiedOrg();
    const task = org.row('Task', id('00T', 3));
    if (task) Object.assign(task, { LastModifiedDate: LONG_AFTER, LastModifiedById: RUN_USER });

    const listing = await listSweep(org, tiedInput());
    const classes = listing.found.find((found) => found.objectApiName === 'Task')?.classes;
    expect(classes?.changed).toBe(1);
    expect(classes?.changedIn).toEqual({ untied: 1 });

    const parts = sweepParts(org, tiedInput(), { ...NO_SPANS, sweepUntied: true });
    await parts.first();
    expect(parts.automationMade.has(id('00T', 3))).toBe(false);
  });

  it('counts as changed since a record the run’s user changed within the minute after the run’s last write, which no sweep takes unasked', async () => {
    // Run for real on the trap org: a follow-up task the load's user edited
    // 48 seconds after the load, inside the minute the window reads after its
    // last write, was listed among what --sweep-untied would delete, unchanged.
    const org = tiedOrg();
    const task = org.row('Task', id('00T', 3));
    const edited = new Date(Date.parse(LAST_WRITE) + 48_000).toISOString().replace('Z', '+0000');
    if (task) Object.assign(task, { LastModifiedDate: edited, LastModifiedById: RUN_USER });

    const listing = await listSweep(org, tiedInput());
    const classes = listing.found.find((found) => found.objectApiName === 'Task')?.classes;
    expect(classes?.changed).toBe(1);
    expect(classes?.changedIn).toEqual({ untied: 1 });

    const result = await sweepRunRecords(org, tiedInput(), { ...NO_SPANS, sweepUntied: true });
    expect(deletedIds(org)).not.toContain(id('00T', 3));
    expect(org.ids('Task')).toContain(id('00T', 3));
    expect(result.objects.find((o) => o.objectApiName === 'Task')).toMatchObject({
      keptChanged: 1,
    });

    // Asked, it goes.
    await sweepRunRecords(org, tiedInput(), {
      ...NO_SPANS,
      sweepUntied: true,
      includeChanged: true,
    });
    expect(org.ids('Task')).not.toContain(id('00T', 3));
  });

  it('reads no change in what the automation wrote in the save of the run’s last write, nor in the save that created a record', async () => {
    const org = tiedOrg();
    const sameSave = (seconds: number): string =>
      new Date(Date.parse(LAST_WRITE) + seconds * 1000).toISOString().replace('Z', '+0000');
    // The case's task, updated by a flow as the run's last record was saved.
    const followUp = org.row('Task', id('00T', 1));
    if (followUp) Object.assign(followUp, { LastModifiedDate: sameSave(1) });
    // A task a queued job opened after the last write, set in the save that made it.
    org.add('Task', recWith(id('00T', 8), 'Async check', RUN_USER, sameSave(20), { WhatId: CASE }));
    const late = org.row('Task', id('00T', 8));
    if (late) Object.assign(late, { LastModifiedDate: sameSave(21) });

    const listing = await listSweep(org, tiedInput());
    const classes = listing.found.find((found) => found.objectApiName === 'Task')?.classes;
    expect(classes?.changed).toBeUndefined();
    expect(classes).toMatchObject({ made: 2, late: 3 });
  });

  it('reads the ties before its first delete, and keeps for made what an earlier sweep found once a removal cleared the lookup that told it', async () => {
    const org = tiedOrg();
    // A removal with no sweep took the account: the org cleared the task's
    // AccountId with it.
    await org.destroy('Case', [CASE]);
    await org.destroy('Contact', [CONTACT]);
    await org.destroy('Account', [ACCOUNT]);
    expect(org.row('Task', id('00T', 2))?.AccountId).toBeNull();

    const after = await listSweep(org, tiedInput());
    expect(after.untied?.objects).toEqual([{ objectApiName: 'Task', count: 3 }]);

    const kept = await listSweep(org, tiedInput({ madeEarlier: [id('00T', 2)] }));
    expect(kept.found.find((found) => found.objectApiName === 'Task')?.classes).toMatchObject({
      made: 1,
      untied: 2,
    });
  });

  it('keeps one order: its reads, then its question, then its writes, the run’s own removal between its two parts', async () => {
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), {
      ...NO_SPANS,
      approve: async () => {
        org.events.push('question');
        return undefined;
      },
    });
    await parts.first();
    await org.destroy('Case', [CASE]);
    await parts.afterRemoval();
    org.events.push('result');

    expect(writePathOrderDefects(org.events)).toEqual([]);
    // No read between the question and its last delete: what it deletes is
    // what was shown. Once it is through, it reads back what it left, which
    // deletes nothing.
    const asked = org.events.indexOf('question');
    const lastWrite = org.events.lastIndexOf('write');
    expect(org.events.slice(asked, lastWrite)).not.toContain('reads');
    expect(org.events.slice(lastWrite).filter((step) => step === 'write')).toHaveLength(1);
    expect(org.events.filter((step) => step === 'question')).toHaveLength(1);
    expect(org.events.filter((step) => step === 'write')).toHaveLength(org.deletes.length);
    // It assigns nothing, takes no checkpoint and holds no lease.
    expect(org.deletes.some((call) => call.object === 'PermissionSetAssignment')).toBe(false);
    expect(org.events).not.toContain('leaseAcquire');
    expect(org.events).not.toContain('checkpointTake');
  });

  it('reads and asks at `ask`, once, deleting nothing, and deletes at its first part without asking again', async () => {
    const org = tiedOrg();
    const approve = vi.fn(async () => undefined);
    const parts = sweepParts(org, tiedInput(), { ...NO_SPANS, approve });

    await parts.ask();
    await parts.ask();

    expect(approve).toHaveBeenCalledTimes(1);
    expect(org.deletes).toEqual([]);
    expect(parts.automationMade.size).toBe(0);
    const readsWhenAsked = org.queries.length;

    expect(await parts.first()).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(deletedIds(org)).toEqual([id('00T', 2)]);
    // What it deletes is what was shown: nothing more is read of the org.
    expect(org.queries.length).toBe(readsWhenAsked);
  });

  it('makes `ask` itself when its first part is called alone, and deletes nothing a refusal stopped', async () => {
    const org = tiedOrg();
    const approve = vi.fn(async () => 'Operation cancelled by user (confirmation declined).');
    const parts = sweepParts(org, tiedInput(), { ...NO_SPANS, approve });

    expect(await parts.first()).toBe(false);
    expect(await parts.afterRemoval()).toBe(false);

    expect(approve).toHaveBeenCalledTimes(1);
    expect(org.deletes).toEqual([]);
    expect(parts.result()).toMatchObject({
      status: 'refused',
      refusal: 'Operation cancelled by user (confirmation declined).',
    });
  });

  it('keeps what it found made for the run, and made late, whatever its question is answered', async () => {
    // Refused, it kept nothing: a reload's purge then took the records they
    // were tied to, and the next sweep found them tied to nothing.
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), { ...NO_SPANS, approve: async () => 'Declined.' });

    await parts.ask();

    expect(org.deletes).toEqual([]);
    expect([...parts.made]).toContain(id('00T', 1));
    expect([...parts.late].sort()).toEqual([id('00T', 4), id('00T', 5)].sort());
  });

  it('reads as cancelled when it was asked and the removal never reached its first part', async () => {
    const org = tiedOrg();
    const parts = sweepParts(org, tiedInput(), NO_SPANS);

    await parts.ask();

    expect(parts.result()).toMatchObject({ status: 'cancelled', objects: [] });
  });

  it('shows what it found once asked, what it keeps included, for a sweep that takes nothing to say so', async () => {
    const org = new TiedOrg();
    org.shape('Account', { children: [] });
    org.add('Account', rec(ACCOUNT, 'Run account', RUN_USER, at(1)));
    org.shape('Task', {});
    org.add('Task', rec(id('00T', 3), 'Loose', RUN_USER, at(30)));
    const parts = sweepParts(
      org,
      tiedInput({}, { created: [{ objectApiName: 'Account', ids: [ACCOUNT] }] }),
      NO_SPANS,
    );

    expect(parts.listing).toBeUndefined();
    expect(await parts.first()).toBe(false);

    expect(org.deletes).toEqual([]);
    expect(parts.result().objects).toEqual([]);
    expect(parts.listing?.untied).toEqual({ objects: [{ objectApiName: 'Task', count: 1 }] });
  });

  it('counts a run whose records could not be named for what is tied to nothing', async () => {
    const loose = id('00T', 3);
    const org = tiedOrg();
    const unnamed = { otherRuns: [{ ids: [], idsUntold: true as const }] };

    const listing = await listSweep(org, tiedInput(unnamed));
    expect(listing.untied?.refusal).toMatch(/^Another run of this machine wrote to the target/);

    await sweepRunRecords(org, tiedInput(unnamed), { ...NO_SPANS, sweepUntied: true });
    expect(deletedIds(org)).not.toContain(loose);
    // Told no name, a run with no record is none of them.
    const none = await listSweep(tiedOrg(), tiedInput({ otherRuns: [{ ids: [] }] }));
    expect(none.untied?.refusal).toBeUndefined();
  });

  it('takes what the update flows opened under the records a Sync run only wrote over, as made over', async () => {
    const org = tiedOrg();
    const updated = id('003', 5);
    org.add('Contact', rec(updated, 'Updated contact', COLLEAGUE, BEFORE));
    org.add(
      'Task',
      recWith(id('00T', 9), 'Updated: call back', RUN_USER, at(10), { WhoId: updated }),
    );
    const onlyOver = tiedInput(
      { writtenOver: [{ objectApiName: 'Contact', ids: [updated] }] },
      { created: [], remap: new Set([updated.slice(0, 15)]) },
    );

    const listing = await listSweep(org, onlyOver);
    expect(listing.refusal).toBeUndefined();
    expect(listing.found.find((found) => found.objectApiName === 'Task')?.classes).toMatchObject({
      made: 0,
      madeOver: 1,
    });

    await sweepRunRecords(org, onlyOver, NO_SPANS);
    expect(deletedIds(org)).toEqual([id('00T', 9)]);
    expect(org.ids('Contact')).toContain(updated);
  });
});
