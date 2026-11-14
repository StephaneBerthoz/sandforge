/**
 * Two orgs in memory for the clone's command line run from records
 * (`--query`, `--record` given more than once): the source answers its
 * statements as the org does (`SampleSourceOrg`: lists of ids, ORDER BY,
 * LIMIT, pages, a column its describe does not list refused, every request
 * counted), with three accounts — two of them in the Energy industry — their
 * contacts and opportunities, and a case under the third; the target creates
 * what it is sent, each record with an id of its own, and answers every read
 * empty but its Organization record and `/limits`.
 *
 * Lives under `cli/testing/`: a helper, not a suite.
 */

import type { Connection, DescribeSObjectResult } from 'jsforce';
import { SampleSourceOrg } from '../../src/test/sampleSourceOrg.js';

export const SOURCE_ORG = '00D000000000001AAA';
export const TARGET_ORG = '00D000000000002AAA';
export const RUN_USER = '005000000000009AAA';

/** A fake id of the source: the object's prefix, `S`, a counter; the length of a real one. */
export function sourceId(prefix: string, n: number): string {
  return `${prefix}S${String(n).padStart(11, '0')}AAA`;
}

/** The records of the source, by the name the tests give them. */
export const ROWS = {
  energyOne: sourceId('001', 1),
  energyTwo: sourceId('001', 2),
  retail: sourceId('001', 3),
  contactOfEnergyOne: sourceId('003', 1),
  otherContactOfEnergyOne: sourceId('003', 2),
  contactOfEnergyTwo: sourceId('003', 3),
  contactOfRetail: sourceId('003', 4),
  caseOfRetail: sourceId('500', 1),
} as const;

/** A field of a describe, as both fake orgs give it. */
function described(field: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    createable: true,
    updateable: true,
    nillable: true,
    referenceTo: [],
    relationshipName: null,
    cascadeDelete: false,
    groupable: true,
    sortable: true,
    aggregatable: true,
    ...field,
  };
}

/** An object as both fake orgs describe it, with its creation date and deletion flag. */
function object(
  name: string,
  keyPrefix: string,
  fields: Array<Record<string, unknown>>,
  childRelationships: Array<Record<string, unknown>> = [],
): DescribeSObjectResult {
  return {
    name,
    keyPrefix,
    createable: true,
    recordTypeInfos: [],
    childRelationships,
    fields: [
      { name: 'Id', type: 'id', createable: false, updateable: false, nillable: false },
      { name: 'CreatedDate', type: 'datetime', createable: false, updateable: false },
      { name: 'IsDeleted', type: 'boolean', createable: false, updateable: false },
      ...fields,
    ].map(described),
  } as unknown as DescribeSObjectResult;
}

const lookup = (name: string, to: string, relationshipName: string): Record<string, unknown> => ({
  name,
  type: 'reference',
  referenceTo: [to],
  relationshipName,
});

/** What both orgs describe of the objects the clone walks. */
export const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }, { name: 'Industry' }],
    [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities' },
      { childSObject: 'Case', field: 'AccountId', relationshipName: 'Cases' },
    ],
  ),
  Contact: object(
    'Contact',
    '003',
    [{ name: 'LastName' }, { name: 'Department' }, lookup('AccountId', 'Account', 'Account')],
    [{ childSObject: 'Case', field: 'ContactId', relationshipName: 'Cases' }],
  ),
  Opportunity: object('Opportunity', '006', [
    { name: 'Name' },
    { name: 'StageName' },
    { name: 'CloseDate', type: 'date' },
    lookup('AccountId', 'Account', 'Account'),
  ]),
  Case: object('Case', '500', [
    { name: 'Subject' },
    lookup('AccountId', 'Account', 'Account'),
    lookup('ContactId', 'Contact', 'Contact'),
  ]),
};

/** The objects each org lists. */
function globalOf() {
  return [
    ...Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    { name: 'User', keyPrefix: '005' },
  ].map((entry) => ({
    ...entry,
    queryable: true,
    createable: true,
    updateable: true,
    deletable: true,
    customSetting: false,
    layoutable: true,
  }));
}

/** What `/limits` says of an org with room to spare. */
export const LIMITS = {
  DataStorageMB: { Max: 1_000, Remaining: 900 },
  DailyApiRequests: { Max: 100_000, Remaining: 90_000 },
  DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
  FileStorageMB: { Max: 1_000, Remaining: 900 },
};

/**
 * The source: three accounts, the first two in the Energy industry, made a
 * minute apart; two contacts under the first, one under each of the others;
 * an opportunity under each account; a case under the third, of its contact.
 */
export function rootsSource(): SampleSourceOrg {
  const org = new SampleSourceOrg();
  for (const [name, describe] of Object.entries(DESCRIBES)) {
    org.columns.set(
      name,
      describe.fields.map((field) => field.name),
    );
  }
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  const account = (id: string, name: string, industry: string, n: number) =>
    org.add('Account', {
      Id: id,
      Name: name,
      Industry: industry,
      CreatedDate: at(n),
      IsDeleted: false,
    });
  account(ROWS.energyOne, 'Energy one', 'Energy', 1);
  account(ROWS.energyTwo, 'Energy two', 'Energy', 2);
  account(ROWS.retail, 'Retail', 'Retail', 3);
  const contact = (id: string, lastName: string, accountId: string, n: number) =>
    org.add('Contact', {
      Id: id,
      LastName: lastName,
      Department: 'Sales',
      AccountId: accountId,
      CreatedDate: at(n),
      IsDeleted: false,
    });
  contact(ROWS.contactOfEnergyOne, 'One', ROWS.energyOne, 4);
  contact(ROWS.otherContactOfEnergyOne, 'One bis', ROWS.energyOne, 5);
  contact(ROWS.contactOfEnergyTwo, 'Two', ROWS.energyTwo, 6);
  contact(ROWS.contactOfRetail, 'Retail', ROWS.retail, 7);
  [ROWS.energyOne, ROWS.energyTwo, ROWS.retail].forEach((accountId, i) =>
    org.add('Opportunity', {
      Id: sourceId('006', i + 1),
      Name: `Deal ${i + 1}`,
      StageName: 'Prospecting',
      CloseDate: '2026-12-31',
      AccountId: accountId,
      CreatedDate: at(8 + i),
      IsDeleted: false,
    }),
  );
  org.add('Case', {
    Id: ROWS.caseOfRetail,
    Subject: 'Retail case',
    AccountId: ROWS.retail,
    ContactId: ROWS.contactOfRetail,
    CreatedDate: at(11),
    IsDeleted: false,
  });
  return org;
}

const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

/** What an org answers of its Organization record: a sandbox. */
function organizationOf(soql: string, id: string) {
  if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
    return page([{ Id: id, IsSandbox: true }]);
  }
  if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') return page([{}]);
  return undefined;
}

/** A request the source is sent: a statement, the next page of one, or a REST call. */
type SourceRequest =
  string | { url: string; soql?: string; all?: boolean; next?: string; method?: string };

/**
 * The source as the command reaches it: its statements answered by `org`, an
 * object it does not hold answered empty. Each statement and each next page
 * goes through its `request`, as jsforce's do: what counts a connection's
 * requests (`countRequests`) counts them.
 */
export function sourceConn(org: SampleSourceOrg): Connection {
  const answer = async (soql: string, all: boolean) => {
    const organization = organizationOf(soql, SOURCE_ORG);
    if (organization) return organization;
    try {
      return all ? await org.queryAll(soql) : await org.query(soql);
    } catch (err: unknown) {
      if ((err as { errorCode?: string }).errorCode === 'INVALID_TYPE') return page([]);
      throw err;
    }
  };
  const conn = {
    version: '62.0',
    sobject: (name: string) => ({ describe: async () => DESCRIBES[name] }),
    describeGlobal: async () => ({ sobjects: globalOf() }),
    identity: async () => ({ user_id: RUN_USER }),
    query: (soql: string, options?: { scanAll?: boolean }) =>
      conn.request({ url: '/query', soql, all: options?.scanAll === true }),
    queryMore: (next: string) => conn.request({ url: '/query/next', next }),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: SourceRequest): Promise<unknown> => {
      if (typeof request !== 'string' && request.soql !== undefined) {
        return answer(request.soql, request.all === true);
      }
      if (typeof request !== 'string' && request.next !== undefined) {
        return org.queryMore(request.next);
      }
      const url = typeof request === 'string' ? request : request.url;
      if (url === '/limits') return LIMITS;
      return {};
    },
  };
  return conn as unknown as Connection;
}

/** A call the target was sent: the object, and its rows. */
export interface TargetCreate {
  name: string;
  rows: Array<Record<string, unknown>>;
}

/**
 * The target: it creates what it is sent, and answers every read empty but
 * its Organization record. `onCreate` hears each call before it is answered.
 */
export function targetConn(onCreate?: (call: TargetCreate) => void): {
  conn: Connection;
  creates: TargetCreate[];
} {
  const creates: TargetCreate[] = [];
  let made = 0;
  const idOf = (name: string): string =>
    `${DESCRIBES[name]?.keyPrefix ?? 'a09'}T${String(made++).padStart(11, '0')}AAA`;
  const conn = {
    version: '62.0',
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: Array<Record<string, unknown>>) => {
        const call = { name, rows: records };
        creates.push(call);
        onCreate?.(call);
        return records.map(() => ({ id: idOf(name), success: true, errors: [] }));
      },
      update: async (records: Array<Record<string, unknown>>) =>
        records.map((record) => ({ id: record['Id'], success: true, errors: [] })),
    }),
    describeGlobal: async () => ({ sobjects: globalOf() }),
    identity: async () => ({ user_id: RUN_USER }),
    query: async (soql: string) => organizationOf(soql, TARGET_ORG) ?? page([]),
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url === '/limits') return LIMITS;
      return {};
    },
  };
  return { conn: conn as unknown as Connection, creates };
}

/** The source ids the target was sent, per object, in the order sent. */
export function sentNames(creates: readonly TargetCreate[]): Record<string, string[]> {
  const sent: Record<string, string[]> = {};
  for (const { name, rows } of creates) {
    for (const row of rows) {
      (sent[name] ??= []).push(String(row['Name'] ?? row['LastName'] ?? row['Subject']));
    }
  }
  return sent;
}
