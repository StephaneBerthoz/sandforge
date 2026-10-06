import { describe, expect, it, vi } from 'vitest';
import type { ForgeRunVerification } from '@sandforge/shared';
import {
  RunVerifier,
  verificationTotals,
  writtenWithoutByObject,
  type RunToVerify,
  type SourceOrg,
  type VerifiedOrg,
} from './RunVerifier.js';

/** A fake target id: the object's prefix, then a counter. */
const tid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
/** A fake source id, of the same shape. */
const sid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

/** The target's date of the run's last stamp. */
const RUN_END = '2026-10-01T10:00:00.000Z';
const BEFORE_END = '2026-10-01T09:59:58.000+0000';
const AFTER_END = '2026-10-01T10:05:00.000+0000';
const RUN_USER = '005000000000001AAA';
const OTHER_USER = '005000000000002AAA';

/** One object of a fake org: its fields, its rows, and what is no longer there. */
interface FakeTable {
  fields: Array<{ name: string; type: string; createable?: boolean; updateable?: boolean }>;
  rows: Map<string, Record<string, unknown>>;
  /** Ids in the recycle bin. */
  deleted?: Set<string>;
  /** Columns the org refuses to read on this object. */
  refused?: string[];
  /** Whether a `queryAll` of it is refused. */
  binRefused?: boolean;
}

/** What a fake org was asked. */
interface Asked {
  queries: string[];
  queryAlls: string[];
}

/**
 * An org answering the queries a verification sends — `SELECT cols FROM obj
 * WHERE Id IN (…)` — from its tables, a row with the columns asked.
 */
function fakeOrg(tables: Record<string, FakeTable>): VerifiedOrg & SourceOrg & { asked: Asked } {
  const asked: Asked = { queries: [], queryAlls: [] };
  const answer = (soql: string, all: boolean) => {
    const match = /^SELECT (.+) FROM (\w+) WHERE Id IN \((.*)\)$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, cols, object, list] = match;
    const table = tables[object];
    if (!table) throw new Error(`INVALID_TYPE: sObject type '${object}' is not supported.`);
    if (all && table.binRefused) throw new Error('INVALID_FIELD: No such column IsDeleted');
    const columns = cols.split(', ');
    const refused = columns.find((c) => table.refused?.includes(c));
    if (refused) throw new Error(`INVALID_FIELD: No such column '${refused}'`);
    const ids = list.split(', ').map((quoted) => quoted.slice(1, -1));
    const records = ids.flatMap((id) => {
      const inBin = table.deleted?.has(id) === true;
      const row = table.rows.get(id);
      if (!row || (inBin && !all)) return [];
      const picked: Record<string, unknown> = { attributes: { type: object } };
      for (const c of columns) picked[c] = c === 'IsDeleted' ? inBin : (row[c] ?? null);
      return [picked];
    });
    return { totalSize: records.length, records };
  };
  return {
    asked,
    query: vi.fn(async (soql: string) => {
      asked.queries.push(soql);
      return answer(soql, false);
    }),
    queryAll: vi.fn(async (soql: string) => {
      asked.queryAlls.push(soql);
      return answer(soql, true);
    }),
    describe: vi.fn(async (name: string) => {
      const table = tables[name];
      if (!table) throw new Error(`INVALID_TYPE: ${name}`);
      return {
        name,
        label: name,
        fields: table.fields.map((f) => ({ label: f.name, ...f })),
      };
    }),
  };
}

const ACCOUNT_FIELDS = [
  { name: 'Id', type: 'id' },
  { name: 'Name', type: 'string', createable: true, updateable: true },
  { name: 'ParentId', type: 'reference', createable: true, updateable: true },
  { name: 'OwnerId', type: 'reference', createable: true, updateable: true },
];
const CONTACT_FIELDS = [
  { name: 'Id', type: 'id' },
  { name: 'LastName', type: 'string', createable: true, updateable: true },
  { name: 'AccountId', type: 'reference', createable: true, updateable: true },
  { name: 'ReportsToId', type: 'reference', createable: true, updateable: true },
  { name: 'MasterRecordId', type: 'reference' },
];

/** A row of the target, last modified before the run ended. */
function targetRow(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: id,
    LastModifiedDate: BEFORE_END,
    LastModifiedById: RUN_USER,
    SystemModstamp: BEFORE_END,
    ...fields,
  };
}

/**
 * A run that created an account and two contacts under it, linked to an
 * account the target already held as the account's parent.
 */
function scenario() {
  const target = fakeOrg({
    Account: {
      fields: ACCOUNT_FIELDS,
      rows: new Map([[tid('001', 1), targetRow(tid('001', 1), { ParentId: tid('001', 9) })]]),
    },
    Contact: {
      fields: CONTACT_FIELDS,
      rows: new Map([
        [tid('003', 1), targetRow(tid('003', 1), { AccountId: tid('001', 1) })],
        [
          tid('003', 2),
          targetRow(tid('003', 2), { AccountId: tid('001', 1), ReportsToId: tid('003', 1) }),
        ],
      ]),
    },
  });
  const source = fakeOrg({
    Account: {
      fields: ACCOUNT_FIELDS,
      rows: new Map([
        [sid('001', 1), { Id: sid('001', 1), ParentId: sid('001', 9), OwnerId: RUN_USER }],
      ]),
    },
    Contact: {
      fields: CONTACT_FIELDS,
      rows: new Map([
        [sid('003', 1), { Id: sid('003', 1), AccountId: sid('001', 1) }],
        [
          sid('003', 2),
          { Id: sid('003', 2), AccountId: sid('001', 1), ReportsToId: sid('003', 1) },
        ],
      ]),
    },
  });
  const run: RunToVerify = {
    records: [
      { objectApiName: 'Contact', ids: [tid('003', 2), tid('003', 1)] },
      { objectApiName: 'Account', ids: [tid('001', 1)] },
    ],
    remapTable: {
      [sid('001', 1)]: tid('001', 1),
      [sid('001', 9)]: tid('001', 9),
      [sid('003', 1)]: tid('003', 1),
      [sid('003', 2)]: tid('003', 2),
    },
    runEndedAt: new Date(RUN_END),
  };
  return { target, source, run };
}

const NO_WAIT = { sleep: async () => undefined, now: () => new Date('2026-10-01T11:00:00.000Z') };

function objectOf(verification: ForgeRunVerification, name: string) {
  const object = verification.objects.find((o) => o.objectApiName === name);
  if (!object) throw new Error(`no ${name} in the verification`);
  return object;
}

describe('RunVerifier', () => {
  it('verifies a run whose records are all there and whose lookups point at the ids its parents got', async () => {
    const { target, source, run } = scenario();
    const verification = await new RunVerifier({ target, source }).verify(run, NO_WAIT);

    expect(verification.verdict).toBe('verified');
    expect(verification.attempts).toBe(2);
    expect(verification.verifiedAt).toBe('2026-10-01T11:00:00.000Z');
    expect(verification.linksUnchecked).toBeUndefined();
    expect(objectOf(verification, 'Contact')).toMatchObject({
      expected: 2,
      present: 2,
      deleted: 0,
      notVisible: 0,
      changed: 0,
      linksChecked: 3,
      linksBroken: 0,
    });
    // The account's parent, a record the target already held, is one the run
    // mapped: its lookup is checked too; its owner, a user, was never mapped.
    expect(objectOf(verification, 'Account')).toMatchObject({ linksChecked: 1, linksBroken: 0 });
  });

  it('tells a record in the recycle bin from one out of sight, and never takes the second for deleted', async () => {
    const { target, source, run } = scenario();
    const contacts = run.records[0];
    const gone = tid('003', 3);
    const binned = tid('003', 4);
    const table = {
      fields: CONTACT_FIELDS,
      rows: new Map([
        [tid('003', 1), targetRow(tid('003', 1), { AccountId: tid('001', 1) })],
        [binned, targetRow(binned)],
      ]),
      deleted: new Set([binned]),
    };
    const withBin = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([[tid('001', 1), targetRow(tid('001', 1))]]),
      },
      Contact: table,
    });
    const verification = await new RunVerifier({ target: withBin, source }).verify(
      { ...run, records: [{ ...contacts, ids: [tid('003', 1), gone, binned] }] },
      NO_WAIT,
    );

    expect(verification.verdict).toBe('partial');
    expect(objectOf(verification, 'Contact')).toMatchObject({
      expected: 3,
      present: 1,
      deleted: 1,
      deletedIds: [binned],
      notVisible: 1,
      notVisibleIds: [gone],
    });
    // Once a reading, for the records it did not read back alone.
    const lookedFor = `SELECT Id, IsDeleted FROM Contact WHERE Id IN ('${gone}', '${binned}')`;
    expect(withBin.asked.queryAlls).toEqual([lookedFor, lookedFor]);
    expect(target.asked.queryAlls).toEqual([]);
  });

  it('counts the records it could not look for in the recycle bin as out of sight, and says why', async () => {
    const { source, run } = scenario();
    const org = fakeOrg({
      Contact: { fields: CONTACT_FIELDS, rows: new Map(), binRefused: true },
    });
    const verification = await new RunVerifier({ target: org, source }).verify(
      { ...run, records: [run.records[0]] },
      NO_WAIT,
    );

    expect(objectOf(verification, 'Contact')).toMatchObject({
      present: 0,
      deleted: 0,
      notVisible: 2,
      recycleBinUnread: 'INVALID_FIELD: No such column IsDeleted',
    });
  });

  it('reads the records back two hundred ids a query', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => tid('001', i + 1));
    const org = fakeOrg({
      Account: { fields: ACCOUNT_FIELDS, rows: new Map(ids.map((id) => [id, targetRow(id)])) },
    });
    const verification = await new RunVerifier({
      target: org,
      source: { unavailable: 'not kept' },
    }).verify(
      {
        records: [{ objectApiName: 'Account', ids }],
        remapTable: {},
        runEndedAt: new Date(RUN_END),
      },
      NO_WAIT,
    );

    expect(objectOf(verification, 'Account').present).toBe(450);
    const firstReading = org.asked.queries.slice(0, 3);
    expect(firstReading.map((q) => q.split("', '").length)).toEqual([200, 200, 50]);
    expect(org.asked.queries).toHaveLength(6);
  });

  it('names a lookup that points elsewhere than the run set it, and one left empty', async () => {
    const { source, run } = scenario();
    const moved = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([[tid('001', 1), targetRow(tid('001', 1), { ParentId: tid('001', 9) })]]),
      },
      Contact: {
        fields: CONTACT_FIELDS,
        rows: new Map([
          [tid('003', 1), targetRow(tid('003', 1), { AccountId: tid('001', 7) })],
          [tid('003', 2), targetRow(tid('003', 2), { AccountId: tid('001', 1) })],
        ]),
      },
    });
    const verification = await new RunVerifier({ target: moved, source }).verify(run, NO_WAIT);

    expect(verification.verdict).toBe('partial');
    const contact = objectOf(verification, 'Contact');
    expect(contact.linksChecked).toBe(3);
    expect(contact.linksBroken).toBe(2);
    expect(contact.brokenLinks).toEqual(
      expect.arrayContaining([
        {
          recordId: tid('003', 1),
          field: 'AccountId',
          expected: tid('001', 1),
          found: tid('001', 7),
        },
        { recordId: tid('003', 2), field: 'ReportsToId', expected: tid('003', 1), found: null },
      ]),
    );
  });

  it('leaves out of the check a lookup the run was told to leave out, and one it wrote rows again without', async () => {
    const { source, run } = scenario();
    const emptied = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([[tid('001', 1), targetRow(tid('001', 1), { ParentId: tid('001', 9) })]]),
      },
      Contact: {
        fields: CONTACT_FIELDS,
        rows: new Map([
          [tid('003', 1), targetRow(tid('003', 1))],
          [tid('003', 2), targetRow(tid('003', 2), { AccountId: tid('001', 1) })],
        ]),
      },
    });
    const verification = await new RunVerifier({ target: emptied, source }).verify(
      {
        ...run,
        fieldExclusions: { Contact: ['ReportsToId'] },
        writtenWithout: writtenWithoutByObject([
          { objectApiName: 'Contact', fields: [{ field: 'AccountId' }] },
        ]),
      },
      NO_WAIT,
    );

    expect(verification.verdict).toBe('verified');
    expect(objectOf(verification, 'Contact')).toMatchObject({ linksChecked: 1, linksBroken: 0 });
  });

  it('checks a lookup the run wrote under another name in the target under that name', async () => {
    const { source, run } = scenario();
    const renamed = fakeOrg({
      Contact: {
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Company__c', type: 'reference', createable: true, updateable: true },
        ],
        rows: new Map([
          [tid('003', 1), targetRow(tid('003', 1), { Company__c: tid('001', 1) })],
          [tid('003', 2), targetRow(tid('003', 2), { Company__c: tid('001', 9) })],
        ]),
      },
    });
    const verification = await new RunVerifier({ target: renamed, source }).verify(
      {
        ...run,
        records: [run.records[0]],
        fieldMappings: { Contact: { AccountId: 'Company__c' } },
      },
      NO_WAIT,
    );

    const contact = objectOf(verification, 'Contact');
    expect(contact.linksChecked).toBe(2);
    expect(contact.brokenLinks).toEqual([
      {
        recordId: tid('003', 2),
        field: 'Company__c',
        expected: tid('001', 1),
        found: tid('001', 9),
      },
    ]);
  });

  it('checks the lookups of a sample of each object, twenty records by default', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    const target = fakeOrg({
      Contact: {
        fields: CONTACT_FIELDS,
        rows: new Map(
          ids.map((n) => [tid('003', n), targetRow(tid('003', n), { AccountId: tid('001', 1) })]),
        ),
      },
    });
    const source = fakeOrg({
      Contact: {
        fields: CONTACT_FIELDS,
        rows: new Map(
          ids.map((n) => [sid('003', n), { Id: sid('003', n), AccountId: sid('001', 1) }]),
        ),
      },
    });
    const verification = await new RunVerifier({ target, source }).verify(
      {
        records: [{ objectApiName: 'Contact', ids: ids.map((n) => tid('003', n)) }],
        remapTable: Object.fromEntries([
          [sid('001', 1), tid('001', 1)],
          ...ids.map((n) => [sid('003', n), tid('003', n)]),
        ]),
        runEndedAt: new Date(RUN_END),
      },
      NO_WAIT,
    );

    expect(objectOf(verification, 'Contact').linksChecked).toBe(20);
    expect(source.asked.queries).toHaveLength(1);
  });

  it('lists the records modified since the run, with who did, and keeps the verdict on what is there', async () => {
    const { source, run } = scenario();
    const touched = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([
          [
            tid('001', 1),
            targetRow(tid('001', 1), {
              ParentId: tid('001', 9),
              LastModifiedDate: AFTER_END,
              LastModifiedById: OTHER_USER,
            }),
          ],
        ]),
      },
      Contact: {
        fields: CONTACT_FIELDS,
        rows: new Map([
          [tid('003', 1), targetRow(tid('003', 1), { AccountId: tid('001', 1) })],
          [
            tid('003', 2),
            targetRow(tid('003', 2), {
              AccountId: tid('001', 1),
              ReportsToId: tid('003', 1),
              LastModifiedDate: AFTER_END,
            }),
          ],
        ]),
      },
    });
    const verification = await new RunVerifier({ target: touched, source }).verify(
      // What a removal of the run left on the contact, once it gave it back:
      // its doing, not a change since the run.
      { ...run, removalStamps: { [tid('003', 2)]: AFTER_END } },
      NO_WAIT,
    );

    expect(verification.verdict).toBe('verified');
    expect(objectOf(verification, 'Account')).toMatchObject({
      changed: 1,
      changedRecords: [
        { recordId: tid('001', 1), modifiedAt: AFTER_END, modifiedById: OTHER_USER },
      ],
    });
    expect(objectOf(verification, 'Contact').changed).toBe(0);
  });

  it('dates a run the target did not date by when it was recorded, read on the org clock', async () => {
    const { source, run } = scenario();
    // The org runs five minutes ahead: a record modified a minute after the
    // run was recorded on this machine reads, on the org's clock, as written
    // during it.
    const recorded = new Date(Date.now() - 60 * 60_000);
    const orgAhead = 5 * 60_000;
    const modified = new Date(recorded.getTime() + orgAhead + 60_000).toISOString();
    const org = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([[tid('001', 1), targetRow(tid('001', 1), { LastModifiedDate: modified })]]),
      },
    });
    org.serverTime = async () => new Date(Date.now() + orgAhead).toISOString();
    const verification = await new RunVerifier({ target: org, source }).verify(
      { ...run, records: [run.records[1]], runEndedAt: undefined, runRecordedAt: recorded },
      NO_WAIT,
    );
    expect(objectOf(verification, 'Account').changed).toBe(1);

    org.serverTime = async () => new Date(Date.now()).toISOString();
    const late = new Date(recorded.getTime() + 5_000).toISOString();
    const quiet = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([[tid('001', 1), targetRow(tid('001', 1), { LastModifiedDate: late })]]),
      },
    });
    const within = await new RunVerifier({ target: quiet, source }).verify(
      { ...run, records: [run.records[1]], runEndedAt: undefined, runRecordedAt: recorded },
      NO_WAIT,
    );
    expect(objectOf(within, 'Account').changed).toBe(0);
  });

  it('pauses before the first reading, and reads again until two readings agree', async () => {
    const { target, source, run } = scenario();
    const events: string[] = [];
    const sleep = vi.fn(async (ms: number) => {
      events.push(`sleep ${ms}`);
    });
    const query = target.query;
    target.query = async (soql) => {
      events.push('query');
      return query(soql);
    };
    const verification = await new RunVerifier({ target, source }).verify(run, {
      sleep,
      intervalMs: 1_500,
    });

    expect(verification.attempts).toBe(2);
    expect(events[0]).toBe('sleep 1500');
    expect(events.filter((e) => e.startsWith('sleep'))).toHaveLength(2);
  });

  it('says unstable when no two readings agree within the attempts, as a flow still writing would leave them', async () => {
    const { source, run } = scenario();
    let stamp = Date.parse(AFTER_END);
    const rows = new Map([[tid('001', 1), targetRow(tid('001', 1), { ParentId: tid('001', 9) })]]);
    const moving = fakeOrg({ Account: { fields: ACCOUNT_FIELDS, rows } });
    const query = moving.query;
    moving.query = async (soql) => {
      stamp += 1_000;
      rows.set(tid('001', 1), {
        ...rows.get(tid('001', 1)),
        LastModifiedDate: new Date(stamp).toISOString(),
      });
      return query(soql);
    };
    const verification = await new RunVerifier({ target: moving, source }).verify(
      { ...run, records: [run.records[1]] },
      NO_WAIT,
    );

    expect(verification.verdict).toBe('unstable');
    expect(verification.attempts).toBe(3);
    expect(objectOf(verification, 'Account').changed).toBe(1);
  });

  it('checks no lookup when the org the run read from cannot be read, and says why', async () => {
    const { target, run } = scenario();
    const verification = await new RunVerifier({
      target,
      source: { unavailable: 'The org this run read from is no longer registered.' },
    }).verify(run, NO_WAIT);

    expect(verification.verdict).toBe('partial');
    expect(verification.linksUnchecked).toBe('The org this run read from is no longer registered.');
    expect(objectOf(verification, 'Contact')).toMatchObject({ present: 2, linksChecked: 0 });
  });

  it('says why an object could not be read, and judges nothing of it', async () => {
    const { source, run } = scenario();
    const org = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([[tid('001', 1), targetRow(tid('001', 1), { ParentId: tid('001', 9) })]]),
      },
    });
    const verification = await new RunVerifier({ target: org, source }).verify(run, NO_WAIT);

    expect(verification.verdict).toBe('partial');
    expect(objectOf(verification, 'Contact').error).toBe(
      "INVALID_TYPE: sObject type 'Contact' is not supported.",
    );
    expect(objectOf(verification, 'Account').present).toBe(1);
  });

  it('reads an object that keeps no LastModifiedDate by its system stamp', async () => {
    const { source, run } = scenario();
    const org = fakeOrg({
      Account: {
        fields: ACCOUNT_FIELDS,
        rows: new Map([
          [
            tid('001', 1),
            targetRow(tid('001', 1), { ParentId: tid('001', 9), SystemModstamp: AFTER_END }),
          ],
        ]),
        refused: ['LastModifiedDate'],
      },
    });
    const verification = await new RunVerifier({ target: org, source }).verify(
      { ...run, records: [run.records[1]] },
      NO_WAIT,
    );

    expect(objectOf(verification, 'Account')).toMatchObject({
      present: 1,
      changed: 1,
      changedRecords: [{ recordId: tid('001', 1), modifiedAt: AFTER_END }],
    });
  });

  it('adds up a verification for the audit trail, counts only', async () => {
    const { target, source, run } = scenario();
    const verification = await new RunVerifier({ target, source }).verify(run, NO_WAIT);
    expect(verificationTotals(verification)).toEqual({
      expected: 3,
      present: 3,
      deleted: 0,
      notVisible: 0,
      changed: 0,
      linksChecked: 4,
      linksBroken: 0,
      attempts: 2,
    });
  });
});
