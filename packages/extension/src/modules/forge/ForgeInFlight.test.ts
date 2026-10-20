import { describe, it, expect, vi } from 'vitest';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import {
  IN_FLIGHT_LEAD_MS,
  IN_FLIGHT_TRAIL_MS,
  fingerprintFields,
  inFlightLines,
  reconcileInFlight,
  rowFingerprint,
  uncertainRows,
  type InFlightTarget,
} from './ForgeInFlight.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
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
    });
    const lines = added(text, file.text());
    expect(lines.filter(([tag]) => tag === 'c')).toEqual([
      ['c', source(3), target(3), 'Contact', 'found'],
      ['c', source(4), target(4), 'Contact', 'found'],
      ['c', source(5), target(5), 'Contact', 'found'],
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
    expect(file.text()).toContain(JSON.stringify(['c', source(1), target(8), 'Contact', 'found']));
    expect(file.text()).toContain(JSON.stringify(['c', source(2), target(9), 'Contact', 'found']));
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
      ['c', source(3), target(3), 'Contact', 'found'],
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
});
