import { describe, it, expect, vi } from 'vitest';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import {
  IN_FLIGHT_LEAD_MS,
  IN_FLIGHT_TRAIL_MS,
  callsInFlight,
  externalIdKey,
  fingerprintFields,
  inFlightLines,
  reconcileInFlight,
  rowFingerprint,
  uncertainRows,
  type InFlightTarget,
} from './ForgeInFlight.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
import type { JobResultsRead } from '../../core/engine/ingestJobRead.js';
import { JournalPart } from './journalRecords.js';

/** An id of `prefix`, the `n`-th, its checksum right. */
function idOf(prefix: string, n: number): string {
  const id = canonicalRecordId(`${prefix}${String(n).padStart(11, '0')}`);
  if (!id) throw new Error('no id');
  return id;
}
const source = (n: number): string => idOf('003S', n);
const target = (n: number): string => idOf('003T', n);
const USER = idOf('005U', 1);

const SENT_AT = '2026-10-20T10:00:00.000Z';
/** The head of a run's journal. */
const HEAD = `${JSON.stringify({ run: { journalId: 'j', targetOrgId: 'org', startedAt: SENT_AT } })}\n`;

/** A contact as a call sends it, and as the target holds it once written. */
function contact(n: number): Record<string, unknown> {
  return {
    LastName: `Marked ${n}`,
    Email: `person${n}@example.com.invalid`,
    AccountId: idOf('001T', n % 3),
    HasOptedOutOfEmail: false,
  };
}

/**
 * A journal whose run wrote `written` contacts in a call that was answered,
 * then sent `inFlight` more in a call the journal names no answer of — the
 * process killed while it was under way.
 */
function journalOf(written: number[], inFlight: number[], answered = false): string {
  const disk = memoryRunFile(HEAD);
  const store = ForgeRunStore.open(disk);
  store.beginPart(new Date(SENT_AT));
  const sendCall = (rows: number[]): string => {
    const payloads = rows.map(contact);
    const fields = fingerprintFields(payloads);
    return store.sent(
      'Contact',
      fields,
      rows.map((n, i) => ({
        sourceId: source(n),
        fingerprint: rowFingerprint(payloads[i], fields),
      })),
      new Date(SENT_AT),
    );
  };
  if (written.length > 0) {
    const first = sendCall(written);
    for (const n of written) store.setMapping('created', source(n), target(n), 'Contact');
    store.answered(first);
  }
  const second = sendCall(inFlight);
  if (answered) store.answered(second);
  store.flush();
  return disk.text();
}

/** A target holding `records`, each created by the run's user, answering a query in one page. */
function targetHolding(
  records: Array<Record<string, unknown>>,
  options: { fails?: string; serverTime?: string } = {},
): InFlightTarget & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    queryPages: (soql: string) =>
      (async function* page() {
        queries.push(soql);
        if (options.fails) throw new Error(options.fails);
        yield records;
      })(),
    userId: vi.fn(async () => USER),
    ...(options.serverTime ? { serverTime: async () => options.serverTime as string } : {}),
  };
}

/** A record the target holds: the contact as read back, under its id there. */
function held(n: number, id = target(n)): Record<string, unknown> {
  const sent = contact(n);
  return {
    Id: id,
    // Read back as the org gives them: the lookup in 18 characters, the email
    // as it was written.
    ...sent,
    AccountId: String(sent['AccountId']),
  };
}

/** The lines a reconciliation added to the journal `before`, now `after`. */
function added(before: string, after: string): unknown[][] {
  return after
    .slice(before.length)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown[]);
}

describe('the fingerprint of the rows of an insert call', () => {
  it('takes the fields every row sends a plain value in, sorted, and leaves out the rest', () => {
    const fields = fingerprintFields([
      {
        Id: 'x',
        LastName: 'One',
        Title: 'Head',
        Description: 'y'.repeat(300),
        Birthdate: null,
        MailingAddress: { city: 'X' },
        HasOptedOutOfEmail: false,
      },
      {
        Id: 'y',
        LastName: 'Two',
        Title: '',
        Description: 'short',
        Birthdate: '2000-01-01',
        MailingAddress: { city: 'Y' },
        HasOptedOutOfEmail: true,
      },
    ]);

    expect(fields).toEqual(['HasOptedOutOfEmail', 'LastName']);
  });

  it('reads a record back as the call wrote it: an id in 15 or 18 characters, a date and time in either form, a text in another case or spacing', () => {
    const fields = ['AccountId', 'Email', 'LastName', 'Started__c', 'Amount'];
    const sent = {
      AccountId: idOf('001T', 4).slice(0, 15),
      Email: 'Person@Example.com.invalid',
      LastName: 'Marked  One ',
      Started__c: '2026-10-20T10:00:00.000+0000',
      Amount: 12.5,
    };
    const readBack = {
      AccountId: idOf('001T', 4),
      Email: 'person@example.com.invalid',
      LastName: 'Marked One',
      Started__c: '2026-10-20T10:00:00.000Z',
      Amount: 12.5,
    };

    expect(rowFingerprint(readBack, fields)).toBe(rowFingerprint(sent, fields));
    expect(rowFingerprint({ ...readBack, LastName: 'Marked Two' }, fields)).not.toBe(
      rowFingerprint(sent, fields),
    );
  });

  it('holds no value of the row it fingerprints', () => {
    const fingerprint = rowFingerprint(contact(7), fingerprintFields([contact(7)]));

    expect(fingerprint).toMatch(/^[0-9a-z]{14}$/);
    expect(fingerprint).not.toMatch(/marked|example|invalid/i);
  });
});

describe('the insert calls a journal names no answer of, looked for in the target', () => {
  it('reads nothing of the target for a journal whose calls were all answered, or one kept before calls were', async () => {
    const answered = journalOf([1, 2], [3, 4], true);
    const old =
      HEAD +
      `${JSON.stringify({ part: { n: 0, startedAt: SENT_AT } })}\n` +
      `${JSON.stringify(['c', source(1), target(1), 'Contact', 'found'])}\n`;

    for (const text of [answered, old]) {
      const file = memoryRunFile(text);
      const org = targetHolding([held(3)]);
      const outcome = await reconcileInFlight(file, org);

      expect(outcome.calls).toBe(0);
      expect(org.queries).toEqual([]);
      expect(file.text()).toBe(text);
    }
  });

  it('keeps the rows it finds as written by the run, in the order the call sent them, and closes the call', async () => {
    const text = journalOf([1, 2], [3, 4, 5]);
    const file = memoryRunFile(text);
    // The target holds what the answered call created, which the journal
    // names, and what the call under way created, which it does not.
    const org = targetHolding([held(1), held(2), held(3), held(4), held(5)]);

    const outcome = await reconcileInFlight(file, org);

    expect(outcome).toEqual({
      calls: 1,
      found: [{ objectApiName: 'Contact', rows: 3 }],
      notFound: [],
      uncertain: [],
      unread: [],
      lookedFor: new Set([source(3), source(4), source(5)]),
    });
    const lines = added(text, file.text());
    expect(lines.filter(([tag]) => tag === 'c')).toEqual([
      ['c', source(3), target(3), 'Contact', 'found-owed'],
      ['c', source(4), target(4), 'Contact', 'found-owed'],
      ['c', source(5), target(5), 'Contact', 'found-owed'],
    ]);
    expect(lines.at(-1)?.[0]).toBe('a');
    // Taken up again, nothing is left open.
    const again = await reconcileInFlight(file, org);
    expect(again.calls).toBe(0);
  });

  it('matches rows whose values are the same by the order the org created them in', async () => {
    const twins = (n: number): Record<string, unknown> => ({ LastName: 'Same', Index__c: n % 1 });
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    const fields = fingerprintFields([twins(1), twins(2)]);
    store.sent(
      'Contact',
      fields,
      [1, 2].map((n) => ({ sourceId: source(n), fingerprint: rowFingerprint(twins(n), fields) })),
      new Date(SENT_AT),
    );
    store.flush();
    const file = memoryRunFile(disk.text());
    const org = targetHolding([
      { Id: target(9), ...twins(2) },
      { Id: target(8), ...twins(1) },
    ]);

    const outcome = await reconcileInFlight(file, org);

    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 2 }]);
    expect(file.text()).toContain(
      JSON.stringify(['c', source(1), target(8), 'Contact', 'found-owed']),
    );
    expect(file.text()).toContain(
      JSON.stringify(['c', source(2), target(9), 'Contact', 'found-owed']),
    );
  });

  it('leaves to the resume the rows the target does not hold, and closes the call', async () => {
    const text = journalOf([1], [2, 3]);
    const file = memoryRunFile(text);

    const outcome = await reconcileInFlight(file, targetHolding([held(1)]));

    expect(outcome.found).toEqual([]);
    expect(outcome.notFound).toEqual([{ objectApiName: 'Contact', rows: 2 }]);
    expect(uncertainRows(outcome)).toBe(0);
    expect(added(text, file.text())).toEqual([['a', expect.any(String)]]);
  });

  it('leaves the rows waiting to go again in smaller calls to the resume, which writes each of them once', async () => {
    // The target's automation refused a call of four for a Salesforce limit:
    // the call is closed, nothing of it created, and its rows go again two at
    // a time. The process is killed while the first of the two is under way,
    // the second still waiting.
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    const sendCall = (rows: number[]): string => {
      const payloads = rows.map(contact);
      const fields = fingerprintFields(payloads);
      return store.sent(
        'Contact',
        fields,
        rows.map((n, i) => ({
          sourceId: source(n),
          fingerprint: rowFingerprint(payloads[i], fields),
        })),
        new Date(SENT_AT),
      );
    };
    store.answered(sendCall([1, 2, 3, 4]));
    sendCall([1, 2]);
    store.flush();
    const text = disk.text();
    const file = memoryRunFile(text);
    const org = targetHolding([held(1), held(2)]);

    const outcome = await reconcileInFlight(file, org);

    // The half under way is found and kept as written; the half waiting was
    // in no call left open, and nothing of it is looked for.
    expect(outcome).toMatchObject({
      calls: 1,
      found: [{ objectApiName: 'Contact', rows: 2 }],
      notFound: [],
      uncertain: [],
      lookedFor: new Set([source(1), source(2)]),
    });
    expect(added(text, file.text()).filter(([tag]) => tag === 'c')).toEqual([
      ['c', source(1), target(1), 'Contact', 'found-owed'],
      ['c', source(2), target(2), 'Contact', 'found-owed'],
    ]);
    // Taken up, the run writes what the journal maps to nothing: the half
    // that waited, once, and not the half the target holds.
    const resumed = ForgeRunStore.open(memoryRunFile(file.text()));
    expect([1, 2, 3, 4].filter((n) => resumed.mapping(source(n)) === undefined)).toEqual([3, 4]);
    expect((await reconcileInFlight(file, org)).calls).toBe(0);
  });

  it('says a row may be in the target when more records than rows share its fingerprint, and leaves its call open', async () => {
    const text = journalOf([], [2, 3]);
    const file = memoryRunFile(text);
    // Two records of row 2: the call's, and another made the same since.
    const org = targetHolding([held(2), held(2, target(20)), held(3)]);

    const outcome = await reconcileInFlight(file, org);

    expect(outcome.uncertain).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(added(text, file.text()).some(([tag]) => tag === 'a')).toBe(false);
    expect(inFlightLines(outcome, 'TGT')).toContain('  may already be in TGT: 1 Contact');
  });

  it('says a row may be in the target when a record of the window matched no row: the target may have changed it as it saved it', async () => {
    const text = journalOf([], [2, 3]);
    const file = memoryRunFile(text);
    const changed = { ...held(3), LastName: 'Marked 3 (renamed by a flow)' };

    const outcome = await reconcileInFlight(file, targetHolding([held(2), changed]));

    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(outcome.uncertain).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(outcome.notFound).toEqual([]);
  });

  it('leaves out the rows the journal mapped already, whose answer came in before the call was closed', async () => {
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    const payloads = [2, 3].map(contact);
    const fields = fingerprintFields(payloads);
    store.sent(
      'Contact',
      fields,
      [2, 3].map((n, i) => ({
        sourceId: source(n),
        fingerprint: rowFingerprint(payloads[i], fields),
      })),
      new Date(SENT_AT),
    );
    store.setMapping('created', source(2), target(2), 'Contact');
    store.flush();
    const text = disk.text();
    const file = memoryRunFile(text);

    const outcome = await reconcileInFlight(file, targetHolding([held(2), held(3)]));

    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(added(text, file.text()).filter(([tag]) => tag === 'c')).toEqual([
      ['c', source(3), target(3), 'Contact', 'found-owed'],
    ]);
  });

  it('says every row of an object it could not read may be in the target, and why', async () => {
    const text = journalOf([], [2, 3]);
    const file = memoryRunFile(text);

    const outcome = await reconcileInFlight(
      file,
      targetHolding([], { fails: 'INVALID_FIELD: No such column' }),
    );

    expect(outcome.uncertain).toEqual([{ objectApiName: 'Contact', rows: 2 }]);
    expect(outcome.unread).toEqual([
      { objectApiName: 'Contact', reason: 'INVALID_FIELD: No such column' },
    ]);
    expect(file.text()).toBe(text);
  });

  it("reads the records the run's user created from just before the call to well after the journal's last line, on the org's clock", async () => {
    const text = journalOf([], [2]);
    // The org's clock is an hour ahead of this machine's.
    const now = new Date('2026-10-20T12:00:00.000Z');
    const org = targetHolding([held(2)], { serverTime: '2026-10-20T13:00:00.000Z' });

    await reconcileInFlight(memoryRunFile(text), org, () => now);

    const sent = Date.parse(SENT_AT) + 3_600_000;
    const from = new Date(sent - IN_FLIGHT_LEAD_MS).toISOString().replace('.000Z', 'Z');
    const to = new Date(sent + IN_FLIGHT_TRAIL_MS).toISOString().replace('.000Z', 'Z');
    expect(org.queries).toEqual([
      `SELECT Id, AccountId, Email, HasOptedOutOfEmail, LastName FROM Contact WHERE CreatedById = '${USER}' ` +
        `AND CreatedDate >= ${from} AND CreatedDate <= ${to} ORDER BY Id`,
    ]);
  });

  it('adds lines the readers of a journal take as the records its part created', async () => {
    const text = journalOf([1], [2]);
    const file = memoryRunFile(text);
    await reconcileInFlight(file, targetHolding([held(1), held(2)]));

    const part = JournalPart.read(file, 0);
    const records = part?.runRecords();
    const ids: string[] = [];
    for await (const page of records?.pages('Contact') ?? []) ids.push(...page);
    expect(ids.sort()).toEqual([target(1), target(2)].sort());
    // And the store of a part that takes the run up finds them, written before it.
    const store = ForgeRunStore.open(file);
    store.beginPart(new Date());
    expect(store.mapping(source(2))).toMatchObject({ kind: 'created', earlier: true });
  });

  describe('what a row found owes the second pass', () => {
    /** The contact the call sent second went in without the one it reports to, not written yet. */
    const REPORTS_TO = idOf('003S', 40);

    function journalOwing(): string {
      const disk = memoryRunFile(HEAD);
      const store = ForgeRunStore.open(disk);
      store.beginPart(new Date(SENT_AT));
      const payloads = [3, 4].map(contact);
      const fields = fingerprintFields(payloads);
      store.sent(
        'Contact',
        fields,
        [
          { sourceId: source(3), fingerprint: rowFingerprint(payloads[0], fields), owes: [] },
          {
            sourceId: source(4),
            fingerprint: rowFingerprint(payloads[1], fields),
            owes: [
              { field: 'ReportsToId', sourceRefId: REPORTS_TO },
              { field: 'MasterRecordId', sourceRefId: REPORTS_TO, insertOnly: true },
            ],
          },
        ],
        new Date(SENT_AT),
      );
      store.flush();
      return disk.text();
    }

    it('owes a row it finds the lookups its call says it went in without, and no other', async () => {
      const text = journalOwing();
      const file = memoryRunFile(text);

      await reconcileInFlight(file, targetHolding([held(3), held(4)]));

      const lines = added(text, file.text());
      expect(lines.filter(([tag]) => tag === 'c')).toEqual([
        ['c', source(3), target(3), 'Contact', 'found-owed'],
        ['c', source(4), target(4), 'Contact', 'found-owed'],
      ]);
      // As the call's answer would have owed them (`ForgeRunStore.owe`): its
      // account, set as it went in, is owed nothing.
      expect(lines.filter(([tag]) => tag === 'o' || tag === 'w')).toEqual([
        ['o', 'Contact', target(4), source(4), 'ReportsToId', REPORTS_TO, 0],
        ['o', 'Contact', target(4), source(4), 'MasterRecordId', REPORTS_TO, 1],
      ]);
      const store = ForgeRunStore.open(file);
      expect(store.owed).toBe(2);
      expect(store.wasFoundAfterStop(source(4))).toBe(true);
      expect(store.owesUntold(source(4))).toBe(false);
    });

    it('takes a call a journal of 1.61 kept, which says nothing of what its rows went in without, as one whose rows owe what they name', async () => {
      const payloads = [3].map(contact);
      const fields = fingerprintFields(payloads);
      const text =
        HEAD +
        `${JSON.stringify({ part: { n: 0, startedAt: SENT_AT } })}\n` +
        `${JSON.stringify(['x', '0.1', 'Contact', SENT_AT, fields, [[source(3), rowFingerprint(payloads[0], fields)]]])}\n`;
      const file = memoryRunFile(text);

      const outcome = await reconcileInFlight(file, targetHolding([held(3)]));

      expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
      const lines = added(text, file.text());
      expect(lines.filter(([tag]) => tag === 'c')).toEqual([
        ['c', source(3), target(3), 'Contact', 'found'],
      ]);
      expect(lines.some(([tag]) => tag === 'o')).toBe(false);
      const store = ForgeRunStore.open(file);
      expect(store.wasFoundAfterStop(source(3))).toBe(true);
      expect(store.owesUntold(source(3))).toBe(true);
    });

    it('reads nothing of a sent line that says what its rows owe in a form it does not write', async () => {
      const payloads = [3].map(contact);
      const fields = fingerprintFields(payloads);
      const sent = [source(3), rowFingerprint(payloads[0], fields)];
      const text =
        HEAD +
        `${JSON.stringify({ part: { n: 0, startedAt: SENT_AT } })}\n` +
        `${JSON.stringify(['x', '0.1', 'Contact', SENT_AT, fields, [sent], [[5, 'ReportsToId', REPORTS_TO, 0]]])}\n`;
      const file = memoryRunFile(text);

      const outcome = await reconcileInFlight(file, targetHolding([held(3)]));

      expect(outcome.calls).toBe(0);
      expect(file.text()).toBe(text);
    });
  });
});

describe('the upsert calls a journal names no answer of, looked for by their external id', () => {
  /** A contact as an upsert sends it: matched on its external id. */
  const upserted = (n: number): Record<string, unknown> => ({
    LastName: `Upserted ${n}`,
    Ext__c: `EXT-${n}`,
  });
  const keyOf = (n: number): string | undefined => externalIdKey(upserted(n), 'Ext__c');

  /** A journal whose run sent the rows `rows` in an upsert call it names no answer of. */
  function upsertJournal(rows: number[], key = keyOf): string {
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    const payloads = rows.map(upserted);
    const fields = fingerprintFields(payloads);
    store.sent(
      'Contact',
      fields,
      rows.map((n, i) => {
        const externalKey = key(n);
        return {
          sourceId: source(n),
          fingerprint: rowFingerprint(payloads[i], fields),
          ...(externalKey !== undefined ? { externalKey } : {}),
        };
      }),
      new Date(SENT_AT),
      'Ext__c',
    );
    store.flush();
    return disk.text();
  }

  it('keeps as created by the run the records the call created, found by the value of their external id, and leaves the ones it wrote over', async () => {
    const text = upsertJournal([1, 2, 3]);
    const file = memoryRunFile(text);
    // Created in the window by the run's user: the rows 1 and 3. Row 2 wrote
    // over a record the target held before the run, which the read of the
    // window does not return. The target keeps the value in another case.
    const org = targetHolding([
      { Id: target(1), ...upserted(1) },
      { Id: target(3), ...upserted(3), Ext__c: 'ext-3', LastName: 'Changed by a flow' },
    ]);

    const outcome = await reconcileInFlight(file, org);

    expect(outcome).toMatchObject({
      calls: 1,
      found: [{ objectApiName: 'Contact', rows: 2 }],
      notFound: [{ objectApiName: 'Contact', rows: 1 }],
      uncertain: [],
    });
    expect(org.queries[0]).toContain('Ext__c');
    const lines = added(text, file.text());
    expect(lines.filter(([tag]) => tag === 'c')).toEqual([
      ['c', source(1), target(1), 'Contact', 'found-owed'],
      ['c', source(3), target(3), 'Contact', 'found-owed'],
    ]);
    expect(lines.at(-1)?.[0]).toBe('a');
  });

  it('says a row may be in the target when two records of the window carry its external id, and leaves the call open', async () => {
    const text = upsertJournal([1]);
    const file = memoryRunFile(text);

    const outcome = await reconcileInFlight(
      file,
      targetHolding([
        { Id: target(1), ...upserted(1) },
        { Id: target(7), ...upserted(1) },
      ]),
    );

    expect(outcome.found).toEqual([]);
    expect(uncertainRows(outcome)).toBe(1);
    expect(added(text, file.text()).some(([tag]) => tag === 'a')).toBe(false);
  });

  it('says a row kept without the value it matches on may be in the target', async () => {
    const text = upsertJournal([1, 2], (n) => (n === 1 ? keyOf(1) : undefined));
    const file = memoryRunFile(text);

    const outcome = await reconcileInFlight(
      file,
      targetHolding([{ Id: target(1), ...upserted(1) }]),
    );

    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(uncertainRows(outcome)).toBe(1);
  });

  it('counts an upsert call under way among the calls a journal names no answer of', () => {
    expect(callsInFlight(memoryRunFile(upsertJournal([1, 2])))).toBe(1);
  });
});

describe('reconciling a call sent as a Bulk API job', () => {
  const JOB = '750000000000001AAA';

  /** A journal whose run sent contacts `rows` as a job, opened, its answer never kept. */
  function jobJournal(rows: number[], opened = true): string {
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    const payloads = rows.map(contact);
    const fields = fingerprintFields(payloads);
    const callId = store.sent(
      'Contact',
      fields,
      rows.map((n, i) => ({
        sourceId: source(n),
        fingerprint: rowFingerprint(payloads[i], fields),
      })),
      new Date(SENT_AT),
    );
    if (opened) store.jobOpened(callId, JOB);
    store.flush();
    return disk.text();
  }

  /** A successful result of the job: the cells it was sent, as a CSV echoes them, and its id. */
  function result(n: number, id = target(n)): Record<string, unknown> {
    const cells = Object.fromEntries(
      Object.entries(contact(n)).map(([field, value]) => [field, String(value)]),
    );
    return { sf__Id: id, sf__Created: 'true', ...cells };
  }

  /** A target whose job `JOB` reads back as `read`, and whose window must never be read. */
  function targetWithJob(read: JobResultsRead): InFlightTarget & { queries: string[] } {
    const org = targetHolding([]);
    return { ...org, readJob: vi.fn(async () => read) };
  }

  it('keeps the rows its results answer as written by the run, by their fingerprint, and reads no window', async () => {
    const text = jobJournal([1, 2, 3]);
    const file = memoryRunFile(text);
    const org = targetWithJob({
      state: 'ended',
      info: { state: 'JobComplete' },
      // Out of the order sent, as a job's results come.
      results: { successfulResults: [result(3), result(1)], failedResults: [] },
    });

    const outcome = await reconcileInFlight(file, org);

    expect(org.readJob).toHaveBeenCalledWith(JOB);
    expect(org.queries).toEqual([]);
    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 2 }]);
    expect(outcome.notFound).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    const lines = added(text, file.text());
    expect(lines.filter(([tag]) => tag === 'c')).toEqual([
      ['c', source(1), target(1), 'Contact', 'found-owed'],
      ['c', source(3), target(3), 'Contact', 'found-owed'],
    ]);
    expect(lines.at(-1)?.[0]).toBe('a');
    expect((await reconcileInFlight(file, org)).calls).toBe(0);
  });

  it('keeps as the run’s, under no row, the records the job wrote that no row could be matched to', async () => {
    const text = jobJournal([1, 2]);
    const file = memoryRunFile(text);
    const changed = { ...result(2), LastName: 'Changed by a flow' };
    const org = targetWithJob({
      state: 'ended',
      info: { state: 'JobComplete' },
      results: { successfulResults: [result(1), changed] },
    });

    const outcome = await reconcileInFlight(file, org);

    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    // Row 2 may be the record no row matched: never written again, its call left open.
    expect(outcome.notFound).toEqual([]);
    expect(uncertainRows(outcome)).toBe(1);
    const lines = added(text, file.text());
    expect(lines).toContainEqual(['n', 'Contact', [target(2)]]);
    expect(lines.filter(([tag]) => tag === 'a')).toEqual([]);
    // What a removal of the part takes back: the record found, and the one no row matched.
    const records = JournalPart.read(file, 0)?.runRecords();
    const ids: string[] = [];
    for await (const page of records?.pages('Contact') ?? []) ids.push(...page);
    expect(ids.sort()).toEqual([target(1), target(2)].sort());

    // Read again, the job says the same: row 2 stays uncertain, the record
    // is not named twice, and the call stays open.
    const after = file.text();
    const again = await reconcileInFlight(file, org);
    expect(again.calls).toBe(1);
    expect(uncertainRows(again)).toBe(1);
    expect(again.notFound).toEqual([]);
    expect(added(after, file.text())).toEqual([]);
  });

  it('writes again the rows of a job it answered none of, when every record it wrote is matched', async () => {
    const text = jobJournal([1, 2]);
    const file = memoryRunFile(text);
    const org = targetWithJob({
      state: 'ended',
      info: { state: 'JobComplete' },
      results: { successfulResults: [result(1)], failedResults: [] },
    });

    const outcome = await reconcileInFlight(file, org);

    expect(outcome.notFound).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
    expect(uncertainRows(outcome)).toBe(0);
    expect(added(text, file.text()).at(-1)?.[0]).toBe('a');
  });

  it('finds each row of a job some of whose rows went without their owner, inactive in the target', async () => {
    // The target holds the owner of rows 2 and 3 inactive: they went in
    // without OwnerId, their cell empty, and the target gave them the user the
    // run writes as. A field one row leaves out is no part of any row's
    // fingerprint, so whatever the job echoes in that cell — empty, or the id
    // of the user it gave the record to — each row is found again by its own.
    const INACTIVE = idOf('005I', 1);
    const sentRow = (n: number): Record<string, unknown> =>
      n === 2 || n === 3 ? contact(n) : { ...contact(n), OwnerId: INACTIVE };
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    const payloads = [1, 2, 3, 4].map(sentRow);
    const fields = fingerprintFields(payloads);
    expect(fields).not.toContain('OwnerId');
    const callId = store.sent(
      'Contact',
      fields,
      [1, 2, 3, 4].map((n, i) => ({
        sourceId: source(n),
        fingerprint: rowFingerprint(payloads[i], fields),
      })),
      new Date(SENT_AT),
    );
    store.jobOpened(callId, JOB);
    store.flush();
    const text = disk.text();
    const file = memoryRunFile(text);
    const echoed = (n: number, ownerCell: string): Record<string, unknown> => ({
      ...result(n),
      OwnerId: ownerCell,
    });
    const org = targetWithJob({
      state: 'ended',
      info: { state: 'JobComplete' },
      results: {
        successfulResults: [
          echoed(1, INACTIVE),
          echoed(2, ''),
          echoed(3, USER),
          echoed(4, INACTIVE),
        ],
        failedResults: [],
      },
    });

    const outcome = await reconcileInFlight(file, org);

    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 4 }]);
    expect(outcome.notFound).toEqual([]);
    expect(uncertainRows(outcome)).toBe(0);
    expect(
      added(text, file.text())
        .filter(([tag]) => tag === 'c')
        .map(([, from, to]) => [from, to]),
    ).toEqual([1, 2, 3, 4].map((n) => [source(n), target(n)]));
  });

  it('takes the records a job wrote under no row for none of a REST call’s rows', async () => {
    // The run kept, under no row, a record its job wrote; a REST call of the
    // same object was under way when it stopped, its row carrying the same
    // values: the record is the job's, not the call's row.
    const disk = memoryRunFile(HEAD);
    const store = ForgeRunStore.open(disk);
    store.beginPart(new Date(SENT_AT));
    store.createdUnattributed('Contact', [target(1)]);
    const payloads = [contact(1)];
    const fields = fingerprintFields(payloads);
    store.sent(
      'Contact',
      fields,
      [{ sourceId: source(1), fingerprint: rowFingerprint(payloads[0], fields) }],
      new Date(SENT_AT),
    );
    store.flush();
    const file = memoryRunFile(disk.text());

    const outcome = await reconcileInFlight(file, targetHolding([held(1)]));

    expect(outcome.found).toEqual([]);
  });

  it('leaves the rows of a job still running uncertain and its call open, and the rows of one never closed to the resume', async () => {
    const running = memoryRunFile(jobJournal([1, 2]));
    const before = running.text();
    const stillRunning = await reconcileInFlight(running, targetWithJob({ state: 'running' }));
    expect(uncertainRows(stillRunning)).toBe(2);
    expect(running.text()).toBe(before);

    const neverClosed = memoryRunFile(jobJournal([1, 2]));
    const text = neverClosed.text();
    const closed = await reconcileInFlight(neverClosed, targetWithJob({ state: 'never-closed' }));
    expect(closed.notFound).toEqual([{ objectApiName: 'Contact', rows: 2 }]);
    expect(added(text, neverClosed.text())).toEqual([['a', expect.any(String)]]);
  });

  it('says why a job could not be read, its rows uncertain', async () => {
    const file = memoryRunFile(jobJournal([1]));

    const outcome = await reconcileInFlight(
      file,
      targetWithJob({ state: 'unread', reason: 'INVALIDJOB: no such job' }),
    );

    expect(outcome.unread).toEqual([
      { objectApiName: 'Contact', reason: 'INVALIDJOB: no such job' },
    ]);
    expect(uncertainRows(outcome)).toBe(1);
  });

  it('looks for the rows of a call sent before its job opened in the window, as a REST call’s', async () => {
    const text = jobJournal([1], false);
    const file = memoryRunFile(text);
    const org = { ...targetHolding([held(1)]), readJob: vi.fn() };

    const outcome = await reconcileInFlight(file, org);

    expect(org.readJob).not.toHaveBeenCalled();
    expect(outcome.found).toEqual([{ objectApiName: 'Contact', rows: 1 }]);
  });
});
