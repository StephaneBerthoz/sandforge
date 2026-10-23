import { describe, it, expect } from 'vitest';
import {
  MEMORY_ORG_FACTS,
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  factCombinations,
  type MemoryChild,
  type MemoryOrgOptions,
  type MemoryQueryPage,
  type MemorySubAnswer,
} from './memoryRemovalOrg';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const OTHER_USER = '005000000000002AAA';
const ACCOUNT = fakeId('001', 1);
const SECOND_ACCOUNT = fakeId('001', 2);
const CONTACT = fakeId('003', 1);
const SECOND_CONTACT = fakeId('003', 2);
const BOSS = fakeId('003', 3);
const REPORT = fakeId('003', 4);
const OPPORTUNITY = fakeId('006', 1);
const PRODUCT_LINE = fakeId('00k', 1);

const RELATIONSHIPS: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
  Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
  ],
};

/** An org on a clock the test moves, from 20:17:20.966 on a day of the probes. */
function orgAt(options: Omit<MemoryOrgOptions, 'now'> = {}, children = RELATIONSHIPS) {
  let now = Date.parse('2026-10-22T20:17:20.966Z');
  const org = new MemoryRemovalOrg(children, { ...options, now: () => now });
  return {
    org,
    /** Move the org's clock on by `ms`. */
    wait: (ms: number) => {
      now += ms;
    },
  };
}

/** One record of an object, live or in the bin, as queryAll reads it. */
async function recordOf(org: MemoryRemovalOrg, object: string, id: string) {
  const answer = await org.queryAll(
    `SELECT Id, IsDeleted, SystemModstamp, LastModifiedDate, LastModifiedById, AccountId, ReportsToId FROM ${object} WHERE Id = '${id}'`,
  );
  return answer.records[0];
}

const WHEN = '2026-10-01T08:00:00.000Z';

/** An account with two contacts, one reporting to the other, all dated `WHEN`. */
function seeded(options: Omit<MemoryOrgOptions, 'now'> = {}) {
  const made = orgAt(options);
  made.org.add('Account', { Id: ACCOUNT, Name: 'Acme', LastModifiedById: OTHER_USER }, WHEN);
  made.org.add('Contact', { Id: CONTACT, AccountId: ACCOUNT, LastModifiedById: OTHER_USER }, WHEN);
  made.org.add(
    'Contact',
    { Id: SECOND_CONTACT, AccountId: ACCOUNT, LastModifiedById: OTHER_USER },
    WHEN,
  );
  return made;
}

describe('MemoryRemovalOrg', () => {
  describe('reads', () => {
    it('reads the rows a statement names, column by column, by either length of id', async () => {
      const org = new MemoryRemovalOrg();
      org.add('Account', { Id: ACCOUNT, Name: 'Acme' }, '2026-10-14T08:00:00.000Z');

      const answer = await org.query(
        `SELECT Id, LastModifiedDate FROM Account WHERE Id IN ('${ACCOUNT.slice(0, 15)}')`,
      );

      expect(answer.records).toEqual([
        { Id: ACCOUNT, LastModifiedDate: '2026-10-14T08:00:00.000Z' },
      ]);
    });

    it('refuses a statement it cannot read, rather than select nothing', async () => {
      const org = new MemoryRemovalOrg();
      await expect(org.query("SELECT Id FROM Account WHERE Name LIKE 'A%'")).rejects.toThrow();
      await expect(org.query('SELECT Account.Name FROM Contact')).rejects.toThrow();
    });

    it('dates a row it takes in now, to the second, its system stamp with its modified date', async () => {
      const { org } = orgAt();
      org.add('Account', { Id: ACCOUNT });
      org.add('Account', { Id: SECOND_ACCOUNT, LastModifiedDate: WHEN });

      expect(org.all('Account')).toEqual([
        expect.objectContaining({
          CreatedDate: '2026-10-22T20:17:20.000Z',
          SystemModstamp: '2026-10-22T20:17:20.000Z',
          IsDeleted: false,
        }),
        expect.objectContaining({ SystemModstamp: WHEN }),
      ]);
    });

    it('leaves deleted records and archived activities out of a plain query, and reads both through queryAll', async () => {
      const { org } = seeded();
      org.add('Task', { Id: fakeId('00T', 1), Status: 'Completed' }, WHEN);
      org.add('Task', { Id: fakeId('00T', 2), Status: 'Open' }, WHEN);
      org.archive('Task', fakeId('00T', 1));
      org.trash('Contact', CONTACT);

      expect((await org.query('SELECT COUNT() FROM Task')).totalSize).toBe(1);
      expect((await org.query('SELECT COUNT() FROM Contact')).totalSize).toBe(1);
      expect(
        (await org.query('SELECT COUNT() FROM Task WHERE IsDeleted = false', { scanAll: true }))
          .totalSize,
      ).toBe(2);
      expect((await org.queryAll('SELECT Id FROM Contact WHERE IsDeleted = true')).records).toEqual(
        [{ Id: CONTACT }],
      );
      expect((await org.queryDeleted('SELECT Id FROM Contact')).records).toHaveLength(2);
    });

    it('answers the one-row pre-check with the latest stamp, live or in the bin, and no row for an empty object', async () => {
      const { org, wait } = seeded();
      wait(5_000);
      org.trash('Contact', SECOND_CONTACT);
      const latest = 'SELECT SystemModstamp FROM Contact ORDER BY SystemModstamp DESC LIMIT 1';

      expect((await org.queryAll(latest)).records).toEqual([
        { SystemModstamp: '2026-10-22T20:17:25.000Z' },
      ]);
      expect((await org.query(latest)).records).toEqual([{ SystemModstamp: WHEN }]);
      expect((await org.queryAll(latest.replace('Contact', 'Event'))).records).toEqual([]);
    });

    it('splits the recycle bin exactly at a stamp written with milliseconds, by count and by id', async () => {
      const { org, wait } = seeded();
      org.add('Contact', { Id: BOSS }, WHEN);
      org.trash('Contact', CONTACT);
      wait(1_000);
      org.trash('Contact', SECOND_CONTACT);
      wait(1_000);
      org.trash('Contact', BOSS);
      // The second deletion's second, half a second in: it counts from that second's start.
      const at = '2026-10-22T20:17:21.500Z';

      const before = await org.queryAll(
        `SELECT Id FROM Contact WHERE IsDeleted = true AND SystemModstamp < ${at}`,
      );
      const after = await org.queryAll(
        `SELECT Id FROM Contact WHERE IsDeleted = true AND SystemModstamp >= ${at}`,
      );

      expect(before.records).toEqual([{ Id: CONTACT }]);
      expect(after.records).toEqual([{ Id: SECOND_CONTACT }, { Id: BOSS }]);
    });

    it('refuses to read an object it is told the org will not read whole, with the org’s words', async () => {
      const org = new MemoryRemovalOrg();
      org.refuseRead.set('ContentDocumentLink', {
        errorCode: 'MALFORMED_QUERY',
        message: 'Implementation restriction: filter by Id',
      });

      await expect(org.query('SELECT Id FROM ContentDocumentLink')).rejects.toMatchObject({
        errorCode: 'MALFORMED_QUERY',
      });
    });
  });

  describe('cursors', () => {
    /** An org of `count` accounts. */
    function accounts(count: number, options: Omit<MemoryOrgOptions, 'now'> = {}) {
      const { org } = orgAt(options, {});
      for (let n = 1; n <= count; n++) org.add('Account', { Id: fakeId('001', n) }, WHEN);
      return org;
    }

    /** Every row behind a query, page by page. */
    async function drain(org: MemoryRemovalOrg, first: MemoryQueryPage): Promise<number[]> {
      const sizes = [first.records.length];
      let page = first;
      while (!page.done && page.nextRecordsUrl) {
        page = await org.queryMore(page.nextRecordsUrl);
        sizes.push(page.records.length);
      }
      return sizes;
    }

    it('answers a large read in pages of 2,000 behind a cursor, read to the end', async () => {
      const org = accounts(4_500);

      const first = await org.query('SELECT Id FROM Account');

      expect(first).toMatchObject({ totalSize: 4_500, done: false });
      expect(await drain(org, first)).toEqual([2_000, 2_000, 500]);
      expect(org.openCursors).toBe(0);
    });

    it('pages as unevenly as an org does when told to, so no reader may count on a page size', async () => {
      const org = accounts(4_500, { pageSize: (page) => (page === 0 ? 200 : 2_000 - page * 28) });

      expect(await drain(org, await org.query('SELECT Id FROM Account'))).toEqual([
        200, 1_972, 1_944, 384,
      ]);
    });

    it('keeps every cursor open by default: the oldest of 150 still reads its next page', async () => {
      const org = accounts(201, { pageSize: 200 });
      const oldest = await org.query('SELECT Id FROM Account');
      for (let n = 0; n < 149; n++) await org.query('SELECT Id FROM Account');

      expect(org.openCursors).toBe(150);
      expect((await org.queryMore(oldest.nextRecordsUrl ?? '')).records).toHaveLength(1);
    });

    it('fails the next read of a cursor it released or let expire, never ends it short', async () => {
      const org = accounts(201, { pageSize: 200, cursorLimit: 2 });
      const released = await org.query('SELECT Id FROM Account');
      const kept = await org.query('SELECT Id FROM Account');
      await org.query('SELECT Id FROM Account');

      await expect(org.queryMore(released.nextRecordsUrl ?? '')).rejects.toMatchObject({
        errorCode: 'INVALID_QUERY_LOCATOR',
      });
      expect((await org.queryMore(kept.nextRecordsUrl ?? '')).done).toBe(true);
      const left = await org.query('SELECT Id FROM Account');
      org.expireCursors();
      await expect(org.queryMore(left.nextRecordsUrl ?? '')).rejects.toMatchObject({
        errorCode: 'INVALID_QUERY_LOCATOR',
      });
    });
  });

  describe('the composite call', () => {
    const query = (soql: string, n: number, all = false) => ({
      method: 'GET',
      url: `/services/data/v66.0/${all ? 'queryAll' : 'query'}?q=${encodeURIComponent(soql)}`,
      referenceId: `q${n}`,
    });
    const describeOf = (object: string, n: number, since?: string) => ({
      method: 'GET',
      url: `/services/data/v66.0/sobjects/${object}/describe`,
      referenceId: `d${n}`,
      ...(since ? { httpHeaders: { 'If-Modified-Since': since } } : {}),
    });
    const send = async (org: MemoryRemovalOrg, compositeRequest: unknown[]) =>
      (
        (await org.request({
          method: 'POST',
          url: '/services/data/v66.0/composite',
          body: JSON.stringify({ allOrNone: false, compositeRequest }),
        })) as { compositeResponse: MemorySubAnswer[] }
      ).compositeResponse;

    it('runs five queries and halts the sixth, the call itself answering, as one request', async () => {
      const { org } = seeded();

      const answers = await send(
        org,
        Array.from({ length: 6 }, (_, n) => query('SELECT Id FROM Contact', n, n % 2 === 1)),
      );

      expect(answers.slice(0, 5).map((answer) => answer.httpStatusCode)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      expect(answers[5]).toEqual({
        body: [
          {
            errorCode: 'PROCESSING_HALTED',
            message: 'Limit number of query or Collections in Rest Operations reached.',
          },
        ],
        httpHeaders: {},
        httpStatusCode: 400,
        referenceId: 'q5',
      });
      expect(org.requests).toBe(1);
    });

    it('counts a cursor’s next page among the five, and not a describe', async () => {
      const { org } = orgAt({ pageSize: 1 }, {});
      for (let n = 1; n <= 7; n++) org.add('Account', { Id: fakeId('001', n) }, WHEN);
      const cursors = await Promise.all(
        Array.from({ length: 6 }, () => org.query('SELECT Id FROM Account')),
      );

      const pages = await send(
        org,
        cursors.map((page, n) => ({
          method: 'GET',
          url: page.nextRecordsUrl,
          referenceId: `n${n}`,
        })),
      );
      const mixed = await send(org, [
        ...Array.from({ length: 5 }, (_, n) => query('SELECT Id FROM Account LIMIT 1', n)),
        ...Array.from({ length: 20 }, (_, n) => describeOf('Account', n)),
      ]);

      expect(pages.map((answer) => answer.httpStatusCode)).toEqual([200, 200, 200, 200, 200, 400]);
      expect(pages[0].body).toMatchObject({ records: [{ Id: fakeId('001', 2) }], done: false });
      expect(mixed.every((answer) => answer.httpStatusCode === 200)).toBe(true);
    });

    it('refuses a call of 26 subrequests whole', async () => {
      const { org } = seeded();

      await expect(
        send(
          org,
          Array.from({ length: 26 }, (_, n) => describeOf('Account', n)),
        ),
      ).rejects.toMatchObject({
        errorCode: 'LIMIT_EXCEEDED',
        message: 'The request can’t contain more than 25 operations.',
      });
    });

    it('answers a describe not modified since a date with 304 and no body, until the schema changes', async () => {
      const { org, wait } = seeded();
      const since = '2026-10-22T20:17:20.000Z';

      const [unchanged] = await send(org, [describeOf('Account', 0, since)]);
      wait(5_000);
      org.changeSchema('Account', [{ name: 'Region__c', type: 'string' }]);
      const [changed] = await send(org, [describeOf('Account', 1, since)]);

      expect(unchanged).toMatchObject({ httpStatusCode: 304, body: null });
      expect(changed).toMatchObject({
        httpStatusCode: 200,
        body: { name: 'Account', fields: [{ name: 'Region__c' }] },
      });
    });

    it('answers a refused read and a released cursor in their own subrequest, the others read', async () => {
      const { org } = seeded();
      org.refuseRead.set('Lead', {
        errorCode: 'INVALID_TYPE',
        message: 'sObject type Lead is not supported',
      });

      const answers = await send(org, [
        query('SELECT Id FROM Lead', 0),
        { method: 'GET', url: '/services/data/v66.0/query/01gMEM99-2000', referenceId: 'n0' },
        query('SELECT Id FROM Account', 1),
      ]);

      expect(answers.map((answer) => [answer.httpStatusCode, answer.body])).toEqual([
        [400, [{ errorCode: 'INVALID_TYPE', message: 'sObject type Lead is not supported' }]],
        [400, [{ errorCode: 'INVALID_QUERY_LOCATOR', message: 'invalid query locator' }]],
        [200, { totalSize: 1, done: true, records: [{ Id: ACCOUNT }] }],
      ]);
    });

    it('refuses a statement naming a field the object does not have, as the org does, and reads one that does not', async () => {
      const { org } = seeded();
      org.missingFields.set('Account', new Set(['CreatedDate']));

      const answers = await send(org, [
        query('SELECT Id FROM Account WHERE CreatedDate >= 2026-01-01T00:00:00Z', 0),
        query('SELECT Id FROM Account', 1),
      ]);

      expect(answers.map((answer) => [answer.httpStatusCode, answer.body])).toEqual([
        [
          400,
          [
            {
              errorCode: 'INVALID_FIELD',
              message: "No such column 'CreatedDate' on entity 'Account'.",
            },
          ],
        ],
        [200, { totalSize: 1, done: true, records: [{ Id: ACCOUNT }] }],
      ]);
    });

    it('answers a read sent alone through the connection, and rejects one the org refuses', async () => {
      const { org } = seeded();

      await expect(
        org.request({
          method: 'GET',
          url: `/query?q=${encodeURIComponent('SELECT Id FROM Account')}`,
        }),
      ).resolves.toMatchObject({ records: [{ Id: ACCOUNT }] });
      await expect(
        org.request({ method: 'GET', url: '/services/data/v66.0/query/01gMEM99-2000' }),
      ).rejects.toMatchObject({ errorCode: 'INVALID_QUERY_LOCATOR' });
    });

    it('counts the SOAP calls apart from the REST requests', async () => {
      const { org } = seeded();
      org.trash('Account', ACCOUNT);

      await org.serverTime();
      await org.undelete([ACCOUNT]);
      await org.query('SELECT Id FROM Account');

      expect({ requests: org.requests, soapCalls: org.soapCalls }).toEqual({
        requests: 1,
        soapCalls: 2,
      });
    });
  });

  describe('deleting', () => {
    it('deletes into its recycle bin, taking along what cascades, and refuses what it is told to', async () => {
      const org = new MemoryRemovalOrg({
        Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
      });
      org.add('Account', { Id: ACCOUNT });
      org.add('Account', { Id: SECOND_ACCOUNT });
      org.add('Contact', { Id: CONTACT, AccountId: ACCOUNT });
      org.refuse.set(SECOND_ACCOUNT, 'locked');

      const answer = await org.destroy('Account', [ACCOUNT, SECOND_ACCOUNT]);

      expect(answer).toEqual([
        { id: ACCOUNT, success: true, errors: [] },
        { success: false, errors: [{ statusCode: 'DELETE_FAILED', message: 'locked' }] },
      ]);
      expect(org.all('Contact')).toEqual([]);
      const bin = await org.queryDeleted(
        `SELECT Id FROM Contact WHERE Id IN ('${CONTACT}') AND IsDeleted = true`,
      );
      expect(bin.records).toEqual([{ Id: CONTACT }]);
    });

    it('stamps a delete to its second, as the deleting user, on the record and on what cascades from it', async () => {
      const { org } = seeded();

      await org.destroy('Account', [ACCOUNT]);

      const deleted = {
        IsDeleted: true,
        SystemModstamp: '2026-10-22T20:17:20.000Z',
        LastModifiedDate: '2026-10-22T20:17:20.000Z',
        LastModifiedById: MEMORY_ORG_USER,
      };
      expect(await recordOf(org, 'Account', ACCOUNT)).toMatchObject(deleted);
      expect(await recordOf(org, 'Contact', CONTACT)).toMatchObject(deleted);
      const since = await org.queryAll(
        'SELECT Id FROM Contact WHERE IsDeleted = true AND SystemModstamp >= 2026-10-22T20:17:20Z',
      );
      expect(since.records).toHaveLength(2);
    });

    it('sends a record to the bin with the stamps it had, when told a delete stamps nothing', async () => {
      const { org } = seeded({ facts: { deleteStamps: false } });

      await org.destroy('Account', [ACCOUNT]);

      expect(await recordOf(org, 'Contact', CONTACT)).toMatchObject({
        IsDeleted: true,
        SystemModstamp: WHEN,
        LastModifiedById: OTHER_USER,
      });
    });

    it('clears a lookup to the deleted record and restamps the child as the deleting user, or leaves its stamps when told', async () => {
      for (const restamps of [true, false]) {
        const { org } = seeded({ facts: { clearedLookupRestamps: restamps } });
        org.add('Contact', { Id: BOSS, LastModifiedById: OTHER_USER }, WHEN);
        org.add('Contact', { Id: REPORT, ReportsToId: BOSS, LastModifiedById: OTHER_USER }, WHEN);

        await org.destroy('Contact', [BOSS]);

        expect(await recordOf(org, 'Contact', REPORT)).toMatchObject(
          restamps
            ? {
                ReportsToId: null,
                SystemModstamp: '2026-10-22T20:17:20.000Z',
                LastModifiedById: MEMORY_ORG_USER,
              }
            : { ReportsToId: null, SystemModstamp: WHEN, LastModifiedById: OTHER_USER },
        );
      }
    });

    it('deletes the parents of a call of several objects first: a child listed before its parent goes with it', async () => {
      const { org } = seeded();

      const answer = await org.destroy('Contact', [CONTACT, SECOND_CONTACT, ACCOUNT]);
      await org.undelete([ACCOUNT]);

      expect(answer).toEqual([
        { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }] },
        { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }] },
        { id: ACCOUNT, success: true, errors: [] },
      ]);
      // Gone with their account, they come back with it.
      expect(org.all('Contact').map((row) => row.Id)).toEqual([CONTACT, SECOND_CONTACT]);
    });

    it('deletes in the order listed when told the org does: the children go alone and stay when the parent comes back', async () => {
      const { org } = seeded({ facts: { parentsDeletedFirst: false } });

      const answer = await org.destroy('Contact', [CONTACT, SECOND_CONTACT, ACCOUNT]);
      await org.undelete([ACCOUNT]);

      expect((answer as Array<{ success: boolean }>).map((one) => one.success)).toEqual([
        true,
        true,
        true,
      ]);
      expect(org.all('Contact')).toEqual([]);
    });

    it('refuses to delete a parent a live child names through a restricted lookup, until the child goes', async () => {
      const { org } = orgAt(
        {},
        {
          Account: [{ childSObject: 'Contract', field: 'AccountId', restrictedDelete: true }],
        },
      );
      org.add('Account', { Id: ACCOUNT });
      org.add('Contract', { Id: fakeId('800', 1), AccountId: ACCOUNT });

      const refused = await org.destroy('Account', [ACCOUNT]);
      await org.destroy('Contract', [fakeId('800', 1)]);
      const deleted = await org.destroy('Account', [ACCOUNT]);

      expect(refused).toEqual([
        {
          success: false,
          errors: [
            {
              statusCode: 'DELETE_FAILED',
              message: `Contract ${fakeId('800', 1)} still names it in AccountId`,
            },
          ],
        },
      ]);
      expect(deleted).toEqual([{ id: ACCOUNT, success: true, errors: [] }]);
      expect((await org.describe('Account')) as object).toMatchObject({
        childRelationships: [{ childSObject: 'Contract', restrictedDelete: true }],
      });
    });

    it('shows a hard-deleted record nowhere, or deleted in queryAll when told; it never comes back', async () => {
      for (const shown of [false, true]) {
        const { org } = seeded({ facts: { hardDeleteInQueryAll: shown } });

        org.hardDelete('Account', ACCOUNT);

        const read = await org.queryAll('SELECT Id, IsDeleted FROM Contact');
        expect(read.records).toEqual(
          shown
            ? [
                { Id: CONTACT, IsDeleted: true },
                { Id: SECOND_CONTACT, IsDeleted: true },
              ]
            : [],
        );
        expect(await org.undelete([ACCOUNT])).toEqual([
          {
            id: ACCOUNT,
            success: false,
            errors: [
              { statusCode: 'UNDELETE_FAILED', message: 'Entity is not in the recycle bin' },
            ],
          },
        ]);
      }
    });
  });

  describe('bringing back', () => {
    it('brings a parent back with the children deleted with it, stamped to its second as the undeleting user', async () => {
      const { org, wait } = seeded();
      await org.destroy('Account', [ACCOUNT]);
      wait(5_765);

      const answer = await org.undelete([ACCOUNT]);

      expect(answer).toEqual([{ id: ACCOUNT, success: true, errors: [] }]);
      const back = {
        IsDeleted: false,
        SystemModstamp: '2026-10-22T20:17:26.000Z',
        LastModifiedDate: '2026-10-22T20:17:26.000Z',
        LastModifiedById: MEMORY_ORG_USER,
      };
      expect(await recordOf(org, 'Account', ACCOUNT)).toMatchObject(back);
      expect(await recordOf(org, 'Contact', CONTACT)).toMatchObject(back);
      expect(await recordOf(org, 'Contact', SECOND_CONTACT)).toMatchObject(back);
    });

    it('leaves the last modifier as it was when told an undelete does not set it, the dates moving all the same', async () => {
      const { org, wait } = seeded({ facts: { undeleterIsLastModifier: false } });
      org.trash('Account', ACCOUNT, OTHER_USER);
      wait(5_000);

      await org.undelete([ACCOUNT]);

      expect(await recordOf(org, 'Contact', CONTACT)).toMatchObject({
        SystemModstamp: '2026-10-22T20:17:25.000Z',
        LastModifiedById: OTHER_USER,
      });
    });

    it('leaves in the bin a child deleted on its own before its parent, its stamp unmoved by either', async () => {
      const { org, wait } = seeded();
      org.trash('Contact', CONTACT);
      wait(3_000);
      org.trash('Account', ACCOUNT);
      wait(3_000);

      await org.undelete([ACCOUNT]);

      expect(org.all('Contact').map((row) => row.Id)).toEqual([SECOND_CONTACT]);
      expect(await recordOf(org, 'Contact', CONTACT)).toMatchObject({
        IsDeleted: true,
        SystemModstamp: '2026-10-22T20:17:20.000Z',
      });
    });

    it('brings back a child deleted on its own with its parent, when told the bin does', async () => {
      const { org, wait } = seeded({ facts: { childDeletedAloneStays: false } });
      org.trash('Contact', CONTACT);
      wait(3_000);
      org.trash('Account', ACCOUNT);

      await org.undelete([ACCOUNT]);

      expect(
        org
          .all('Contact')
          .map((row) => row.Id)
          .sort(),
      ).toEqual([CONTACT, SECOND_CONTACT]);
    });

    it('refuses a child deleted with its parent while the parent is in the bin, or brings it back alone when told', async () => {
      for (const alone of [false, true]) {
        const { org } = seeded({ facts: { cascadeChildComesBackAlone: alone } });
        org.trash('Account', ACCOUNT);

        const answer = await org.undelete([CONTACT]);

        expect(answer).toEqual([
          alone
            ? { id: CONTACT, success: true, errors: [] }
            : {
                id: CONTACT,
                success: false,
                errors: [
                  {
                    statusCode: 'UNDELETE_FAILED',
                    message: 'Its parent is in the recycle bin: undelete the parent first',
                  },
                ],
              },
        ]);
      }
    });

    it('puts back a lookup the delete cleared and restamps the child as the undeleting user, or leaves it cleared when told', async () => {
      for (const restores of [true, false]) {
        const { org, wait } = seeded({ facts: { undeleteRestoresLookups: restores } });
        org.add('Contact', { Id: BOSS }, WHEN);
        org.add('Contact', { Id: REPORT, ReportsToId: BOSS }, WHEN);
        org.trash('Contact', BOSS, OTHER_USER);
        wait(4_000);

        org.untrash(BOSS);

        expect(await recordOf(org, 'Contact', REPORT)).toMatchObject(
          restores
            ? {
                ReportsToId: BOSS,
                SystemModstamp: '2026-10-22T20:17:24.000Z',
                LastModifiedById: MEMORY_ORG_USER,
              }
            : {
                ReportsToId: null,
                SystemModstamp: '2026-10-22T20:17:20.000Z',
                LastModifiedById: OTHER_USER,
              },
        );
      }
    });

    it('brings back a record Salesforce does not undelete on its own only with its parent', async () => {
      const { org } = seeded();
      org.comesBackOnlyWithParent.add('OpportunityLineItem');
      org.add('Opportunity', { Id: OPPORTUNITY, AccountId: ACCOUNT }, WHEN);
      org.add('OpportunityLineItem', { Id: PRODUCT_LINE, OpportunityId: OPPORTUNITY }, WHEN);
      org.add('OpportunityLineItem', { Id: fakeId('00k', 2), OpportunityId: OPPORTUNITY }, WHEN);
      org.trash('OpportunityLineItem', fakeId('00k', 2));
      org.trash('Opportunity', OPPORTUNITY);

      const alone = await org.undelete([fakeId('00k', 2)]);
      await org.undelete([OPPORTUNITY]);

      expect((await org.describe('OpportunityLineItem')) as object).toMatchObject({
        undeletable: false,
      });
      expect(alone).toEqual([
        {
          id: fakeId('00k', 2),
          success: false,
          errors: [
            {
              statusCode: 'UNDELETE_FAILED',
              message:
                'OpportunityLineItem records come back from the recycle bin with their parent only',
            },
          ],
        },
      ]);
      expect(org.all('OpportunityLineItem').map((row) => row.Id)).toEqual([PRODUCT_LINE]);
    });

    it('answers a record no longer in the bin as not there', async () => {
      const { org } = seeded();
      org.trash('Contact', CONTACT);
      org.purge(CONTACT);

      expect(await org.undelete([CONTACT, SECOND_CONTACT])).toEqual([
        {
          id: CONTACT,
          success: false,
          errors: [{ statusCode: 'UNDELETE_FAILED', message: 'Entity is not in the recycle bin' }],
        },
        {
          id: SECOND_CONTACT,
          success: false,
          errors: [{ statusCode: 'UNDELETE_FAILED', message: 'Entity is not in the recycle bin' }],
        },
      ]);
    });
  });

  describe('person accounts', () => {
    const PERSON = fakeId('001', 9);
    const PERSON_CONTACT = fakeId('003', 9);

    it('deletes and brings back a person account’s contact with its account, never on its own', async () => {
      // No relationship listed: the contact goes with its account as a person account's, not by a cascade.
      const { org } = orgAt({}, {});
      org.addPersonAccount({ Id: PERSON, LastName: 'Doe' }, PERSON_CONTACT, WHEN);

      const alone = await org.destroy('Contact', [PERSON_CONTACT]);
      await org.destroy('Account', [PERSON]);
      const contactAlone = await org.undelete([PERSON_CONTACT]);
      await org.undelete([PERSON]);

      const refusal = {
        statusCode: 'INVALID_PERSON_ACCOUNT_OPERATION',
        message:
          "You can't create or delete a person contact on its own: delete or modify the account instead.",
      };
      expect(alone).toEqual([{ success: false, errors: [refusal] }]);
      expect(contactAlone).toEqual([
        {
          id: PERSON_CONTACT,
          success: false,
          errors: [{ ...refusal, statusCode: 'UNDELETE_FAILED' }],
        },
      ]);
      expect(org.all('Account')).toEqual([
        expect.objectContaining({
          Id: PERSON,
          IsPersonAccount: true,
          PersonContactId: PERSON_CONTACT,
        }),
      ]);
      expect(org.all('Contact')).toEqual([
        expect.objectContaining({ Id: PERSON_CONTACT, AccountId: PERSON, IsPersonAccount: true }),
      ]);
    });
  });

  describe('changes made in the org', () => {
    it('stamps an edit to its second as who made it, and moves both dates on a touch', async () => {
      const { org } = seeded();

      org.edit('Contact', CONTACT, { LastName: 'Changed' }, OTHER_USER);
      org.touch('Contact', SECOND_CONTACT, '2026-10-22T09:00:00.000Z');

      expect(org.all('Contact')).toEqual([
        expect.objectContaining({
          LastName: 'Changed',
          SystemModstamp: '2026-10-22T20:17:20.000Z',
          LastModifiedById: OTHER_USER,
        }),
        expect.objectContaining({
          SystemModstamp: '2026-10-22T09:00:00.000Z',
          LastModifiedDate: '2026-10-22T09:00:00.000Z',
        }),
      ]);
      expect(() => org.edit('Contact', BOSS, {})).toThrow();
    });
  });

  describe('facts', () => {
    it('holds by default to what the live probes saw', () => {
      expect(new MemoryRemovalOrg().facts).toEqual(MEMORY_ORG_FACTS);
      expect(MEMORY_ORG_FACTS).toEqual({
        deleteStamps: true,
        childDeletedAloneStays: true,
        undeleterIsLastModifier: true,
        clearedLookupRestamps: true,
        undeleteRestoresLookups: true,
        hardDeleteInQueryAll: false,
        parentsDeletedFirst: true,
        cascadeChildComesBackAlone: false,
      });
    });

    it('gives every combination of the facts named, each once', () => {
      const combinations = factCombinations(['deleteStamps', 'hardDeleteInQueryAll']);

      expect(combinations).toEqual([
        { ...MEMORY_ORG_FACTS, deleteStamps: true, hardDeleteInQueryAll: false },
        { ...MEMORY_ORG_FACTS, deleteStamps: true, hardDeleteInQueryAll: true },
        { ...MEMORY_ORG_FACTS, deleteStamps: false, hardDeleteInQueryAll: false },
        { ...MEMORY_ORG_FACTS, deleteStamps: false, hardDeleteInQueryAll: true },
      ]);
      expect(factCombinations()).toHaveLength(2 ** Object.keys(MEMORY_ORG_FACTS).length);
    });

    it('brings every record of a deleted family back with its id under every combination', async () => {
      for (const facts of factCombinations()) {
        const { org, wait } = seeded({ facts });
        org.add('Contact', { Id: REPORT, ReportsToId: CONTACT }, WHEN);
        wait(2_000);
        await org.destroy('Account', [ACCOUNT, SECOND_ACCOUNT]);
        wait(2_000);

        const answer = await org.undelete([ACCOUNT]);

        expect(answer, JSON.stringify(facts)).toEqual([{ id: ACCOUNT, success: true, errors: [] }]);
        expect(
          org
            .all('Contact')
            .map((row) => row.Id)
            .sort(),
        ).toEqual([CONTACT, SECOND_CONTACT, REPORT].sort());
        expect(org.inBin('Contact')).toEqual([]);
        expect((await recordOf(org, 'Contact', REPORT)).ReportsToId).toBe(
          facts.undeleteRestoresLookups ? CONTACT : null,
        );
      }
    });
  });
});
