import { describe, expect, it, vi } from 'vitest';
import type { ForgeRunVerification } from '@sandforge/shared';
import {
  lookupsLeftEmptyByTheRun,
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
  fields: Array<{
    name: string;
    type: string;
    createable?: boolean;
    updateable?: boolean;
    referenceTo?: string[];
  }>;
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

/*
 * Cases whose asset lookups the target took its own way. Run on a large
 * client sandbox, a verification said `partial` with eighteen broken links on
 * cases: fourteen asset lookups a lookup filter of the target refused, which
 * the run left empty and said so, and four pointing at assets the target's
 * automation created during the run.
 */
describe('RunVerifier — lookups the target explains', () => {
  const RUN_START = '2026-10-01T09:50:00.000Z';
  const DURING = '2026-10-01T09:55:00.000+0000';
  const BEFORE = '2026-10-01T08:00:00.000+0000';
  const CASE_FIELDS = [
    { name: 'Id', type: 'id' },
    { name: 'CreatedById', type: 'reference', referenceTo: ['User'] },
    {
      name: 'AssetId',
      type: 'reference',
      createable: true,
      updateable: true,
      referenceTo: ['Asset'],
    },
    {
      name: 'Cloned_Risk__c',
      type: 'reference',
      createable: true,
      updateable: true,
      referenceTo: ['Asset'],
    },
  ];
  const ASSET_FIELDS = [
    { name: 'Id', type: 'id' },
    { name: 'CreatedById', type: 'reference' },
    { name: 'CreatedDate', type: 'datetime' },
  ];
  const ASSET = tid('02i', 1);
  const SOURCE_ASSET = sid('02i', 1);

  /**
   * Cases of the run, each as the target holds it now, and the assets the
   * target holds: each case pointed at the run's asset in the source.
   */
  function cases(
    now: Array<Record<string, unknown>>,
    assets: Array<{ id: string; by: string; at: string }> = [],
  ) {
    const ids = now.map((_, i) => tid('500', i + 1));
    const target = fakeOrg({
      Case: {
        fields: CASE_FIELDS,
        rows: new Map(
          now.map((fields, i) => [ids[i], targetRow(ids[i], { CreatedById: RUN_USER, ...fields })]),
        ),
      },
      Asset: {
        fields: ASSET_FIELDS,
        rows: new Map([
          [ASSET, { Id: ASSET, CreatedById: RUN_USER, CreatedDate: DURING }],
          ...assets.map(
            ({ id, by, at }) => [id, { Id: id, CreatedById: by, CreatedDate: at }] as const,
          ),
        ]),
      },
    });
    const source = fakeOrg({
      Case: {
        fields: CASE_FIELDS,
        rows: new Map(
          now.map((_, i) => [
            sid('500', i + 1),
            { Id: sid('500', i + 1), AssetId: SOURCE_ASSET, Cloned_Risk__c: SOURCE_ASSET },
          ]),
        ),
      },
    });
    const run: RunToVerify = {
      records: [{ objectApiName: 'Case', ids }],
      remapTable: {
        [SOURCE_ASSET]: ASSET,
        ...Object.fromEntries(ids.map((id, i) => [sid('500', i + 1), id])),
      },
      runStartedAt: new Date(RUN_START),
      runEndedAt: new Date(RUN_END),
    };
    return { target, source, run, ids };
  }

  it('counts a lookup the run left empty on a lookup filter’s refusal apart, never as broken', async () => {
    const { target, source, run, ids } = cases([
      { AssetId: null, Cloned_Risk__c: ASSET },
      { AssetId: null, Cloned_Risk__c: ASSET },
    ]);

    const verification = await new RunVerifier({ target, source }).verify(
      {
        ...run,
        leftEmptyByFilter: [{ objectApiName: 'Case', field: 'AssetId', recordIds: [ids[0]] }],
      },
      NO_WAIT,
    );

    const object = objectOf(verification, 'Case');
    // The second case's asset was not left empty by the run: it broke.
    expect(object).toMatchObject({ linksChecked: 4, linksBroken: 1, linksLeftEmptyByFilter: 1 });
    expect(object.brokenLinks).toEqual([
      { recordId: ids[1], field: 'AssetId', expected: ASSET, found: null },
    ]);
    expect(object.explainedLinks).toEqual([
      { recordId: ids[0], field: 'AssetId', expected: ASSET, found: null, cause: 'lookup-filter' },
    ]);
    expect(verification.verdict).toBe('partial');
  });

  it('is verified when only lookups the target explains are left, and says how many', async () => {
    const automation = tid('02i', 2);
    const { target, source, run, ids } = cases(
      [
        { AssetId: null, Cloned_Risk__c: automation },
        { AssetId: ASSET, Cloned_Risk__c: ASSET },
      ],
      [{ id: automation, by: RUN_USER, at: DURING }],
    );

    const verification = await new RunVerifier({ target, source }).verify(
      {
        ...run,
        leftEmptyByFilter: [{ objectApiName: 'Case', field: 'AssetId', recordIds: [ids[0]] }],
      },
      NO_WAIT,
    );

    expect(verification.verdict).toBe('verified');
    expect(objectOf(verification, 'Case')).toMatchObject({
      linksChecked: 4,
      linksBroken: 0,
      linksLeftEmptyByFilter: 1,
      linksSetByAutomation: 1,
    });
    expect(verificationTotals(verification)).toMatchObject({
      linksBroken: 0,
      linksLeftEmptyByFilter: 1,
      linksSetByAutomation: 1,
    });
  });

  it('says a lookup the target’s automation set when it points at a record the run’s user created during the run', async () => {
    const automation = tid('02i', 2);
    const { target, source, run, ids } = cases(
      [{ AssetId: ASSET, Cloned_Risk__c: automation }],
      [{ id: automation, by: RUN_USER, at: DURING }],
    );

    const verification = await new RunVerifier({ target, source }).verify(run, NO_WAIT);

    expect(objectOf(verification, 'Case').explainedLinks).toEqual([
      {
        recordId: ids[0],
        field: 'Cloned_Risk__c',
        expected: ASSET,
        found: automation,
        cause: 'automation',
      },
    ]);
    expect(target.asked.queries).toContain(
      `SELECT Id, CreatedById, CreatedDate FROM Asset WHERE Id IN ('${automation}')`,
    );
  });

  it('keeps as broken a lookup pointing at a record someone else created, one created before the run, or one the run created', async () => {
    const someoneElse = tid('02i', 3);
    const before = tid('02i', 4);
    const otherOfTheRun = tid('02i', 5);
    const { target, source, run } = cases(
      [
        { AssetId: ASSET, Cloned_Risk__c: someoneElse },
        { AssetId: ASSET, Cloned_Risk__c: before },
        { AssetId: ASSET, Cloned_Risk__c: otherOfTheRun },
      ],
      [
        { id: someoneElse, by: OTHER_USER, at: DURING },
        { id: before, by: RUN_USER, at: BEFORE },
        { id: otherOfTheRun, by: RUN_USER, at: DURING },
      ],
    );

    const verification = await new RunVerifier({ target, source }).verify(
      { ...run, remapTable: { ...run.remapTable, [sid('02i', 5)]: otherOfTheRun } },
      NO_WAIT,
    );

    const object = objectOf(verification, 'Case');
    expect(object).toMatchObject({ linksBroken: 3 });
    expect(object.linksSetByAutomation).toBeUndefined();
    expect(verification.verdict).toBe('partial');
  });

  it('keeps as broken a lookup pointing elsewhere when the run’s first write is not known', async () => {
    const automation = tid('02i', 2);
    const { target, source, run } = cases(
      [{ AssetId: ASSET, Cloned_Risk__c: automation }],
      [{ id: automation, by: RUN_USER, at: DURING }],
    );

    const verification = await new RunVerifier({ target, source }).verify(
      { ...run, runStartedAt: undefined },
      NO_WAIT,
    );

    expect(objectOf(verification, 'Case')).toMatchObject({ linksBroken: 1 });
  });

  describe('the records of an object the run’s user created in the run’s window', () => {
    /** When the run began, by the org's clock: an hour before it ended. */
    const RUN_START = '2026-10-01T09:00:00.000Z';

    /**
     * The scenario's target, its records created by the run's user during
     * the run, and `twice` more contacts beside them, created by the same
     * user in the same window: a call the run wrote again.
     *
     * @param copiedAt - When the org dated those more contacts.
     */
    function withCopies(twice: number, copiedAt = '2026-10-01T09:30:00.000+0000') {
      const { target, source, run } = scenario();
      const created = { CreatedById: RUN_USER, CreatedDate: '2026-10-01T09:30:00.000+0000' };
      const copy = { ...created, CreatedDate: copiedAt };
      const rowsOf = (object: string): Array<Record<string, unknown>> =>
        object === 'Contact'
          ? [created, created, ...Array.from({ length: twice }, () => copy)]
          : [created];
      const answered = target.query;
      const counts: string[] = [];
      target.query = vi.fn(async (soql: string) => {
        const count =
          /^SELECT COUNT\(\) FROM (\w+) WHERE CreatedById = '(\w+)' AND CreatedDate >= (\S+) AND CreatedDate <= (\S+)$/.exec(
            soql,
          );
        if (!count) {
          if (/^SELECT Id, CreatedById FROM/.test(soql)) {
            const id = /IN \('(\w+)'\)/.exec(soql)?.[1] ?? '';
            return { totalSize: 1, records: [{ Id: id, CreatedById: RUN_USER }] };
          }
          return answered(soql);
        }
        counts.push(soql);
        const [, object, user, from, to] = count;
        const rows = rowsOf(object).filter(
          (row) =>
            row.CreatedById === user &&
            Date.parse(String(row.CreatedDate)) >= Date.parse(from) &&
            Date.parse(String(row.CreatedDate)) <= Date.parse(to),
        );
        return { totalSize: rows.length, records: [] };
      });
      return { target, source, run: { ...run, runStartedAt: new Date(RUN_START) }, counts };
    }

    it('says how many more the target holds than the run read back, and is not verified', async () => {
      const { target, source, run, counts } = withCopies(200);

      const verification = await new RunVerifier({ target, source }).verify(run, NO_WAIT);

      expect(objectOf(verification, 'Contact')).toMatchObject({ present: 2, moreInTheWindow: 200 });
      expect(objectOf(verification, 'Account').moreInTheWindow).toBeUndefined();
      expect(verification.verdict).toBe('partial');
      expect(counts[0]).toBe(
        `SELECT COUNT() FROM Contact WHERE CreatedById = '${RUN_USER}' AND CreatedDate >= 2026-10-01T08:59:50Z AND CreatedDate <= 2026-10-01T10:00:00Z`,
      );
    });

    it('counts no contact the run’s user made by hand five seconds after the run’s last write, which it would say was created during the run', async () => {
      // The run's last write, by the org, was at 10:00:00. Counted up to ten
      // seconds past it, a contact made by hand at 10:00:05 read as one more
      // "created … during the run by the run's user than the run wrote", and
      // the verification was partial.
      const { target, source, run, counts } = withCopies(1, '2026-10-01T10:00:05.000+0000');

      const verification = await new RunVerifier({ target, source }).verify(run, NO_WAIT);

      expect(objectOf(verification, 'Contact').moreInTheWindow).toBeUndefined();
      expect(verification.verdict).toBe('verified');
      expect(counts[0]).toMatch(/AND CreatedDate <= 2026-10-01T10:00:00Z$/);
    });

    it('is verified when the run’s user created no more than the run wrote', async () => {
      const { target, source, run } = withCopies(0);

      const verification = await new RunVerifier({ target, source }).verify(run, NO_WAIT);

      expect(verification.verdict).toBe('verified');
      expect(objectOf(verification, 'Contact').moreInTheWindow).toBeUndefined();
    });

    it('counts nothing when the run’s first write is not known', async () => {
      const { target, source, run, counts } = withCopies(200);

      const verification = await new RunVerifier({ target, source }).verify(
        { ...run, runStartedAt: undefined },
        NO_WAIT,
      );

      expect(counts).toEqual([]);
      expect(verification.verdict).toBe('verified');
    });
  });
});

/*
 * A clone of the whole org of person accounts and synced quotes, taken up and
 * verified on a scratch org: every record was there, and the verification
 * said `partial` for two reasons. The opportunity's synced quote, which such
 * a run leaves empty on purpose and says so, read as a lookup that broke; and
 * the ten contacts the platform wrote with the run's person accounts, which
 * the run links to as written with their record, read as ten more contacts
 * "created during the run by the run's user than the run wrote".
 */
describe('RunVerifier — what the run left empty, and what the platform wrote with its records', () => {
  const RUN_START = '2026-10-01T09:50:00.000Z';
  const DURING = '2026-10-01T09:55:00.000+0000';
  const BEFORE = '2026-10-01T08:00:00.000+0000';
  const stamps = (by: string, at: string) => ({
    CreatedById: by,
    CreatedDate: at,
    LastModifiedDate: BEFORE_END,
    LastModifiedById: by,
    SystemModstamp: BEFORE_END,
  });
  const ref = (name: string, referenceTo: string[], createable = true) => ({
    name,
    type: 'reference',
    createable,
    updateable: true,
    referenceTo,
  });
  const AUDIT = [
    { name: 'Id', type: 'id' },
    { name: 'CreatedById', type: 'reference', referenceTo: ['User'] },
    { name: 'CreatedDate', type: 'datetime' },
  ];
  const FIELDS = {
    Account: [...AUDIT, { name: 'Name', type: 'string', createable: true, updateable: true }],
    Contact: [...AUDIT, ref('AccountId', ['Account'])],
    // The opportunity's synced quote: set by an update alone, never on insert.
    Opportunity: [...AUDIT, ref('AccountId', ['Account']), ref('SyncedQuoteId', ['Quote'], false)],
    Quote: [...AUDIT, ref('OpportunityId', ['Opportunity'])],
    Task: [...AUDIT, ref('WhatId', ['Opportunity'])],
  };
  type Name = keyof typeof FIELDS;
  type Table = Map<string, Record<string, unknown>>;

  /** The business account, the person account, and their records, by id in each org. */
  const A1 = { s: sid('001', 1), t: tid('001', 1) };
  const A2 = { s: sid('001', 2), t: tid('001', 2) };
  const C1 = { s: sid('003', 1), t: tid('003', 1) };
  /** The contact the platform wrote with the person account A2. */
  const PC2 = { s: sid('003', 2), t: tid('003', 2) };
  const O1 = { s: sid('006', 1), t: tid('006', 1) };
  const Q1 = { s: sid('0Q0', 1), t: tid('0Q0', 1) };
  const T1 = { s: sid('00T', 1), t: tid('00T', 1) };
  /** The task the platform wrote with an email the run created. */
  const T2 = { s: sid('00T', 2), t: tid('00T', 2) };

  /**
   * An org of `rows` per object, which also answers what a verification
   * counts of the run's window: the records of an object a user created
   * between two dates, those in the recycle bin left out, as `COUNT()` does.
   */
  function org(rows: Record<Name, Table>, deleted = new Set<string>()) {
    const faked = fakeOrg(
      Object.fromEntries(
        (Object.keys(FIELDS) as Name[]).map((name) => [
          name,
          { fields: FIELDS[name], rows: rows[name], deleted },
        ]),
      ),
    );
    const answered = faked.query;
    faked.query = vi.fn(async (soql: string) => {
      const count =
        /^SELECT COUNT\(\) FROM (\w+) WHERE CreatedById = '(\w+)' AND CreatedDate >= (\S+) AND CreatedDate <= (\S+)$/.exec(
          soql,
        );
      if (!count) return answered(soql);
      const [, object, user, from, to] = count;
      const created = [...(rows[object as Name]?.values() ?? [])].filter(
        (row) =>
          !deleted.has(String(row.Id)) &&
          row.CreatedById === user &&
          Date.parse(String(row.CreatedDate)) >= Date.parse(from) &&
          Date.parse(String(row.CreatedDate)) <= Date.parse(to),
      );
      return { totalSize: created.length, records: [] };
    });
    return faked;
  }

  const table = (...rows: Array<Record<string, unknown>>): Table =>
    new Map(rows.map((row) => [String(row.Id), row]));

  /**
   * The source, and the target as the run left it: the accounts, the contact,
   * the opportunity, its quote and the task the run wrote, as its user during
   * the run; the person account's contact and the email's task the platform
   * wrote with them, as the same user in the same window; the opportunity's
   * synced quote empty. `contacts`: more contacts in the target.
   */
  function wholeOrgClone(contacts: Array<Record<string, unknown>> = []) {
    const run = stamps(RUN_USER, DURING);
    const source = org({
      Account: table({ Id: A1.s }, { Id: A2.s }),
      Contact: table({ Id: C1.s, AccountId: A1.s }, { Id: PC2.s, AccountId: A2.s }),
      Opportunity: table({ Id: O1.s, AccountId: A1.s, SyncedQuoteId: Q1.s }),
      Quote: table({ Id: Q1.s, OpportunityId: O1.s }),
      Task: table({ Id: T1.s, WhatId: O1.s }, { Id: T2.s, WhatId: O1.s }),
    });
    const rows: Record<Name, Table> = {
      Account: table({ Id: A1.t, ...run }, { Id: A2.t, ...run }),
      Contact: table(
        { Id: C1.t, AccountId: A1.t, ...run },
        { Id: PC2.t, AccountId: A2.t, ...run },
        ...contacts,
      ),
      Opportunity: table({ Id: O1.t, AccountId: A1.t, SyncedQuoteId: null, ...run }),
      Quote: table({ Id: Q1.t, OpportunityId: O1.t, ...run }),
      Task: table({ Id: T1.t, WhatId: O1.t, ...run }, { Id: T2.t, WhatId: O1.t, ...run }),
    };
    const toVerify: RunToVerify = {
      records: [
        { objectApiName: 'Task', ids: [T1.t] },
        { objectApiName: 'Quote', ids: [Q1.t] },
        { objectApiName: 'Opportunity', ids: [O1.t] },
        { objectApiName: 'Contact', ids: [C1.t] },
        { objectApiName: 'Account', ids: [A1.t, A2.t] },
      ],
      remapTable: Object.fromEntries([A1, A2, C1, PC2, O1, Q1, T1, T2].map(({ s, t }) => [s, t])),
      runStartedAt: new Date(RUN_START),
      runEndedAt: new Date(RUN_END),
      withTheirRecord: [PC2.s, T2.s],
      leftEmptyByTheRun: lookupsLeftEmptyByTheRun(true),
    };
    return { source, rows, run: toVerify };
  }

  it('is verified when the run left the synced quote empty as it said, and the platform wrote a contact with its person account and a task with its email', async () => {
    const { source, rows, run } = wholeOrgClone();

    const verification = await new RunVerifier({ target: org(rows), source }).verify(run, NO_WAIT);

    expect(verification.verdict).toBe('verified');
    const opportunity = objectOf(verification, 'Opportunity');
    expect(opportunity).toMatchObject({
      linksChecked: 2,
      linksBroken: 0,
      linksLeftEmptyByTheRun: 1,
    });
    expect(opportunity.explainedLinks).toEqual([
      { recordId: O1.t, field: 'SyncedQuoteId', expected: Q1.t, found: null, cause: 'run' },
    ]);
    // What the platform wrote with the run's records is the run's: expected
    // there, and never counted past what the run wrote.
    expect(objectOf(verification, 'Contact')).toMatchObject({ present: 1, withTheirRecord: 1 });
    expect(objectOf(verification, 'Contact').moreInTheWindow).toBeUndefined();
    expect(objectOf(verification, 'Task')).toMatchObject({ present: 1, withTheirRecord: 1 });
    expect(objectOf(verification, 'Task').moreInTheWindow).toBeUndefined();
    expect(objectOf(verification, 'Account').withTheirRecord).toBeUndefined();
    expect(verificationTotals(verification)).toMatchObject({
      linksBroken: 0,
      linksLeftEmptyByTheRun: 1,
    });
  });

  it('keeps as broken the synced quote of a run that does not say it leaves it empty', async () => {
    const { source, rows, run } = wholeOrgClone();

    const verification = await new RunVerifier({ target: org(rows), source }).verify(
      { ...run, leftEmptyByTheRun: lookupsLeftEmptyByTheRun(false) },
      NO_WAIT,
    );

    const opportunity = objectOf(verification, 'Opportunity');
    expect(opportunity).toMatchObject({ linksBroken: 1 });
    expect(opportunity.linksLeftEmptyByTheRun).toBeUndefined();
    expect(opportunity.brokenLinks).toEqual([
      { recordId: O1.t, field: 'SyncedQuoteId', expected: Q1.t, found: null },
    ]);
    expect(verification.verdict).toBe('partial');
  });

  it('keeps as broken a lookup the run says it leaves empty that points at another record', async () => {
    const { source, rows, run } = wholeOrgClone();
    const another = tid('0Q0', 9);
    rows.Opportunity.set(O1.t, { ...rows.Opportunity.get(O1.t), SyncedQuoteId: another });
    rows.Quote.set(another, { Id: another, ...stamps(OTHER_USER, BEFORE) });

    const verification = await new RunVerifier({ target: org(rows), source }).verify(run, NO_WAIT);

    expect(objectOf(verification, 'Opportunity').brokenLinks).toEqual([
      { recordId: O1.t, field: 'SyncedQuoteId', expected: Q1.t, found: another },
    ]);
    expect(verification.verdict).toBe('partial');
  });

  it('still counts a contact the run’s user created in the run’s window past the run’s and the one the platform wrote with its person account', async () => {
    const { source, rows, run } = wholeOrgClone([
      { Id: tid('003', 3), AccountId: A1.t, ...stamps(RUN_USER, DURING) },
    ]);

    const verification = await new RunVerifier({ target: org(rows), source }).verify(run, NO_WAIT);

    expect(objectOf(verification, 'Contact')).toMatchObject({
      present: 1,
      withTheirRecord: 1,
      moreInTheWindow: 1,
    });
    expect(verification.verdict).toBe('partial');
  });

  it('counts none of the records the platform wrote with the run’s that are gone since, as the target counts none of them', async () => {
    const { source, rows, run } = wholeOrgClone();

    // The person account in the recycle bin, and its contact with it.
    const verification = await new RunVerifier({
      target: org(rows, new Set([A2.t, PC2.t])),
      source,
    }).verify(run, NO_WAIT);

    expect(objectOf(verification, 'Account')).toMatchObject({ present: 1, deleted: 1 });
    const contact = objectOf(verification, 'Contact');
    expect(contact.withTheirRecord).toBeUndefined();
    expect(contact.moreInTheWindow).toBeUndefined();
    expect(verification.verdict).toBe('partial');
  });

  it('names the lookups a clone of the whole org leaves empty on every record, and none for any other run', () => {
    expect(lookupsLeftEmptyByTheRun(true)).toEqual({ Opportunity: ['SyncedQuoteId'] });
    expect(lookupsLeftEmptyByTheRun(false)).toEqual({});
  });
});
