import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckpointReplayAnnex } from '@sandforge/shared';

import { MEMORY_ORG_USER, orgError } from '../../../test/memoryRemovalOrg.js';
import {
  COLLEAGUE,
  FIELDS,
  ORG_ID,
  RewindTestOrg,
  STAMP_FIELDS,
  account,
  book,
  id,
  removeTaken,
  taken,
  writable,
} from '../../../test/rewindTestOrg.js';
import { replayAnnexFileOf } from '../OrgCheckpointStore.js';
import { checkpointDescribeSchema } from '../checkpointFields.js';
import { compositeReader } from '../compositeQueries.js';
import {
  ANNEX_USERS_PER_READ,
  annexCalls,
  hasPersonAccounts,
  holdsCatalog,
  namedUsersOf,
  readReplayAnnex,
  readReplayAnnexOfOrg,
  replayAnnexSummaryOf,
  userLookupsOf,
  writeReplayAnnex,
} from './replayAnnex.js';

vi.mock('../../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The replay annex of a checkpoint on the memory org the rewinds run on: what
 * its records name, what the org answers of its record types, queues, users
 * and standard price book, five statements a call, and the file it is kept
 * in. The org refuses what an org refuses: a column its object does not have
 * (`IsPersonType` of an org without person accounts), a read of an object
 * its user may not read.
 */

const QUEUE = '00G000000000001AAA';
const REVIEWER = '005000000000004AAA';
const RETAIL = '012000000000001AAA';
const PARTNER = '012000000000002AAA';

/** An account owned by a user or a queue, with a reviewer, as an org with person accounts describes it. */
const ACCOUNT_FIELDS = [
  ...STAMP_FIELDS,
  writable('Name'),
  writable('OwnerId', 'reference', { referenceTo: ['Group', 'User'] }),
  writable('Reviewer__c', 'reference', { referenceTo: ['User'] }),
  writable('ParentId', 'reference', { referenceTo: ['Account'] }),
  // Set by a flow, never by a person: the take keeps it, a replay does not set it.
  writable('Approver__c', 'reference', { referenceTo: ['User'], createable: false }),
  writable('RecordTypeId', 'reference', { referenceTo: ['RecordType'] }),
  { name: 'IsPersonAccount', label: 'Is Person Account', type: 'boolean' },
];

/** An org of accounts with owners, a reviewer, a queue and two record types. */
function annexOrg(options: { personAccounts?: boolean } = {}): RewindTestOrg {
  const org = new RewindTestOrg({
    fields: {
      ...FIELDS,
      Account:
        options.personAccounts === false
          ? ACCOUNT_FIELDS.filter((field) => field.name !== 'IsPersonAccount')
          : ACCOUNT_FIELDS,
    },
  });
  org.add('User', {
    Id: MEMORY_ORG_USER,
    Username: 'ada@example.com.uat',
    Name: 'Ada Admin',
    IsActive: true,
    UserType: 'Standard',
  });
  org.add('User', {
    Id: COLLEAGUE,
    Username: 'grace@example.com.uat',
    Name: 'Grace Tester',
    IsActive: false,
    UserType: 'Standard',
  });
  org.add('User', {
    Id: REVIEWER,
    Username: 'reviewer@example.com.uat',
    Name: 'Rhea Reviewer',
    IsActive: true,
    UserType: 'Standard',
  });
  org.add('RecordType', {
    Id: RETAIL,
    SobjectType: 'Account',
    DeveloperName: 'Retail',
    NamespacePrefix: null,
    Name: 'Retail',
    IsActive: true,
    IsPersonType: true,
  });
  org.add('RecordType', {
    Id: PARTNER,
    SobjectType: 'Account',
    DeveloperName: 'Partner',
    NamespacePrefix: 'acme',
    Name: 'Partner',
    IsActive: false,
    IsPersonType: false,
  });
  org.add('Group', {
    Id: QUEUE,
    DeveloperName: 'Escalations',
    Name: 'Escalations desk',
    Type: 'Queue',
  });
  org.add('Group', {
    Id: '00G000000000002AAA',
    DeveloperName: 'All_Staff',
    Name: 'All staff',
    Type: 'Regular',
  });
  org.add('QueueSobject', { Id: '03g000000000001AAA', QueueId: QUEUE, SobjectType: 'Lead' });
  org.add('QueueSobject', { Id: '03g000000000002AAA', QueueId: QUEUE, SobjectType: 'Case' });
  org.add('Pricebook2', { Id: book(1), IsStandard: true });
  org.add('Pricebook2', { Id: book(2), IsStandard: false });
  if (options.personAccounts === false) {
    org.missingFields.set('RecordType', new Set(['IsPersonType']));
  }
  return org;
}

/** Accounts owned by a user, an inactive user and a queue, one reviewed: what the snapshot holds. */
function ownedAccounts(org: RewindTestOrg): void {
  org.add('Account', {
    Id: account(1),
    Name: 'One',
    OwnerId: MEMORY_ORG_USER,
    RecordTypeId: RETAIL,
  });
  org.add('Account', {
    Id: account(2),
    Name: 'Two',
    OwnerId: COLLEAGUE.slice(0, 15),
    Reviewer__c: REVIEWER,
    ParentId: account(1),
  });
  org.add('Account', { Id: account(3), Name: 'Three', OwnerId: QUEUE, Approver__c: COLLEAGUE });
}

const dirs: string[] = [];

afterEach(() => {
  removeTaken();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder that stands for a checkpoint's. */
function folder(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-annex-'));
  dirs.push(dir);
  return { dir };
}

/** An annex as a take of {@link annexOrg} keeps it. */
function annexOfOrg(): CheckpointReplayAnnex {
  return {
    version: 1,
    organizationId: ORG_ID,
    recordTypes: [
      {
        id: RETAIL,
        sobjectType: 'Account',
        developerName: 'Retail',
        name: 'Retail',
        isActive: true,
        isPersonType: true,
      },
    ],
    users: [
      {
        id: MEMORY_ORG_USER,
        username: 'ada@example.com.uat',
        name: 'Ada Admin',
        isActive: true,
        userType: 'Standard',
      },
    ],
    queues: [
      {
        id: QUEUE,
        developerName: 'Escalations',
        name: 'Escalations desk',
        sobjectTypes: ['Case', 'Lead'],
      },
    ],
    standardPricebookId: book(1),
    unread: [],
  };
}

describe('what the records of a checkpoint name', () => {
  it('names the lookups to a user a replay sets — the owner and the others a record is created with — never who created or changed it, nor a lookup the org sets itself', () => {
    const describe = checkpointDescribeSchema.parse({ name: 'Account', fields: ACCOUNT_FIELDS });
    const kept = [
      'Id',
      'CreatedById',
      'LastModifiedById',
      'Name',
      'OwnerId',
      'Reviewer__c',
      'ParentId',
      'Approver__c',
    ];

    expect(userLookupsOf(describe, kept)).toEqual(['OwnerId', 'Reviewer__c']);
    expect(userLookupsOf(describe, ['Id', 'Name'])).toEqual([]);
  });

  it('reads the users the snapshot names, by their 18-character ids, once each, and no queue', async () => {
    const org = annexOrg();
    const t = await taken(ownedAccounts, org, ['Account']);

    const users = await namedUsersOf(t.folder, t.checkpoint.snapshotId, [
      { objectApiName: 'Account', userLookups: ['OwnerId', 'Reviewer__c'] },
    ]);

    // The inactive owner was held by its 15-character id; the queue is no user.
    expect(users).toEqual([MEMORY_ORG_USER, COLLEAGUE, REVIEWER].sort());
  });

  it('tells an org with person accounts by its describes, and a checkpoint that holds the catalog by its objects', () => {
    const withFlag = checkpointDescribeSchema.parse({ name: 'Account', fields: ACCOUNT_FIELDS });
    const without = checkpointDescribeSchema.parse({ name: 'Account', fields: FIELDS.Account });
    expect(hasPersonAccounts([without, withFlag])).toBe(true);
    expect(hasPersonAccounts([without])).toBe(false);
    expect(holdsCatalog(['Account', 'PricebookEntry'])).toBe(true);
    expect(holdsCatalog(['Account', 'Opportunity'])).toBe(false);
  });
});

describe('the annex read of the org', () => {
  it('keeps every record type with its developer name and namespace, every queue with its objects, the users named and the standard price book, in one call', async () => {
    const org = annexOrg();
    const before = org.requests;

    const annex = await readReplayAnnexOfOrg({
      reader: compositeReader(org),
      organizationId: ORG_ID,
      personAccounts: true,
      catalog: true,
      users: [MEMORY_ORG_USER, COLLEAGUE, REVIEWER],
    });

    expect(annex.unread).toEqual([]);
    expect(annex.recordTypes).toEqual([
      {
        id: PARTNER,
        sobjectType: 'Account',
        developerName: 'Partner',
        namespacePrefix: 'acme',
        name: 'Partner',
        isActive: false,
        isPersonType: false,
      },
      {
        id: RETAIL,
        sobjectType: 'Account',
        developerName: 'Retail',
        name: 'Retail',
        isActive: true,
        isPersonType: true,
      },
    ]);
    expect(annex.queues).toEqual([
      {
        id: QUEUE,
        developerName: 'Escalations',
        name: 'Escalations desk',
        sobjectTypes: ['Case', 'Lead'],
      },
    ]);
    expect(annex.users.map((user) => [user.username, user.isActive])).toEqual([
      ['ada@example.com.uat', true],
      ['grace@example.com.uat', false],
      ['reviewer@example.com.uat', true],
    ]);
    expect(annex.standardPricebookId).toBe(book(1));
    // Five statements, one composite: what the estimate counts.
    expect(org.requests - before).toBe(1);
    expect(annexCalls({ personAccounts: true, catalog: true })).toBe(1);
  });

  it('asks an org without person accounts no column it does not have, and reads its record types all the same', async () => {
    const org = annexOrg({ personAccounts: false });

    const annex = await readReplayAnnexOfOrg({
      reader: compositeReader(org),
      organizationId: ORG_ID,
      personAccounts: false,
      catalog: false,
      users: [],
    });

    expect(annex.unread).toEqual([]);
    expect(annex.recordTypes.map((type) => type.developerName)).toEqual(['Partner', 'Retail']);
    expect(annex.recordTypes.every((type) => !('isPersonType' in type))).toBe(true);
    // Not asked: the checkpoint holds no catalog.
    expect(annex).not.toHaveProperty('standardPricebookId');
  });

  it('names a part the org refuses, with its words, and keeps the others whole', async () => {
    const org = annexOrg({ personAccounts: false });
    org.refuseRead.set('QueueSobject', {
      errorCode: 'INSUFFICIENT_ACCESS',
      message: 'insufficient access rights on object id',
    });

    // Asked with the column an org with person accounts has: the org refuses it.
    const annex = await readReplayAnnexOfOrg({
      reader: compositeReader(org),
      organizationId: ORG_ID,
      personAccounts: true,
      catalog: true,
      users: [MEMORY_ORG_USER],
    });

    expect(annex.unread.map((each) => each.part)).toEqual(['recordTypes', 'queues']);
    expect(annex.unread[0].reason).toContain("No such column 'IsPersonType'");
    expect(annex.unread[1].reason).toContain('insufficient access');
    expect(annex.recordTypes).toEqual([]);
    expect(annex.queues).toEqual([]);
    expect(annex.users).toHaveLength(1);
    expect(annex.standardPricebookId).toBe(book(1));
    expect(replayAnnexSummaryOf(annex)).toEqual({
      recordTypes: 0,
      users: 1,
      queues: 0,
      standardPricebook: true,
      unread: ['recordTypes', 'queues'],
    });
  });

  it(`reads the users ${ANNEX_USERS_PER_READ} a statement, and names them all unread when one statement fails`, async () => {
    const org = annexOrg();
    const many = Array.from({ length: ANNEX_USERS_PER_READ + 1 }, (_, n) => id('005', 100 + n));
    for (const user of many) {
      org.add('User', {
        Id: user,
        Username: `${user}@example.com`,
        Name: 'Someone',
        IsActive: true,
        UserType: 'Standard',
      });
    }
    const asked: string[] = [];
    const reader = compositeReader({
      get version() {
        return org.version;
      },
      request: (request) => {
        if (typeof request.body === 'string') {
          const body = JSON.parse(request.body) as { compositeRequest?: Array<{ url: string }> };
          for (const sub of body.compositeRequest ?? []) asked.push(decodeURIComponent(sub.url));
        }
        return org.request(request as never);
      },
      query: (soql, options) => org.query(soql, options),
      queryMore: (url) => org.queryMore(url),
    });

    const annex = await readReplayAnnexOfOrg({
      reader,
      organizationId: ORG_ID,
      personAccounts: true,
      catalog: false,
      users: many,
    });

    expect(asked.filter((url) => url.includes('FROM User'))).toHaveLength(2);
    expect(annex.users).toHaveLength(ANNEX_USERS_PER_READ + 1);

    // The second statement alone refused: the first one's users are not kept
    // for all of them.
    const last = many[many.length - 1];
    const refusing = new (class extends RewindTestOrg {
      protected override statementRefusal(objectApiName: string, soql: string): Error | undefined {
        return objectApiName === 'User' && soql.includes(last)
          ? orgError('QUERY_TIMEOUT', 'Your query request was running for too long.')
          : undefined;
      }
    })();
    for (const user of many) {
      refusing.add('User', {
        Id: user,
        Username: `${user}@example.com`,
        Name: 'Someone',
        IsActive: true,
        UserType: 'Standard',
      });
    }
    const refused = await readReplayAnnexOfOrg({
      reader: compositeReader(refusing),
      organizationId: ORG_ID,
      personAccounts: false,
      catalog: false,
      users: many,
    });
    expect(refused.users).toEqual([]);
    expect(refused.unread).toEqual([
      { part: 'users', reason: expect.stringContaining('running for too long') as unknown },
    ]);
  });

  it('refuses to put in a statement what is no user id', async () => {
    await expect(
      readReplayAnnexOfOrg({
        reader: compositeReader(annexOrg()),
        organizationId: ORG_ID,
        personAccounts: true,
        catalog: false,
        users: ["005000000000001AAA') OR (Id != '"],
      }),
    ).rejects.toThrow(/Not a user id/);
  });
});

describe('the file of the annex', () => {
  it('is written whole, its owner’s alone, and read back as it was written', async () => {
    const at = folder();

    const summary = await writeReplayAnnex(at, annexOfOrg());

    expect(summary).toEqual({ recordTypes: 1, users: 1, queues: 1, standardPricebook: true });
    expect(statSync(replayAnnexFileOf(at)).mode & 0o777).toBe(0o600);
    expect(await readReplayAnnex(at)).toEqual(annexOfOrg());
  });

  it('is none for a checkpoint taken before 1.81, which has no file', async () => {
    expect(await readReplayAnnex(folder())).toBeUndefined();
  });

  it('is damaged when it does not inflate, or names an id of another kind than its own', async () => {
    const at = folder();
    writeFileSync(replayAnnexFileOf(at), 'not gzip');
    await expect(readReplayAnnex(at)).rejects.toMatchObject({ code: 'damaged' });

    const forged = { ...annexOfOrg(), standardPricebookId: account(1) };
    writeFileSync(replayAnnexFileOf(at), gzipSync(JSON.stringify(forged)));
    await expect(readReplayAnnex(at)).rejects.toMatchObject({ code: 'damaged' });
  });

  it('is never written of what is no annex', async () => {
    const at = folder();
    const wrong = {
      ...annexOfOrg(),
      queues: [{ ...annexOfOrg().queues[0], developerName: "Q' OR" }],
    };
    await expect(writeReplayAnnex(at, wrong)).rejects.toMatchObject({ code: 'invalid' });
    expect(await readReplayAnnex(at)).toBeUndefined();
  });
});
