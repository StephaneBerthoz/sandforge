import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';

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
import { confirm } from './prompt.js';
import {
  cliRunSetup,
  cloneInputLine,
  cloneInputOf,
  cloneSubjectOf,
  lostJobsBeforeTheMute,
  main,
  parseArgs,
  parseRunSummary,
  removalPlan,
  runSummaryOfFile,
  wholeOrgRefusalWords,
  wholeOrgRunConfig,
  wholeOrgSweepLine,
  wholeOrgWriteDeps,
} from './sandforge-clone';
import { UNATTRIBUTED_TAG } from '../src/modules/forge/ForgeRunStore.js';
import { LostBulkJobs } from '../src/modules/forge/lostBulkJobs.js';
import { BulkJobLostError } from '../src/modules/forge/forgeBulkWrite.js';
import { BulkApiManager } from '../src/core/engine/BulkApiManager.js';

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

/** An object as both fake orgs describe it. */
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
      { name: 'Id', type: 'id', createable: false, nillable: false },
      ...fields.map((f) => ({ type: 'string', createable: true, nillable: true, ...f })),
    ].map((f) => ({ referenceTo: [], relationshipName: null, cascadeDelete: false, ...f })),
  } as unknown as DescribeSObjectResult;
}

const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }, { name: 'Phone', type: 'phone' }],
    [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'ns__Policy__c', field: 'ns__Account__c', relationshipName: 'Policies' },
    ],
  ),
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    { name: 'Email', type: 'email' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
  ]),
  // An object of a managed package: written as any other, no mute reaches it.
  ns__Policy__c: object('ns__Policy__c', 'a01', [
    { name: 'Name' },
    { name: 'ns__Account__c', type: 'reference', referenceTo: ['Account'] },
  ]),
  Ticket__c: object('Ticket__c', 'a02', [{ name: 'Name' }]),
  Task: object('Task', '00T', [{ name: 'Subject' }]),
};

/** The objects each org lists: the source's own `Legacy__c` the target lacks, `User` is setup. */
function globalOf(withLegacy: boolean) {
  return [
    ...Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    { name: 'User', keyPrefix: '005' },
    ...(withLegacy ? [{ name: 'Legacy__c', keyPrefix: 'a03' }] : []),
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

/** `count` tickets, each its own name. */
function tickets(count: number): Array<Record<string, string>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `a02${String(i + 1).padStart(12, '0')}AAA`,
    Name: `Ticket ${i + 1}`,
  }));
}

/** The records of the source. */
function sourceRows(ticketCount = 2): Record<string, Array<Record<string, string>>> {
  return {
    Account: [
      { Id: '001000000000001AAA', Name: 'One', Phone: '+33 1 00 00 00 01' },
      { Id: '001000000000002AAA', Name: 'Two', Phone: '+33 1 00 00 00 02' },
      { Id: '001000000000003AAA', Name: 'Three', Phone: '+33 1 00 00 00 03' },
    ],
    Contact: [
      {
        Id: '003000000000001AAA',
        LastName: 'A',
        Email: 'a@x.test',
        AccountId: '001000000000001AAA',
      },
      {
        Id: '003000000000002AAA',
        LastName: 'B',
        Email: 'b@x.test',
        AccountId: '001000000000002AAA',
      },
      {
        Id: '003000000000003AAA',
        LastName: 'C',
        Email: 'c@x.test',
        AccountId: '001000000000003AAA',
      },
      {
        Id: '003000000000004AAA',
        LastName: 'D',
        Email: 'd@x.test',
        AccountId: '001000000000003AAA',
      },
    ],
    ns__Policy__c: [
      { Id: 'a01000000000001AAA', Name: 'P1', ns__Account__c: '001000000000001AAA' },
      { Id: 'a01000000000002AAA', Name: 'P2', ns__Account__c: '001000000000002AAA' },
    ],
    Ticket__c: tickets(ticketCount),
    Task: [],
  };
}

/** What `/limits` says of a sandbox with room to spare. */
const LIMITS = {
  DataStorageMB: { Max: 1_000, Remaining: 900 },
  DailyApiRequests: { Max: 100_000, Remaining: 90_000 },
  DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
  FileStorageMB: { Max: 1_000, Remaining: 900 },
};

/** Whether `row` meets every `Field = 'value'` and `Id > 'id'` term of `where`. */
function meets(row: Record<string, string>, where: string | undefined): boolean {
  if (!where) return true;
  for (const [, field, value] of where.matchAll(/(\w+) = '([^']*)'/g)) {
    if (row[field] !== value) return false;
  }
  for (const [, after] of where.matchAll(/Id > '([^']*)'/g)) {
    if (!(row['Id'] > after)) return false;
  }
  return true;
}

/** The rows of a CSV a job was sent, every cell as text. */
function csvRows(csv: string): Array<Record<string, string>> {
  const [header, ...lines] = csv.trimEnd().split('\n');
  const columns = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']));
  });
}

/**
 * An org: a sandbox unless `sandbox` says otherwise, holding `rows`. Each
 * create call is kept with its rows, each Bulk API job with what it was sent;
 * each statement read, but its Organization record's. A job answers every
 * row it was sent written, with `extra` more records no row was sent for.
 */
function fakeOrg({
  id,
  sandbox = true,
  rows = {},
  limits = LIMITS,
  withLegacy = false,
  refuse = new Set<string>(),
  extra = [],
  interruptOn,
  firstId = 0,
}: {
  id: string;
  sandbox?: boolean;
  rows?: Record<string, Array<Record<string, string>>>;
  limits?: Record<string, unknown>;
  withLegacy?: boolean;
  /** The values of `LastName` whose insert the org refuses. */
  refuse?: ReadonlySet<string>;
  extra?: Array<Record<string, string>>;
  /** The object whose first create a Ctrl-C comes during, as a person stops the run. */
  interruptOn?: string;
  /** Where the ids the org gives start: a second run gives ids of its own. */
  firstId?: number;
}) {
  const read: string[] = [];
  const creates: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
  const jobs: Array<{ object: string; operation: string; rows: number }> = [];
  let made = firstId;
  let interrupted = false;
  const idOf = (name: string): string =>
    `${DESCRIBES[name]?.keyPrefix ?? 'a09'}9${String(made++).padStart(11, '0')}AAA`;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    version: '62.0',
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: Array<Record<string, unknown>>) => {
        creates.push({ name, rows: records });
        if (name === interruptOn && !interrupted) {
          interrupted = true;
          process.emit('SIGINT', 'SIGINT');
        }
        return records.map((record) =>
          refuse.has(String(record['LastName']))
            ? {
                success: false,
                errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Refused' }],
              }
            : { id: idOf(name), success: true, errors: [] },
        );
      },
      update: async (records: Array<Record<string, unknown>>) =>
        records.map((record) => ({ id: record['Id'], success: true, errors: [] })),
    }),
    describe$: async (name: string) => DESCRIBES[name],
    describeGlobal: async () => ({ sobjects: globalOf(withLegacy) }),
    identity: async () => ({ user_id: RUN_USER }),
    query: async (soql: string) => {
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: id, IsSandbox: sandbox }]);
      }
      if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') {
        return page([sandbox ? {} : { OrganizationType: 'Enterprise Edition' }]);
      }
      read.push(soql);
      const statement = /FROM (\w+)(?: WHERE (.*?))?(?: ORDER BY [\w ,]+)?(?: LIMIT \d+)?$/.exec(
        soql,
      );
      const held = (rows[statement?.[1] ?? ''] ?? []).filter((row) => meets(row, statement?.[2]));
      if (/^SELECT COUNT\(\)/.test(soql))
        return { totalSize: held.length, done: true, records: [] };
      return page(held.map((row) => ({ ...row })));
    },
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url === '/limits') return limits;
      if (url.endsWith('/limits/recordCount')) {
        return {
          sObjects: Object.entries(rows).map(([name, held]) => ({ name, count: held.length })),
        };
      }
      return {};
    },
    bulk2: {
      createJob: (options: { object: string; operation: string }) => {
        let csv = '';
        let jobId: string | undefined;
        const job = { object: options.object, operation: options.operation, rows: 0 };
        jobs.push(job);
        const results = () => ({
          successfulResults: [...csvRows(csv), ...extra].map((row) => ({
            sf__Id: idOf(options.object),
            sf__Created: 'true',
            ...row,
          })),
          failedResults: [],
          unprocessedRecords: [],
        });
        const info = () => ({
          id: jobId,
          state: 'JobComplete',
          numberRecordsProcessed: csvRows(csv).length + extra.length,
          numberRecordsFailed: 0,
        });
        return {
          get id() {
            return jobId;
          },
          open: async () => {
            jobId = '750000000000001AAA';
          },
          uploadData: async (data: string) => {
            csv = data;
            job.rows = csvRows(csv).length;
          },
          close: async () => undefined,
          abort: async () => undefined,
          check: async () => info(),
          getAllResults: async () => results(),
        };
      },
      job: () => ({
        check: async () => ({ id: '750000000000001AAA', state: 'JobComplete' }),
        getSuccessfulResults: async () => [],
        getAllResults: async () => ({
          successfulResults: [],
          failedResults: [],
          unprocessedRecords: [],
        }),
        abort: async () => undefined,
      }),
    },
  };
  return { conn: conn as unknown as Connection, read, creates, jobs };
}

/** Both fake orgs answering for SRC and TGT: the source holds the records, the target none. */
function withFakeOrgs(
  options: {
    source?: Partial<Parameters<typeof fakeOrg>[0]>;
    target?: Partial<Parameters<typeof fakeOrg>[0]>;
  } = {},
) {
  const orgs = {
    SRC: fakeOrg({ id: SOURCE_ORG, rows: sourceRows(), withLegacy: true, ...options.source }),
    TGT: fakeOrg({ id: TARGET_ORG, ...options.target }),
  };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as keyof typeof orgs].conn);
  return orgs;
}

/** What the dry run of the whole org gives under `wholeOrg`. */
interface WholeOrgJson {
  wouldInsert: Array<{ objectApiName: string; rows: number; jobs: number; byRest: number }>;
  totalRows: number;
  requests: { target: { estimate: number }; source: { estimate: number } };
  leftOut: {
    objects: Array<{ objectApiName: string; reason: string }>;
    counts: Array<{ reason: string; count: number }>;
  };
  personalAsIs: Array<{ objectApiName: string; fields: string[] }>;
  managedPackages: string[];
}

describe('sandforge-clone --depth all, a clone of the whole org', () => {
  let stdout: string[];
  let stderr: string[];
  let printed: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    printed = [];
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
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(`${String(line)}\n`);
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('sf org display reached');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('its command line', () => {
    it('reads --depth all as a clone of the whole org: no record, no table, no question answered unless --yes', () => {
      const args = parseArgs(argv());

      expect(args).toMatchObject({
        depth: 'all',
        record: undefined,
        tables: undefined,
        anonymize: false,
        anonymizeGiven: false,
        yes: false,
        files: undefined,
      });
      expect(cloneInputOf(args)).toEqual({ inputMode: 'org' });
      expect(cloneInputLine(args)).toBe('the whole org');
      expect(wholeOrgRunConfig(args)).toMatchObject({ inputMode: 'org', depth: 'all' });
      expect(wholeOrgRunConfig(args)).not.toHaveProperty('customDepth');
      expect(cliRunSetup(args, TARGET_ORG)).toMatchObject({ depth: 'all', record: undefined });
      expect(parseArgs(argv('--yes', '--no-anonymize'))).toMatchObject({
        yes: true,
        anonymize: false,
        anonymizeGiven: true,
      });
    });

    it.each([
      ['--record', ['--record', '001000000000001AAA'], 'it starts from no record'],
      ['--object', ['--object', 'Account'], 'it starts from no table'],
      ['--where', ['--object', 'Account', '--where', "Name = 'x'"], 'it starts from no table'],
      ['--custom-depth', ['--custom-depth', '3'], 'it walks no depth'],
      ['--max-nodes', ['--max-nodes', '120'], 'refused past 1950 rather than cut'],
      ['--max', ['--max', '10'], 'it copies every row of what it takes'],
      ['--expand-orphans', ['--expand-orphans'], 'every parent it reaches is in the org'],
      ['--rehearse', ['--rehearse'], 'a rehearsal holds every row it prepares'],
      ['--upsert', ['--upsert'], 'its writes go as Bulk API jobs that insert'],
      ['--anonymize', ['--anonymize', '--no-anonymize'], 'give one of them'],
    ])('refuses %s with exit 2, in its words, before any org is reached', (flag, extra, why) => {
      expect(() => parseArgs(argv(...extra))).toThrow(ExitCalled);

      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
      expect(execFileSync).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain(
        `--depth all clones the whole org, and does not go with ${flag}: `,
      );
      expect(stderr.join('')).toContain(why);
    });

    it('refuses a --template, whose choices are a walk’s, before any org is reached', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-all-template-'));
      try {
        const template = join(dir, 'template.json');
        writeFileSync(
          template,
          JSON.stringify({
            id: 't',
            name: 't',
            description: '',
            config: {
              inputMode: 'record',
              recordId: '001000000000001AAA',
              depth: 'direct',
              anonymizePII: false,
              skipEmpty: true,
              batchSize: 'auto',
            },
            objectCount: 0,
            recordCount: 0,
            createdAt: '2026-11-01T09:00:00.000Z',
            lastUsedAt: '2026-11-01T09:00:00.000Z',
          }),
        );

        expect(() => parseArgs(argv('--template', template))).toThrow(ExitCalled);
        expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
        expect(stderr.join('')).toContain('does not go with --template: a template holds');
        expect(execFileSync).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([['--yes'], ['--no-anonymize']])(
      'refuses %s with any other depth, which asks nothing and anonymizes only when told',
      (flag) => {
        const args = [
          'node',
          'x',
          '--record',
          '001000000000001AAA',
          '--source',
          'S',
          '--target',
          'T',
        ];

        expect(() => parseArgs([...args, flag])).toThrow(ExitCalled);
        expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
        expect(stderr.join('')).toContain(`${flag} goes with --depth all`);
      },
    );

    it('names the whole org in what a removal calls the run, a few objects by name past a dozen', () => {
      const many = Array.from({ length: 14 }, (_, i) => ({ objectApiName: `O${i}__c` }));

      expect(cloneSubjectOf({ wholeOrg: true })).toBe('the whole org');
      expect(cloneSubjectOf({ wholeOrg: true, objects: many })).toBe(
        `the whole org (${many
          .slice(0, 12)
          .map((o) => o.objectApiName)
          .join(', ')} and 2 more object(s))`,
      );
      // A clone of tables keeps its names, as before.
      expect(cloneSubjectOf({ objects: [{ objectApiName: 'Account' }] })).toBe('Account');
    });
  });

  describe('its listing', () => {
    it('lists the objects it would copy, and what it leaves of the source with why, reading no row', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--list-objects', '--json'))).toBeUndefined();

      const listing = JSON.parse(stdout.join('')) as {
        wholeOrg?: boolean;
        objects: Array<{ objectApiName: string; included: boolean }>;
        leftOut: { objects: Array<{ objectApiName: string; reason: string }> };
      };
      expect(listing.wholeOrg).toBe(true);
      expect(listing.objects.map((o) => o.objectApiName)).toEqual([
        'Account',
        'Contact',
        'ns__Policy__c',
        'Ticket__c',
      ]);
      expect(listing.leftOut.objects).toContainEqual({
        objectApiName: 'Legacy__c',
        reason: 'missingInTarget',
      });
      expect(orgs.SRC.read.every((soql) => soql.startsWith('SELECT COUNT()'))).toBe(true);
    });
  });

  describe('its dry run', () => {
    it('stops at the write gate once the source is counted, saying what each object would take, reading no row and writing nothing', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

      const summary = JSON.parse(stdout.join('')) as {
        dryRun: boolean;
        anonymize: boolean;
        wholeOrg: WholeOrgJson;
        wouldBeRefused?: string[];
      };
      expect(summary.dryRun).toBe(true);
      expect(summary.wholeOrg.wouldInsert).toEqual([
        { objectApiName: 'Contact', rows: 4, jobs: 0, byRest: 4 },
        { objectApiName: 'Account', rows: 3, jobs: 0, byRest: 3 },
        { objectApiName: 'ns__Policy__c', rows: 2, jobs: 0, byRest: 2 },
        { objectApiName: 'Ticket__c', rows: 2, jobs: 0, byRest: 2 },
      ]);
      expect(summary.wholeOrg.totalRows).toBe(11);
      // What it leaves of the source, each with why.
      expect(summary.wholeOrg.leftOut.objects).toEqual(
        expect.arrayContaining([
          { objectApiName: 'Legacy__c', reason: 'missingInTarget' },
          { objectApiName: 'Task', reason: 'empty' },
          expect.objectContaining({ objectApiName: 'User', reason: 'setup' }),
        ]),
      );
      // A sandbox source, nothing said: the personal fields go as they are, and say so.
      expect(summary.anonymize).toBe(false);
      expect(summary.wholeOrg.personalAsIs).toEqual([
        { objectApiName: 'Account', fields: ['Phone'] },
        { objectApiName: 'Contact', fields: ['LastName', 'Email'] },
      ]);
      expect(summary.wholeOrg.managedPackages).toEqual(['ns__Policy__c']);
      expect(summary).not.toHaveProperty('wouldBeRefused');
      // Its counts, and no row: no statement of the source selects a field.
      expect(orgs.SRC.read.filter((soql) => /^SELECT (?!COUNT\(\))/.test(soql))).toEqual([
        expect.stringContaining('FROM RecordType'),
      ]);
      expect(orgs.TGT.creates).toEqual([]);
      expect(orgs.TGT.jobs).toEqual([]);
      expect(stderr.join('')).toContain('graph: the whole of SRC, 4 object(s) to copy');
      expect(stderr.join('')).toContain(
        'managed packages: 1 object(s) written, whose triggers and flows no mute reaches: ns__Policy__c',
      );
    });

    it('counts an object of two thousand records or more as a Bulk API job, and the batches it takes', async () => {
      withFakeOrgs({ source: { rows: sourceRows(2_500) } });

      expect(await run(argv('--dry-run', '--json', '--max-total', '5000'))).toBeUndefined();

      const summary = JSON.parse(stdout.join('')) as {
        wholeOrg: WholeOrgJson & { bulkBatches?: { estimate: number } };
      };
      expect(summary.wholeOrg.wouldInsert[0]).toEqual({
        objectApiName: 'Ticket__c',
        rows: 2_500,
        jobs: 1,
        byRest: 0,
      });
      expect(summary.wholeOrg.bulkBatches?.estimate).toBeGreaterThan(0);
    });

    it('says the same of the org twice, its requests aside', async () => {
      withFakeOrgs();
      expect(await run(argv('--dry-run', '--json'))).toBeUndefined();
      const first = JSON.parse(stdout.join('')) as { wholeOrg: WholeOrgJson };
      stdout = [];
      withFakeOrgs();
      expect(await run(argv('--dry-run', '--json'))).toBeUndefined();
      const second = JSON.parse(stdout.join('')) as { wholeOrg: WholeOrgJson };

      expect(second.wholeOrg).toEqual(first.wholeOrg);
    });

    it('exits 1, nothing written, when a real run would be refused, naming each refusal under its code', async () => {
      const orgs = withFakeOrgs({
        target: {
          limits: { ...LIMITS, DataStorageMB: { Max: 1_000, Remaining: 0 } },
        },
      });

      expect(await run(argv('--dry-run', '--json', '--max-total', '5'))).toBe(1);

      const summary = JSON.parse(stdout.join('')) as {
        wouldBeRefused: string[];
        wouldBeRefusedCodes: string[];
      };
      expect(summary.wouldBeRefusedCodes).toEqual(['MAX_TOTAL_EXCEEDED', 'STORAGE_EXCEEDED']);
      expect(summary.wouldBeRefused[0]).toContain(
        'The clone of the whole org would write 11 records, more than the 5 --max-total holds it to',
      );
      expect(orgs.TGT.creates).toEqual([]);
    });

    it('anonymizes by default a source its Organization record says is a production org', async () => {
      withFakeOrgs({ source: { sandbox: false } });

      expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

      const summary = JSON.parse(stdout.join('')) as { anonymize: boolean; wholeOrg: WholeOrgJson };
      expect(summary.anonymize).toBe(true);
      expect(summary.wholeOrg.personalAsIs).toEqual([]);
      expect(stderr.join('')).toContain('anonymize: on, SRC being a production org');

      stdout = [];
      withFakeOrgs({ source: { sandbox: false } });
      expect(await run(argv('--dry-run', '--json', '--no-anonymize'))).toBeUndefined();
      const asIs = JSON.parse(stdout.join('')) as { anonymize: boolean; wholeOrg: WholeOrgJson };
      expect(asIs.anonymize).toBe(false);
      expect(asIs.wholeOrg.personalAsIs.length).toBeGreaterThan(0);
    });

    it('refuses --files from a production source anonymized by default until the files are accepted as they are', async () => {
      withFakeOrgs({ source: { sandbox: false } });

      expect(await run(argv('--dry-run', '--files'))).toBe(2);

      expect(stderr.join('')).toContain('--files: SRC is a production org');
      expect(stderr.join('')).toContain('--files-as-is');
    });
  });

  describe('its run', () => {
    it('is refused at its gate, nothing written, when no one is there to answer its question, which names what it would do', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--json'))).toBe(1);

      const refused = (
        JSON.parse(stdout.join('')) as { refused: { code: string; message: string } }
      ).refused;
      expect(refused.code).toBe('CONFIRMATION_UNAVAILABLE');
      expect(refused.message).toContain('11 record(s) of 4 object(s) of SRC into TGT');
      expect(refused.message).toContain('1 object(s) of managed packages');
      expect(refused.message).toContain('3 personal field(s) of 2 object(s) copied as they are');
      expect(refused.message).toContain('give --yes');
      expect(orgs.TGT.creates).toEqual([]);
    });

    it('asks on the terminal, naming what it would do, and writes nothing once declined', async () => {
      const orgs = withFakeOrgs();
      const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        vi.mocked(confirm).mockResolvedValueOnce(false);
        expect(await run(argv('--json'))).toBe(1);
        expect(vi.mocked(confirm)).toHaveBeenCalledWith(
          expect.stringMatching(/^Write 11 record\(s\) of 4 object\(s\) of SRC into TGT/),
        );
        expect(JSON.parse(stdout.join('')).refused.code).toBe('WRITE_DECLINED');
        expect(orgs.TGT.creates).toEqual([]);

        // Answered yes, it writes.
        stdout = [];
        const answered = withFakeOrgs();
        vi.mocked(confirm).mockResolvedValueOnce(true);
        expect(await run(argv('--json'))).toBeUndefined();
        expect(answered.TGT.creates.length).toBeGreaterThan(0);
      } finally {
        if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    });

    it('writes the whole org with --yes, keeps its journal, and leaves a summary its removal reads as the whole org', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--json', '--yes'))).toBeUndefined();

      const text = stdout.join('');
      const document = JSON.parse(text) as {
        wholeOrg?: boolean;
        journal: string;
        result: { status: string; successCount: number };
      };
      expect(document.wholeOrg).toBe(true);
      expect(document.result).toMatchObject({ status: 'success', successCount: 11 });
      expect(orgs.TGT.creates.map((call) => call.name).sort()).toEqual(
        ['Account', 'Contact', 'Ticket__c', 'ns__Policy__c'].sort(),
      );
      expect(stderr.join('')).toContain('--yes: written without the question');

      const parsed = parseRunSummary(text);
      if ('refusal' in parsed) throw new Error(parsed.refusal);
      expect(parsed.summary.wholeOrg).toBe(true);
      expect(wholeOrgSweepLine(parsed.summary, { sweep: false, sweepList: false })).toContain(
        'the sweep is off for a clone of the whole org',
      );
      expect(wholeOrgSweepLine(parsed.summary, { sweep: true, sweepList: false })).toBeUndefined();

      const ofJournal = await runSummaryOfFile(
        document.journal,
        readFileSync(document.journal, 'utf8'),
        'TGT',
      );
      if ('refusal' in ofJournal) throw new Error(ofJournal.refusal);
      expect(ofJournal.summary.wholeOrg).toBe(true);
      expect(ofJournal.summary.record).toBeUndefined();
      expect(cloneSubjectOf(ofJournal.summary)).toBe(
        'the whole org (Account, Contact, Ticket__c, ns__Policy__c)',
      );
      expect(removalPlan(ofJournal.summary).reduce((sum, o) => sum + o.ids.length, 0)).toBe(11);
    });

    it('sends an object of two thousand records as a Bulk API job, and its removal takes what the job wrote that no row was matched to', async () => {
      const made = { Name: 'Made by the target as the job ran' };
      const orgs = withFakeOrgs({ source: { rows: sourceRows(2_000) }, target: { extra: [made] } });

      expect(await run(argv('--json', '--yes', '--max-total', '5000'))).toBeUndefined();

      expect(orgs.TGT.jobs).toEqual([{ object: 'Ticket__c', operation: 'insert', rows: 2_000 }]);
      // The other objects, under two thousand records, by REST.
      expect(orgs.TGT.creates.map((call) => call.name)).not.toContain('Ticket__c');
      const document = JSON.parse(stdout.join('')) as { journal: string };
      const journal = readFileSync(document.journal, 'utf8');
      expect(journal).toContain(`["${UNATTRIBUTED_TAG}","Ticket__c",`);

      const ofJournal = await runSummaryOfFile(document.journal, journal, 'TGT');
      if ('refusal' in ofJournal) throw new Error(ofJournal.refusal);
      const plan = removalPlan(ofJournal.summary);
      const ticketIds = plan.find((o) => o.objectApiName === 'Ticket__c')?.ids ?? [];
      // Each record the job wrote, the one no row was sent for among them.
      expect(ticketIds).toHaveLength(2_001);
      expect(new Set(ticketIds).size).toBe(2_001);
    }, 30_000);

    it('is taken up from its journal once stopped part way, each record written once', async () => {
      const first = withFakeOrgs({ target: { interruptOn: 'Contact' } });

      expect(await run(argv('--json', '--yes'))).toBe(130);

      const stopped = JSON.parse(stdout.join('')) as { interrupted?: boolean; journal: string };
      expect(stopped.interrupted).toBe(true);
      const wroteFirst = first.TGT.creates.map((call) => call.name);
      expect(wroteFirst).toContain('Account');

      stdout = [];
      const second = withFakeOrgs({ target: { firstId: 500 } });
      expect(await run(argv('--json', '--yes', '--resume', stopped.journal))).toBeUndefined();

      const taken = JSON.parse(stdout.join('')) as { result: { status: string } };
      expect(taken.result.status).toBe('success');
      expect(stderr.join('')).toContain(`taking up the run of ${stopped.journal}`);
      // What the first part wrote is linked to, never written again.
      const written = [...first.TGT.creates, ...second.TGT.creates].flatMap((call) =>
        call.rows.map((row) => `${call.name}:${String(row['Name'] ?? row['LastName'])}`),
      );
      expect(written.sort()).toEqual(
        [
          'Account:One',
          'Account:Two',
          'Account:Three',
          'Contact:A',
          'Contact:B',
          'Contact:C',
          'Contact:D',
          'ns__Policy__c:P1',
          'ns__Policy__c:P2',
          'Ticket__c:Ticket 1',
          'Ticket__c:Ticket 2',
        ].sort(),
      );
    });

    it('is refused at its gate before its question, with --yes too, for what the target has not left, naming each refusal', async () => {
      const orgs = withFakeOrgs({
        target: { limits: { ...LIMITS, DataStorageMB: { Max: 1_000, Remaining: 0 } } },
      });

      expect(await run(argv('--json', '--yes', '--max-total', '5'))).toBe(1);

      const refused = JSON.parse(stdout.join('')) as {
        refused: { code: string; message: string };
        alsoRefused?: Array<{ code: string }>;
      };
      expect(refused.refused.code).toBe('MAX_TOTAL_EXCEEDED');
      expect(refused.alsoRefused?.map((also) => also.code)).toEqual(['STORAGE_EXCEEDED']);
      expect(stderr.join('')).not.toContain('--yes: written without the question');
      expect(orgs.TGT.creates).toEqual([]);
    });

    it('says the gate’s refusals in the command line’s words, its flags for the page and its setting', () => {
      expect(
        wholeOrgRefusalWords(
          'The source would neither sum nor list its files: turn the copy of files off on Review, ' +
            'or run it again.',
        ),
      ).toBe(
        'The source would neither sum nor list its files: leave out --files, or run it again.',
      );
      expect(
        wholeOrgRefusalWords(
          'more than the 50000 rows of one object the sandforge.forge.maxRecordsPerObject ' +
            'setting lets a run hold at once: raise the setting or leave the object out on Review.',
        ),
      ).toBe(
        'more than the 50000 rows of one object --max-records-per-object lets a run hold at ' +
          'once: raise it or leave it out with --exclude-object.',
      );
    });

    it('ends 3 when the target refused part of the org, unasked', async () => {
      withFakeOrgs({ target: { refuse: new Set(['D']) } });

      expect(await run(argv('--json', '--yes'))).toBe(3);

      const document = JSON.parse(stdout.join('')) as { result: { status: string } };
      expect(document.result.status).toBe('partial');
    });
  });

  describe('its Bulk API jobs', () => {
    /** An org whose job is closed and then never answers: lost, the org writing it perhaps still. */
    function losingOrg() {
      const created: string[] = [];
      const conn = {
        bulk2: {
          createJob: (options: { object: string }) => {
            created.push(options.object);
            return {
              // The org gave no id before the answers stopped.
              get id() {
                return undefined;
              },
              open: async () => undefined,
              uploadData: async () => undefined,
              close: async () => undefined,
              abort: async () => undefined,
              check: async () => {
                throw new Error('socket hang up');
              },
              getAllResults: async () => ({}),
            };
          },
        },
      } as unknown as Connection;
      return { conn, created };
    }

    it('notes a job closed and not read back as lost, for the mute to wait on, and counts it written', async () => {
      const { conn } = losingOrg();
      const lost = new LostBulkJobs(async () => 'JobComplete');
      const wrote = vi.fn();
      const deps = wholeOrgWriteDeps(
        new Map([['TGT', conn]]),
        { dryRun: false, applyAssignmentRules: false },
        lost,
        wrote,
      );

      await expect(
        deps.bulkWriteRecords?.('TGT', 'Ticket__c', 'insert', [{ Name: 'T1' }, { Name: 'T2' }], {
          bulkManager: new BulkApiManager(1),
        }),
      ).rejects.toBeInstanceOf(BulkJobLostError);

      expect(lost.since(0, 'TGT')).toEqual([{ orgId: 'TGT', objectApiName: 'Ticket__c' }]);
      expect(wrote).toHaveBeenCalled();
    });

    it('sends no job of a lead or a case while the run applies the assignment rules, and none on a dry run', async () => {
      const { conn, created } = losingOrg();
      const conns = new Map([['TGT', conn]]);
      const manager = { bulkManager: new BulkApiManager(1) };
      const ruled = wholeOrgWriteDeps(
        conns,
        { dryRun: false, applyAssignmentRules: true },
        undefined,
        () => undefined,
      );

      const answer = await ruled.bulkWriteRecords?.('TGT', 'Lead', 'insert', [{}], manager);

      expect(answer?.untouched).toMatchObject({ unsupported: true });
      const dry = wholeOrgWriteDeps(
        conns,
        { dryRun: true, applyAssignmentRules: false },
        undefined,
        () => undefined,
      );
      await expect(
        dry.bulkWriteRecords?.('TGT', 'Ticket__c', 'insert', [{}], manager),
      ).rejects.toThrow('A dry run sends no Bulk API job.');
      expect(created).toEqual([]);
    });

    it('waits for the lost jobs to end before the mute is given back, and names those still running past the wait', async () => {
      const said: string[] = [];
      const states = ['InProgress', 'JobComplete'];
      const ending = new LostBulkJobs(async () => states.shift() ?? 'JobComplete', {
        pollDelay: () => 0,
        sleep: async () => undefined,
      });
      ending.note({ orgId: 'TGT', objectApiName: 'Ticket__c', jobId: '750000000000001AAA' });

      expect(await lostJobsBeforeTheMute(ending, 'TGT', (line) => said.push(line))).toEqual([]);
      expect(states).toEqual([]);
      expect(said).toEqual([
        'waiting for 1 Bulk API job(s) the run could not read back to end, before the mute is given back…',
      ]);

      // A job no read can reach, its id never given: still running, and said.
      const unreadable = new LostBulkJobs(async () => 'JobComplete');
      unreadable.note({ orgId: 'TGT', objectApiName: 'Ticket__c' });
      said.length = 0;
      expect(await lostJobsBeforeTheMute(unreadable, 'TGT', (line) => said.push(line))).toEqual([
        { orgId: 'TGT', objectApiName: 'Ticket__c' },
      ]);
      expect(said[1]).toBe(
        'warning: 1 Bulk API job(s) were still running as the mute was given back: Ticket__c; ' +
          "their records may have gone in with the target's automation on",
      );
      // None lost, none waited for.
      expect(await lostJobsBeforeTheMute(undefined, 'TGT', (line) => said.push(line))).toEqual([]);
    });
  });

  describe('the removal of its journal', () => {
    it('takes the records a job wrote that no row was matched to, with the rest of their object, never one a row maps to', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-all-journal-'));
      try {
        const path = join(dir, 'run.ndjson');
        writeFileSync(
          path,
          `${JSON.stringify({
            run: {
              journalId: 'whole-org-run',
              targetOrgId: TARGET_ORG,
              startedAt: '2026-11-12T10:00:00.000Z',
            },
          })}\n${JSON.stringify({ part: { n: 0, startedAt: '2026-11-12T10:00:00.000Z' } })}\n`,
        );
        const mapped = 'a02000000000901AAA';
        const unmatched = 'a02000000000902AAA';
        appendFileSync(
          path,
          `${JSON.stringify(['c', 'a02000000000001AAA', mapped, 'Ticket__c'])}\n`,
        );
        // A job's record no row was matched to, and one a reconciliation
        // matched to its row since: the mapping says the second.
        appendFileSync(
          path,
          `${JSON.stringify([UNATTRIBUTED_TAG, 'Ticket__c', [mapped, unmatched]])}\n`,
        );

        const read = await runSummaryOfFile(path, readFileSync(path, 'utf8'), 'TGT');
        if ('refusal' in read) throw new Error(read.refusal);

        expect(removalPlan(read.summary)).toEqual([
          { objectApiName: 'Ticket__c', ids: [mapped, unmatched] },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
