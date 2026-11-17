import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import type { WholeOrgSample, WholeOrgSampleResult } from '@sandforge/shared';
import type { WholeOrgConfirmation } from '../src/core/precheck/ProductionGuard.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});
vi.mock('./prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompt.js')>();
  return { ...actual, confirm: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import {
  cliRunSetup,
  fitKeyWords,
  main,
  parseArgs,
  sampleJson,
  sampleLines,
  sampleReadsLine,
  sampleRefusalExit,
  sampleResultJson,
  sampleResultLines,
  wholeOrgQuestionWords,
  wholeOrgRunConfig,
} from './sandforge-clone';
import { forgeRunFingerprint } from '../src/modules/forge/runFingerprint.js';
import { SamplePlan } from '../src/modules/forge/sample/samplePlanStore.js';
import { SampleSourceOrg } from '../src/test/sampleSourceOrg.js';
import { RELAYED_BY_VARIABLE } from './scriptRunner.js';

/*
 * The roots a sample of the whole org draws, chosen on the command line:
 * the oldest first (`--fit-draw oldest`), within a window of dates
 * (`--fit-window`), among the records a condition keeps (`--fit-where`), or
 * by strata (`--fit-strata`). Their flags and their refusals, read before
 * any org is reached; their fingerprint; what the sample's lines, JSON and
 * question say of them; the exits of a draw refused; and the command run
 * whole, in dry runs, against a source that answers as the org does.
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const SOURCE_ORG = '00D000000000001AAA';
const TARGET_ORG = '00D000000000002AAA';
const RUN_USER = '005000000000009AAA';

/** A clone of the whole org of SRC into TGT, with `extra` flags. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    '--depth',
    'all',
    '--source',
    'SRC',
    '--target',
    'TGT',
    '--skip-preflight',
    ...extra,
  ];
}

/** A sample of the whole org of SRC into TGT, with `extra` flags. */
function sampled(...extra: string[]): string[] {
  return argv('--fit', 'share', ...extra);
}

/** Run the command and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(args);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

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

/** An object as both fake orgs describe it, its dates of making and, unless `undated`, of change. */
function object(
  name: string,
  keyPrefix: string,
  fields: Array<Record<string, unknown>>,
  childRelationships: Array<Record<string, unknown>> = [],
  undated = false,
): DescribeSObjectResult {
  const readOnly = { createable: false, updateable: false };
  return {
    name,
    keyPrefix,
    createable: true,
    recordTypeInfos: [],
    childRelationships,
    fields: [
      { name: 'Id', type: 'id', nillable: false, ...readOnly },
      { name: 'CreatedDate', type: 'datetime', ...readOnly },
      ...(undated
        ? []
        : [
            { name: 'LastModifiedDate', type: 'datetime', ...readOnly },
            { name: 'SystemModstamp', type: 'datetime', ...readOnly },
          ]),
      { name: 'IsDeleted', type: 'boolean', ...readOnly },
      ...fields,
    ].map(described),
  } as unknown as DescribeSObjectResult;
}

const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [
      { name: 'Name' },
      {
        name: 'Industry',
        type: 'picklist',
        picklistValues: [
          { value: 'Energy', active: true },
          { value: 'Retail', active: true },
        ],
      },
    ],
    [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
  ),
  // A contact cannot be written without its account.
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    {
      name: 'AccountId',
      type: 'reference',
      referenceTo: ['Account'],
      relationshipName: 'Account',
      nillable: false,
    },
  ]),
  // An object whose describe has no date of change: a window on it cannot date its roots.
  Ticket__c: object('Ticket__c', 'a02', [{ name: 'Name' }], [], true),
};

/** The columns each object answers: its describe's. */
const COLUMNS: Record<string, string[]> = Object.fromEntries(
  Object.values(DESCRIBES).map((d) => [d.name, d.fields.map((f) => f.name)]),
);

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

/** A fake id of the source: the object's prefix, a counter, the length of a real one. */
const sourceId = (prefix: string, n: number): string =>
  `${prefix}S${String(n).padStart(11, '0')}AAA`;

/** The instant the n-th minute of 2026 starts at, as the org writes a date. */
const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

/**
 * The source: 150 accounts, every third of the Energy industry, the others
 * Retail, a contact under each, 50 tickets of their own. Each record is made
 * a minute after the one before it — the accounts, with `datesAgainstIds`,
 * the other way round: their ids then run against the order they were made
 * in, as ids loaded hours apart did on a scratch org.
 */
function sourceOf(datesAgainstIds = false): SampleSourceOrg {
  const org = new SampleSourceOrg();
  for (const [name, columns] of Object.entries(COLUMNS)) org.columns.set(name, columns);
  const dated = (n: number) => ({
    CreatedDate: at(n),
    LastModifiedDate: at(n),
    SystemModstamp: at(n),
    IsDeleted: false,
  });
  for (let n = 1; n <= 150; n++) {
    org.add('Account', {
      Id: sourceId('001', n),
      Name: `Account ${n}`,
      Industry: n % 3 === 0 ? 'Energy' : 'Retail',
      ...dated(datesAgainstIds ? 151 - n : n),
    });
    org.add('Contact', {
      Id: sourceId('003', n),
      LastName: `Contact ${n}`,
      AccountId: sourceId('001', n),
      ...dated(n),
    });
  }
  for (let n = 1; n <= 50; n++) {
    org.add('Ticket__c', {
      Id: sourceId('a02', n),
      Name: `Ticket ${n}`,
      CreatedDate: at(n),
      IsDeleted: false,
    });
  }
  return org;
}

/** What `/limits` says of a sandbox with room to spare. */
const LIMITS = {
  DataStorageMB: { Max: 1_000, Remaining: 900 },
  DailyApiRequests: { Max: 100_000, Remaining: 90_000 },
  DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
  FileStorageMB: { Max: 1_000, Remaining: 900 },
};

const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

/** What both orgs answer of their Organization, a sandbox each. */
function organizationOf(soql: string, id: string) {
  if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
    return page([{ Id: id, IsSandbox: true }]);
  }
  if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') return page([{}]);
  return undefined;
}

/** The source, its statements answered by `org` as the org answers them. */
function sourceConn(org: SampleSourceOrg): Connection {
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
      answer(soql, options?.scanAll === true),
    queryMore: (url: string) => org.queryMore(url),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url === '/limits') return LIMITS;
      if (url.endsWith('/limits/recordCount')) {
        return {
          sObjects: [...org.rows].map(([name, rows]) => ({ name, count: rows.length })),
        };
      }
      return {};
    },
  };
  return conn as unknown as Connection;
}

/**
 * What `/limits` says of a Developer Edition: 5 MB, a room in which 150
 * accounts are drawn, not copied whole as a small parent.
 */
const DEVELOPER_EDITION = { ...LIMITS, DataStorageMB: { Max: 5, Remaining: 5 } };

/** The target, a Developer Edition: it holds nothing, runs no automation, and keeps what it is sent. */
function targetConn() {
  const creates: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
  let made = 0;
  const conn = {
    version: '62.0',
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: Array<Record<string, unknown>>) => {
        creates.push({ name, rows: records });
        return records.map(() => ({
          id: `${DESCRIBES[name]?.keyPrefix ?? 'a09'}T${String(made++).padStart(11, '0')}AAA`,
          success: true,
          errors: [],
        }));
      },
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
      if (url === '/limits') return DEVELOPER_EDITION;
      if (url === '/tooling/composite') return { compositeResponse: [] };
      return {};
    },
  };
  return { conn: conn as unknown as Connection, creates };
}

/** Both fake orgs answering for SRC and TGT. */
function withFakeOrgs(source: SampleSourceOrg = sourceOf()) {
  const target = targetConn();
  const conns = { SRC: sourceConn(source), TGT: target.conn };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
  return { source, target };
}

/** The JSON a dry run of a sample prints, as far as these tests read it. */
interface DryRunJson {
  wholeOrg: { sample: ReturnType<typeof sampleJson> };
}

/** The JSON of a refusal before the first write. */
interface RefusedJson {
  refused: { code: string; message: string };
}

/** The records a plan holds of `objectApiName`, by the number its fake id carries. */
async function numbersOfThePlan(dir: string, objectApiName: string): Promise<number[]> {
  const plan = await SamplePlan.open(dir);
  const numbers: number[] = [];
  for await (const ids of plan.ids(objectApiName)) {
    for (const id of ids) numbers.push(Number(id.slice(4, 15)));
  }
  return numbers.sort((a, b) => a - b);
}

let stdout: string[];
let stderr: string[];
let journalDir: string;
const journalsBefore = process.env['SANDFORGE_JOURNAL_DIR'];

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  journalDir = mkdtempSync(join(tmpdir(), 'sandforge-clone-draw-'));
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    stderr.push(`${String(line)}\n`);
  });
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('sf org display reached');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env['SANDFORGE_JOURNAL_DIR'] = journalsBefore;
  rmSync(journalDir, { recursive: true, force: true });
});

/** The folders of the dry runs' plans under the journal directory. */
function dryRunPlans(): string[] {
  const dir = join(journalDir, 'forge-samples');
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

/** Read the line, expecting a refusal on 2 before any org is reached, and give what it said. */
function refusedOnTheLine(args: string[]): string {
  expect(() => parseArgs(args)).toThrow(ExitCalled);
  expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(loadOrg).not.toHaveBeenCalled();
  return stderr.join('');
}

describe('the flags that choose the roots of a sample', () => {
  it('reads --fit-draw oldest, a window, the filters of the roots and the strata into the options of the sample', () => {
    const args = parseArgs(
      sampled(
        '--fit-draw',
        'oldest',
        '--fit-window',
        'created:2025-01-01..2025-06-30',
        '--fit-where',
        "Account=BillingCountry = 'France'",
        '--fit-where',
        "Lead=Status = 'Open' AND Rating = 'Hot'",
        '--fit-strata',
        'Account.RecordTypeId',
        '--fit-strata',
        'Status',
      ),
    );

    expect(args.sample?.options).toEqual({
      maxTotal: 10_000,
      draw: 'oldest',
      // A date alone starts at 00:00Z; as the end, it takes the whole day.
      window: { field: 'CreatedDate', from: '2025-01-01T00:00:00Z', to: '2025-07-01T00:00:00Z' },
      // Cut at the first =, as --filter is: the condition keeps its own.
      rootWhere: {
        Account: "BillingCountry = 'France'",
        Lead: "Status = 'Open' AND Rating = 'Hot'",
      },
      strata: ['Account.RecordTypeId', 'Status'],
    });
    // The run's config carries them to the executor.
    expect(wholeOrgRunConfig(args).sample).toEqual(args.sample?.options);
  });

  it.each([
    ['modified:90d', { field: 'LastModifiedDate', lastDays: 90 }],
    ['created:1d', { field: 'CreatedDate', lastDays: 1 }],
    ['created:36500d', { field: 'CreatedDate', lastDays: 36_500 }],
    ['created:2025-01-01..', { field: 'CreatedDate', from: '2025-01-01T00:00:00Z' }],
    ['modified:..2025-06-30', { field: 'LastModifiedDate', to: '2025-07-01T00:00:00Z' }],
    // An instant is taken as given, an end too: the window leaves it out.
    [
      'created:2025-01-01T06:30:00Z..2025-01-01T18:00:00Z',
      { field: 'CreatedDate', from: '2025-01-01T06:30:00Z', to: '2025-01-01T18:00:00Z' },
    ],
    // The last day of a leap February, whole.
    [
      'created:2024-02-29..2024-02-29',
      {
        field: 'CreatedDate',
        from: '2024-02-29T00:00:00Z',
        to: '2024-03-01T00:00:00Z',
      },
    ],
  ])('reads --fit-window %s as the window %j', (raw, window) => {
    expect(parseArgs(sampled('--fit-window', raw)).sample?.options.window).toEqual(window);
  });

  it.each([
    [['--fit-window', 'created:2025-01-01']],
    [['--fit-where', 'Account=Name = 1']],
    [['--fit-strata', 'RecordTypeId']],
  ])('refuses %j without --fit share, exit 2, before any org is reached', (flags) => {
    const said = refusedOnTheLine(argv(...flags));
    expect(said).toContain(`${flags[0]} goes with --depth all --fit share`);
  });

  it.each([
    [['--fit-draw', 'newest'], '--fit-draw takes uniform'],
    [['--fit-draw', 'newest'], 'or oldest, the oldest by it, not "newest"'],
    [['--fit-window', '2025-01-01..2025-06-30'], '--fit-window takes created or modified'],
    [['--fit-window', 'made:2025-01-01..'], 'not "made:2025-01-01..".'],
    [['--fit-window', 'created:2025-01-01'], 'not "created:2025-01-01".'],
    [['--fit-window', 'created:..'], ': give a start, an end or both'],
    [['--fit-window', 'created:2025-02-30..'], '"2025-02-30" is no such date'],
    [['--fit-window', 'created:..2025-13-01'], '"2025-13-01" is no such date'],
    [['--fit-window', 'created:2025-01-01T25:00:00Z..'], 'is no such date'],
    [['--fit-window', 'created:2025-01-01+01:00..'], 'is no such date'],
    [
      ['--fit-window', 'created:2025-06-30..2025-01-01'],
      'it starts at 2025-06-30T00:00:00Z and ends before 2025-01-02T00:00:00Z',
    ],
    [
      ['--fit-window', 'created:2025-01-01T12:00:00Z..2025-01-01T12:00:00Z'],
      'so no root is made in it',
    ],
    [['--fit-window', 'created:0d'], '0 days is out of 1 to 36500'],
    [['--fit-window', 'created:36501d'], '36501 days is out of 1 to 36500'],
    [['--fit-window', 'modified:-3d'], '--fit-window takes created or modified'],
    [['--fit-window', 'created:1d', '--fit-window', 'created:2d'], '--fit-window is given twice'],
    [['--fit-where', 'Account'], 'Invalid --fit-where value "Account": it takes <Object>=<WHERE>'],
    [['--fit-where', '=Name = 1'], 'Invalid --fit-where value "=Name = 1"'],
    [['--fit-where', 'Account='], 'Invalid --fit-where value "Account="'],
    [['--fit-where', 'Account=  '], 'Invalid --fit-where value "Account=  "'],
    [
      ['--fit-where', 'Not-An-Object=Name = 1'],
      'Invalid --fit-where value "Not-An-Object=Name = 1"',
    ],
    [['--fit-where', 'Account=Name = 1 -- all'], 'contains forbidden tokens'],
    [['--fit-where', 'Account=Name = 1;'], 'contains forbidden tokens'],
    [['--fit-where', `Account=Name = '${'x'.repeat(520)}'`], 'exceeds 512 chars'],
    [
      ['--fit-where', 'Account=Name = 1', '--fit-where', 'account=Name = 2'],
      '--fit-where names account twice: give one condition of its roots',
    ],
    [
      ['--fit-where', 'Account=Name = 1', '--fit-whole', 'Account'],
      '--fit-where filters the roots of Account, which --fit-whole copies whole',
    ],
    [
      ['--fit-where', 'Account=Name = 1', '--exclude-object', 'Account'],
      '--fit-where and --exclude-object both name Account',
    ],
    [['--fit-strata', 'Account.'], 'Invalid --fit-strata value "Account."'],
    [['--fit-strata', 'Account.Record.Type'], 'Invalid --fit-strata value "Account.Record.Type"'],
    [['--fit-strata', '1Field'], 'Invalid --fit-strata value "1Field"'],
    [
      ['--fit-strata', 'Account.RecordTypeId', '--fit-strata', 'account.recordtypeid'],
      '--fit-strata account.recordtypeid is given twice',
    ],
    [
      ['--fit-strata', 'Account.RecordTypeId', '--fit-strata', 'Account.OwnerId'],
      'the roots of Account are stratified by one field at most',
    ],
    [
      ['--fit-strata', 'RecordTypeId', '--fit-strata', 'OwnerId'],
      'the roots are stratified by one field of every object at most',
    ],
  ])('refuses %j, exit 2, in its words, before any org is reached', (flags, words) => {
    expect(refusedOnTheLine(sampled(...flags))).toContain(words);
  });

  it('refuses more objects filtered and more fields of strata than a sample takes', () => {
    const where = Array.from({ length: 51 }, (_, i) => ['--fit-where', `Obj${i}__c=Name = 1`]);
    expect(refusedOnTheLine(sampled(...where.flat()))).toContain(
      '--fit-where filters the roots of 50 objects at most, not 51',
    );
    stderr = [];
    vi.mocked(process.exit).mockClear();
    const strata = Array.from({ length: 21 }, (_, i) => ['--fit-strata', `Obj${i}__c.Type__c`]);
    expect(refusedOnTheLine(sampled(...strata.flat()))).toContain(
      '--fit-strata stratifies the roots by 20 fields at most, not 21',
    );
  });

  it.each([
    ['--fit-draw', 'oldest'],
    ['--fit-window', 'created:30d'],
    ['--fit-where', 'Account=Name = 1'],
    ['--fit-strata', 'Account.RecordTypeId'],
  ])('refuses %s with --query, exit 2, as every flag a sample is drawn by', (flag, value) => {
    const said = refusedOnTheLine([
      'node',
      'sandforge-clone.ts',
      '--query',
      "SELECT Id FROM Account WHERE Industry = 'Energy'",
      '--source',
      'SRC',
      '--target',
      'TGT',
      flag,
      value,
    ]);
    expect(said).toContain(`--query clones the records a query chooses`);
    expect(said).toContain(`it does not go with ${flag}`);
  });

  it('names --fit-where when it refuses --where with --depth all', () => {
    const said = refusedOnTheLine(argv('--object', 'Account', '--where', "Name = 'x'"));
    expect(said).toContain(
      '--depth all clones the whole org, and does not go with --where: it starts from no ' +
        'table: --filter narrows an object, and --fit-where, with --fit share, draws the roots ' +
        'of a sample among the records that match.',
    );
  });

  it('fingerprints a sample apart by its window, its filters and its strata, and alike however they are given', () => {
    const graph = {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    const of = (...flags: string[]) =>
      forgeRunFingerprint(graph, cliRunSetup(parseArgs(sampled(...flags)), TARGET_ORG));

    const none = of();
    expect(of('--fit-draw', 'oldest')).not.toBe(none);
    expect(of('--fit-window', 'created:30d')).not.toBe(none);
    expect(of('--fit-window', 'created:30d')).not.toBe(of('--fit-window', 'created:31d'));
    expect(of('--fit-window', 'created:30d')).not.toBe(of('--fit-window', 'modified:30d'));
    expect(of('--fit-where', 'Account=Name = 1')).not.toBe(none);
    expect(of('--fit-where', 'Account=Name = 1')).not.toBe(of('--fit-where', 'Account=Name = 2'));
    expect(of('--fit-strata', 'Account.Industry')).not.toBe(none);
    // Said in another order, the same draw.
    expect(of('--fit-where', 'Account=Name = 1', '--fit-where', 'Lead=Name = 2')).toBe(
      of('--fit-where', 'Lead=Name = 2', '--fit-where', 'Account=Name = 1'),
    );
    expect(of('--fit-strata', 'Account.Industry', '--fit-strata', 'Status')).toBe(
      of('--fit-strata', 'Status', '--fit-strata', 'Account.Industry'),
    );
    // A date alone and the instant it starts at are the same window.
    expect(of('--fit-window', 'created:2025-01-01..2025-06-30')).toBe(
      of('--fit-window', 'created:2025-01-01T00:00:00Z..2025-07-01T00:00:00Z'),
    );
  });

  it('says each flag in its help, with the codes of a draw refused', () => {
    expect(() => parseArgs(['node', 'sandforge-clone.ts', '--help'])).toThrow(ExitCalled);
    const help = stdout.join('');

    for (const words of [
      '--fit-draw uniform|recent|oldest',
      '--fit-window created|modified:<from>..<to> | created|modified:<n>d',
      '--fit-where <Object>=<WHERE>',
      '--fit-strata <Field>|<Object>.<Field>',
      'Unlike\n                         --filter, the records under or above the roots come',
      '(SAMPLE_DRAW_INVALID)',
      '(SAMPLE_DRAW_EMPTY)',
    ]) {
      expect(help).toContain(words);
    }
    // No line of theirs is wider than a terminal of 80 columns.
    const theirs = help.slice(help.indexOf('  --fit-draw'), help.indexOf('  --fit-parents'));
    expect(theirs.split('\n').filter((line) => line.length > 80)).toEqual([]);
  });
});

/** A sample whose roots were held to a window and a filter and stratified, as a plan keeps it. */
function chosenSample(overrides: Partial<WholeOrgSample> = {}): WholeOrgSample {
  return {
    seed: 1,
    draw: 'oldest',
    floor: 1,
    parents: 'all',
    children: 100,
    share: 0.0041,
    budget: {
      bytes: 3_774_874,
      remainingMB: 5,
      maxMB: 5,
      share: 0.8,
      roundingMB: 0.5,
      maxTotal: 10_000,
      limitedBy: 'storage',
    },
    rows: 1_812,
    storageBytes: 3_670_016,
    objects: [
      {
        objectApiName: 'Account',
        sourceRows: 2_100_000,
        kept: 1_812,
        roots: 1_800,
        below: 0,
        asParents: 12,
        rootsInTheSource: 2_100_000,
        rootsInTheDraw: 440_000,
      },
      {
        objectApiName: 'Lead',
        sourceRows: 300_000,
        kept: 0,
        roots: 0,
        below: 0,
        asParents: 0,
        rootsInTheDraw: 12_400,
      },
    ],
    whole: [],
    heavyRoots: [],
    dropped: [],
    leftEmpty: [],
    noRecordDrawn: [
      { objectApiName: 'Campaign', sourceRows: 41, noRootInTheDraw: true },
      { objectApiName: 'Event', sourceRows: 9, noRootInTheDraw: true },
      { objectApiName: 'Region__c', sourceRows: 3 },
    ],
    roots: {
      window: { field: 'CreatedDate', from: '2025-01-01T00:00:00Z', to: '2025-07-01T00:00:00Z' },
      notWindowed: ['Event'],
      where: [{ objectApiName: 'Account', where: "BillingCountry = 'France'" }],
      strata: [
        {
          objectApiName: 'Account',
          field: 'RecordTypeId',
          values: [
            { value: '012000000000001AAA', label: 'Business', roots: 1_650, kept: 400 },
            { value: '012000000000002AAA', label: 'PersonAccount', roots: 150, kept: 12 },
            { value: null, roots: 3, kept: 1 },
          ],
          more: 2,
        },
      ],
    },
    planRequests: { source: 120 },
    oldestByIds: ['Thing__c'],
    plan: {
      path: '/home/u/.sandforge/forge-samples/abc',
      sha256: 'f'.repeat(64),
      drawnAt: '2026-11-14T10:00:00.000Z',
      drawnBy: 'dryRun',
    },
    ...overrides,
  };
}

describe('what a sample says of the roots it chose', () => {
  it('says its share is of the roots in the draw, the oldest first, and how they were chosen', () => {
    const lines = sampleLines(chosenSample(), { source: 'SRC', target: 'TGT', dryRun: true });

    expect(lines[0]).toContain(
      'object(s): 0.41 % of the roots in the draw of each object (the oldest by creation ' +
        'date; roots created from 2025-01-01T00:00:00Z to before 2025-07-01T00:00:00Z; ' +
        "Account where BillingCountry = 'France'; Account stratified by RecordTypeId (5 " +
        'value(s))), with the records they reach and name;',
    );
    expect(lines[0]).not.toContain('seed');
  });

  it('says the roots in the draw of the roots of the source, the objects left none, and those the window cannot date', () => {
    const lines = sampleLines(chosenSample(), { source: 'SRC', target: 'TGT', dryRun: true });

    expect(lines).toContain(
      'roots: Account 440000 in the draw of 2100000 root(s) in SRC; Lead 12400 in the draw; ' +
        'Campaign none in the draw (41 record(s) in SRC); not windowed (no CreatedDate): Event',
    );
    // Said after the objects, before what goes whole.
    expect(lines.findIndex((line) => line.startsWith('roots:'))).toBe(3);
    expect(lines).toContain('  Campaign: 41 in SRC, none of its roots in the draw');
    expect(lines).toContain('  Region__c: 3 in SRC');
  });

  it('says the roots and those kept of each value of a stratum, by its label, and the values past those listed', () => {
    const lines = sampleLines(chosenSample(), { source: 'SRC', target: 'TGT', dryRun: true });

    expect(lines).toContain(
      'strata: Account by RecordTypeId: Business 400 of 1650 root(s), PersonAccount 12 of ' +
        '150 root(s), (no value) 1 of 3 root(s), and 2 more value(s) (the records under the ' +
        'roots are not stratified)',
    );
  });

  it('says strata alone without a roots: line, its share of every root', () => {
    const sample = chosenSample();
    const lines = sampleLines(
      {
        ...sample,
        draw: 'uniform',
        roots: { strata: sample.roots?.strata ?? [] },
        // Strata alone hold no object's roots: none is counted in and out of the draw.
        objects: sample.objects.map((object) => {
          const unrestricted = { ...object };
          delete unrestricted.rootsInTheDraw;
          delete unrestricted.rootsInTheSource;
          return unrestricted;
        }),
        noRecordDrawn: [],
      },
      { source: 'SRC', target: 'TGT', dryRun: true },
    );

    expect(lines[0]).toContain(
      '0.41 % of the roots of each object (seed 1, spread over the org; Account stratified by ' +
        'RecordTypeId (5 value(s)))',
    );
    expect(lines.some((line) => line.startsWith('roots:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('strata:'))).toBe(true);
  });

  it('says a window of the last days with the instant it started at, and a window of changes', () => {
    const lines = sampleLines(
      chosenSample({
        roots: {
          window: { field: 'LastModifiedDate', lastDays: 30, from: '2026-10-15T08:00:00Z' },
        },
      }),
      { source: 'SRC', target: 'TGT', dryRun: true },
    );

    expect(lines[0]).toContain(
      '(the oldest by creation date; roots last modified in the last 30 day(s), from ' +
        '2026-10-15T08:00:00Z)',
    );
  });

  it('says the oldest read by their ids where the org sorts no creation date', () => {
    const lines = sampleLines(chosenSample(), { source: 'SRC', target: 'TGT', dryRun: true });

    expect(lines).toContain(
      'oldest by the order of their ids, the org sorting none of their creation dates — ids ' +
        'follow it within a load only: Thing__c',
    );
  });

  it('says a sample held by its draw to widen the window and filters, never to copy the whole org', () => {
    const sample = chosenSample();
    const lines = sampleLines(
      { ...sample, budget: { ...sample.budget, limitedBy: 'draw' } },
      { source: 'SRC', target: 'TGT', dryRun: true },
    );

    expect(
      lines[0].endsWith(
        '; limited by the draw: every root --fit-window and --fit-where leave is in the ' +
          'sample; widen them to take more',
      ),
    ).toBe(true);
    expect(lines[0]).not.toContain('leave out --fit share');
  });

  it('gives the roots chosen as JSON, beside the counts of each object restricted', () => {
    const json = sampleJson(chosenSample());

    expect(json.roots).toEqual(chosenSample().roots);
    expect(json.objects[0]).toMatchObject({ rootsInTheSource: 2_100_000, rootsInTheDraw: 440_000 });
    expect(json.objects[1]).not.toHaveProperty('rootsInTheSource');
    expect(json.objects[1]).toMatchObject({ rootsInTheDraw: 12_400 });
    expect(json.noRecordDrawn).toEqual([
      { objectApiName: 'Campaign', sourceRows: 41, noRootInTheDraw: true },
      { objectApiName: 'Event', sourceRows: 9, noRootInTheDraw: true },
      { objectApiName: 'Region__c', sourceRows: 3 },
    ]);
    expect(json.oldestByIds).toEqual(['Thing__c']);
    // The keys come in their places: the roots after the objects left none.
    const keys = Object.keys(json);
    expect(keys.indexOf('roots')).toBe(keys.indexOf('noRecordDrawn') + 1);
    // A draw among every root keeps the JSON it had.
    const every = sampleJson(
      chosenSample({ roots: undefined, oldestByIds: undefined, draw: 'uniform' }),
    );
    expect(every).not.toHaveProperty('roots');
    expect(every).not.toHaveProperty('oldestByIds');
  });

  it('says what a run wrote of a draw that chose its roots, in its lines and under result.sample', () => {
    const result: WholeOrgSampleResult = {
      seed: 1,
      draw: 'oldest',
      share: 0.5,
      sha256: 'f'.repeat(64),
      drawnAt: '2026-11-14T10:00:00.000Z',
      roots: {
        window: { field: 'CreatedDate', lastDays: 90, from: '2026-08-16T10:00:00Z' },
        whereObjects: ['Account'],
        strataFields: ['Account.RecordTypeId'],
      },
      objects: [],
    };

    expect(sampleResultLines(result, 'SRC')[0]).toBe(
      'sample (the oldest by creation date; roots created in the last 90 day(s), from ' +
        '2026-08-16T10:00:00Z; the roots of Account filtered; stratified by ' +
        'Account.RecordTypeId, 50 % of the roots in the draw of each object; plan sha256 ' +
        `${'f'.repeat(64)}, drawn 2026-11-14T10:00:00.000Z):`,
    );
    expect(sampleResultJson(result).roots).toEqual(result.roots);
    expect(sampleResultJson({ ...result, roots: undefined })).not.toHaveProperty('roots');
  });

  it('names in the question of its run how the roots were chosen, its share of those in the draw', () => {
    const question = {
      source: 'SRC',
      leftOut: 0,
      targetApi: { estimate: 40 },
      sourceApi: { estimate: 12 },
      restObjects: [],
      durationSeconds: 60,
      sample: {
        rows: 1_812,
        objects: 2,
        sourceRows: 2_400_000,
        storageMB: 3.5,
        budgetMB: 3.6,
        seed: 1,
        draw: 'oldest',
        share: 0.0041,
        limitedBy: 'storage',
        parents: 'all',
        children: 100,
        drawnAt: '2026-11-14T10:00:00.000Z',
        drawnBy: 'dryRun',
        roots: {
          window: { field: 'CreatedDate', from: '2025-01-01T00:00:00Z' },
          where: [{ objectApiName: 'Account', where: "BillingCountry = 'France'" }],
          strata: [{ objectApiName: 'Account', field: 'RecordTypeId', values: 2 }],
        },
      },
    } as unknown as WholeOrgConfirmation;
    const plan = {
      totalRows: 1_812,
      objects: [{ objectApiName: 'Account', rows: 1_812 }],
    } as unknown as Parameters<typeof wholeOrgQuestionWords>[1];

    expect(wholeOrgQuestionWords(question, plan, 'TGT', chosenSample())).toContain(
      '; the oldest by creation date; roots created from 2025-01-01T00:00:00Z; Account where ' +
        "BillingCountry = 'France'; Account stratified by RecordTypeId (2 value(s)), 0.41 % of " +
        'the roots in the draw; drawn at 2026-11-14T10:00:00.000Z by a dry run;',
    );
    // Strata alone: the share is of every root.
    const stratified = {
      ...question,
      sample: {
        ...question.sample,
        draw: 'uniform',
        roots: { strata: [{ objectApiName: 'Account', field: 'RecordTypeId', values: 2 }] },
      },
    } as unknown as WholeOrgConfirmation;
    expect(wholeOrgQuestionWords(stratified, plan, 'TGT', chosenSample())).toContain(
      '; seed 1, spread over the org; Account stratified by RecordTypeId (2 value(s)), 0.41 % ' +
        'of the roots; drawn at',
    );
  });

  it('says before it draws what the roots read, a count more of each object a window or filter holds', () => {
    const graph = {
      nodes: [
        { objectApiName: 'Account', recordCount: 4_500, included: true },
        { objectApiName: 'Contact', recordCount: 100, included: true },
        { objectApiName: 'Legacy__c', recordCount: 9_000, included: false },
      ],
    } as unknown as Parameters<typeof sampleReadsLine>[0];

    // The oldest: a count and the pages of the records asked, no page read again.
    const oldest = sampleReadsLine(graph, { draw: 'oldest', maxTotal: 5_000 }, 'SRC');
    expect(oldest).toContain('at most about 6 request(s) of SRC');
    expect(oldest).toContain('(the oldest by creation date, those it may keep)');
    // A filter of the accounts' roots counts them twice: in the draw, and in the source.
    const filtered = sampleReadsLine(
      graph,
      { draw: 'oldest', maxTotal: 5_000, rootWhere: { account: 'Name = 1' } },
      'SRC',
    );
    expect(filtered).toContain('at most about 7 request(s) of SRC');
    expect(filtered).toContain(
      "of the roots --fit-window and --fit-where leave, fewer than discovery's counts",
    );
    // A window, every object.
    expect(
      sampleReadsLine(graph, { window: { field: 'CreatedDate', lastDays: 3 } }, 'SRC'),
    ).toContain('at most about 8 request(s) of SRC');
    // Strata by date: a statement per value, which no count tells yet.
    expect(
      sampleReadsLine(graph, { draw: 'recent', strata: ['Account.Industry'] }, 'SRC'),
    ).toContain(', and a statement per value of each stratum, said once they are counted');
    expect(sampleReadsLine(graph, { strata: ['Account.Industry'] }, 'SRC')).not.toContain(
      'per value',
    );
  });

  it('names the window and the conditions of the roots by the keys of an environment’s file, relayed by one', () => {
    // Relayed by an environment's plan, the line said "of the roots
    // --fit-window and --fit-where leave" to a reader who gave no flag: its
    // file said fit.window, as the refusal under it did.
    const graph = {
      nodes: [{ objectApiName: 'Account', recordCount: 4_500, included: true }],
    } as unknown as Parameters<typeof sampleReadsLine>[0];
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge env plan');
    try {
      const line = sampleReadsLine(graph, { window: { field: 'CreatedDate', lastDays: 2 } }, 'SRC');
      expect(line).toContain("of the roots fit.window and fit.where leave, fewer than discovery's");
      expect(line).not.toContain('--fit-');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exits 2 for a draw the source cannot take, a line to give otherwise, and 1 for a draw left no root', () => {
    expect(sampleRefusalExit('SAMPLE_DRAW_INVALID')).toBe(2);
    expect(sampleRefusalExit('SAMPLE_DRAW_EMPTY')).toBe(1);
  });
});

describe('sandforge-clone --depth all --fit share choosing its roots, run whole', () => {
  it('draws the oldest by their creation date with --fit-draw oldest, not by the order of their ids', async () => {
    withFakeOrgs(sourceOf(true));

    expect(
      await run(sampled('--fit-draw', 'oldest', '--max-total', '20', '--dry-run', '--json')),
    ).toBeUndefined();

    const sample = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    expect(sample.draw).toBe('oldest');
    expect(sample).not.toHaveProperty('oldestByIds');
    expect(stderr.join('')).toContain('(the oldest by creation date)');
    expect(stderr.join('')).toContain('(the oldest by creation date, those it may keep)');
    // The accounts made first have the highest ids here.
    const accounts = await numbersOfThePlan(sample.plan.path, 'Account');
    expect(accounts.length).toBeGreaterThan(0);
    for (const n of accounts) expect(n).toBeGreaterThan(130);
  });

  it('draws only the roots made in the window, says them in the draw against those of the source, and is held by the draw', async () => {
    const orgs = withFakeOrgs();

    expect(
      await run(
        sampled(
          '--fit-window',
          'created:2026-01-01..2026-01-01T00:30:00Z',
          '--max-total',
          '1000',
          '--dry-run',
          '--json',
        ),
      ),
    ).toBeUndefined();

    const sample = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    expect(sample.roots?.window).toEqual({
      field: 'CreatedDate',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-01T00:30:00Z',
    });
    // Made in the minutes 1 to 29: the window leaves out its end.
    expect(sample.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      rootsInTheSource: 150,
      rootsInTheDraw: 29,
    });
    expect(await numbersOfThePlan(sample.plan.path, 'Account')).toEqual(
      Array.from({ length: 29 }, (_, i) => i + 1),
    );
    // Every root of the window kept: held by the draw, never said to fit the whole org.
    expect(sample.budget.limitedBy).toBe('draw');
    const said = stderr.join('');
    expect(said).toContain('% of the roots in the draw of each object');
    expect(said).toContain('roots: Account 29 in the draw of 150 root(s) in SRC;');
    expect(said).toContain('limited by the draw: every root --fit-window and --fit-where leave');
    expect(said).not.toContain('leave out --fit share to copy the whole org');
    expect(orgs.target.creates).toEqual([]);
  });

  it('says the objects a window of changes cannot date, and draws no root of them', async () => {
    withFakeOrgs();

    expect(
      await run(
        sampled(
          '--fit-window',
          'modified:2026-01-01..',
          '--max-total',
          '1000',
          '--dry-run',
          '--json',
        ),
      ),
    ).toBeUndefined();

    const sample = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    expect(sample.roots?.notWindowed).toEqual(['Ticket__c']);
    expect(sample.noRecordDrawn).toContainEqual({
      objectApiName: 'Ticket__c',
      sourceRows: 50,
      noRootInTheDraw: true,
    });
    expect(stderr.join('')).toContain('not windowed (no LastModifiedDate): Ticket__c');
  });

  it('draws the roots of an object among those its condition keeps, and brings what is under them whatever it says', async () => {
    withFakeOrgs();

    expect(
      await run(
        sampled(
          '--fit-where',
          "Account=Industry = 'Energy'",
          '--max-total',
          '1000',
          '--dry-run',
          '--json',
        ),
      ),
    ).toBeUndefined();

    const sample = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    expect(sample.roots?.where).toEqual([
      { objectApiName: 'Account', where: "Industry = 'Energy'" },
    ]);
    expect(sample.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      rootsInTheSource: 150,
      rootsInTheDraw: 50,
    });
    const accounts = await numbersOfThePlan(sample.plan.path, 'Account');
    expect(accounts.length).toBe(50);
    for (const n of accounts) expect(n % 3).toBe(0);
    // The contacts under them come, though no condition names them.
    expect(await numbersOfThePlan(sample.plan.path, 'Contact')).toEqual(accounts);
    // The tickets' roots are drawn as ever.
    expect(sample.objects.find((o) => o.objectApiName === 'Ticket__c')).not.toHaveProperty(
      'rootsInTheDraw',
    );
    expect(stderr.join('')).toContain("Account where Industry = 'Energy'");
  });

  it('keeps the share of each value of a stratum, and says them value by value', async () => {
    withFakeOrgs();

    expect(
      await run(
        sampled('--fit-strata', 'Account.Industry', '--max-total', '60', '--dry-run', '--json'),
      ),
    ).toBeUndefined();

    const sample = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    const strata = sample.roots?.strata ?? [];
    expect(strata).toHaveLength(1);
    expect(strata[0]).toMatchObject({ objectApiName: 'Account', field: 'Industry' });
    const byValue = Object.fromEntries(strata[0].values.map((v) => [String(v.value), v]));
    expect(byValue['Energy']?.roots).toBe(50);
    expect(byValue['Retail']?.roots).toBe(100);
    // Each value kept, the same share of each, give or take the rounding of each.
    expect(byValue['Energy']?.kept).toBeGreaterThan(0);
    expect(byValue['Retail']?.kept).toBeGreaterThan(0);
    const energy = (byValue['Energy']?.kept ?? 0) / 50;
    const retail = (byValue['Retail']?.kept ?? 0) / 100;
    expect(Math.abs(energy - retail)).toBeLessThan(0.05);
    // Strata alone keep every root in the draw: no line of the roots in it.
    expect(sample.objects.find((o) => o.objectApiName === 'Account')).not.toHaveProperty(
      'rootsInTheDraw',
    );
    const said = stderr.join('');
    expect(said).toContain('strata: Account by Industry: ');
    expect(said).not.toContain('\nroots: ');
  });

  it('is refused SAMPLE_DRAW_EMPTY, exit 1, counts alone read, when the window leaves no root', async () => {
    const orgs = withFakeOrgs();

    expect(
      await run(sampled('--fit-window', 'created:2020-01-01..2020-12-31', '--dry-run', '--json')),
    ).toBe(1);

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_DRAW_EMPTY');
    expect(answer.refused.message).toContain('No object has a root in the draw');
    expect(answer.refused.message).toContain('--fit-window');
    expect(stderr.join('')).toContain('refused (SAMPLE_DRAW_EMPTY)');
    expect(dryRunPlans()).toEqual([]);
    expect(orgs.target.creates).toEqual([]);
    // Nothing past the counts was read: no id of a root.
    expect(
      orgs.source.sent.filter(({ soql }) =>
        /^SELECT Id\b.* FROM (?:Account|Ticket__c)\b/.test(soql),
      ),
    ).toEqual([]);
  });

  it('names each flag of the draw by the key of an environment’s file, to its reader alone', () => {
    const said =
      'Stratify Account by a field of few values (--fit-strata Account.<Field>) —, or narrow ' +
      'its roots first (--fit-where Account=…). Filter the roots of Account instead: ' +
      '--fit-where "Account=Id IN (SELECT AccountId FROM Case WHERE …)". Draw the most recent ' +
      'records (--fit-draw recent) or the oldest (--fit-draw oldest), draw among fewer roots ' +
      '(--fit-window, --fit-where), let it take more (--fit-within), or raise --max-total.';
    expect(fitKeyWords(said)).toBe(said);
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge env apply');
    try {
      expect(fitKeyWords(said)).toBe(
        'Stratify Account by a field of few values (fit.strata: [Account.<Field>]) —, or narrow ' +
          'its roots first (fit.where.Account). Filter the roots of Account instead: ' +
          'fit.where.Account: "Id IN (SELECT AccountId FROM Case WHERE …)". Draw the most recent ' +
          'records (fit.draw: recent) or the oldest (fit.draw: oldest), draw among fewer roots ' +
          '(fit.window, fit.where), let it take more (fit.withinMB), or raise maxTotal.',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['an empty window', ['--fit-window', 'created:2020-01-01..2020-12-31'], 'fit.window', 1],
    [
      'a condition the source refuses',
      ['--fit-where', 'Account=Nope__c = 1'],
      'fit.where.Account',
      2,
    ],
    ['a text field to stratify by', ['--fit-strata', 'Account.Name'], 'Account.Name', 2],
  ])(
    'names to an environment the key of its file for %s, never a flag of the draw',
    async (_label, flags, key, exit) => {
      // Relayed by an environment's plan, an empty window said "Widen the
      // window (--fit-window)" to a reader whose file says fit.window.
      vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge env plan');
      try {
        withFakeOrgs();

        expect(await run(sampled(...flags, '--dry-run', '--json'))).toBe(exit);

        const answer = JSON.parse(stdout.join('')) as RefusedJson;
        expect(answer.refused.message).toContain(key);
        expect(answer.refused.message).not.toMatch(/--fit-/);
        expect(stderr.join('')).not.toMatch(/refused \(SAMPLE_DRAW_[A-Z]+\):.*--fit-/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    [
      'a text field to stratify by',
      ['--fit-strata', 'Account.Name'],
      'Account.Name is a string field, of too many values to stratify by',
    ],
    [
      'an object the run does not hold',
      ['--fit-where', 'Lead=Status = 1'],
      'Lead is no object of the run',
    ],
    ['a condition the source refuses', ['--fit-where', 'Account=Nope__c = 1'], 'Nope__c'],
  ])(
    'is refused SAMPLE_DRAW_INVALID, exit 2, nothing written, for %s',
    async (_label, flags, words) => {
      const orgs = withFakeOrgs();

      expect(await run(sampled(...flags, '--dry-run', '--json'))).toBe(2);

      const answer = JSON.parse(stdout.join('')) as RefusedJson;
      expect(answer.refused.code).toBe('SAMPLE_DRAW_INVALID');
      expect(answer.refused.message).toContain(words);
      expect(stderr.join('')).toContain('refused (SAMPLE_DRAW_INVALID)');
      expect(dryRunPlans()).toEqual([]);
      expect(orgs.target.creates).toEqual([]);
    },
  );

  it('takes up with --fit-plan the plan of a dry run among every root, which holds nothing a 1.80 plan did not', async () => {
    const orgs = withFakeOrgs();
    expect(await run(sampled('--max-total', '30', '--dry-run', '--json'))).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    const manifest = JSON.parse(readFileSync(join(dry.plan.path, 'sample.json'), 'utf8')) as {
      sample: Record<string, unknown> & { objects: Array<Record<string, unknown>> };
    };
    // None of the keys a draw that chooses its roots adds: as 1.80 kept it.
    expect(manifest).not.toHaveProperty('oldestByIds');
    expect(manifest.sample).not.toHaveProperty('roots');
    for (const entry of manifest.sample.objects) {
      expect(entry).not.toHaveProperty('rootsInTheDraw');
    }

    stdout = [];
    expect(
      await run(sampled('--max-total', '30', '--fit-plan', dry.plan.path, '--yes', '--json')),
    ).toBeUndefined();
    const written = orgs.target.creates.reduce((sum, { rows }) => sum + rows.length, 0);
    expect(written).toBe(dry.rows);
  });
});
