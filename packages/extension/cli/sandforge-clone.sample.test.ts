import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import type { WholeOrgSample, WholeOrgSampleResult } from '@sandforge/shared';
import type { ExecutionSummary } from '../src/modules/forge/ForgeExecutor.js';
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
  fieldInfosOf,
  jsonResult,
  main,
  parseArgs,
  sampleBudgetOf,
  sampleJson,
  sampleLines,
  sampleReadsLine,
  sampleRefusalExit,
  sampleResultJson,
  sampleResultLines,
  samplingProgressPrinter,
  wholeOrgQuestionWords,
  wholeOrgRunConfig,
} from './sandforge-clone';
import { forgeRunFingerprint } from '../src/modules/forge/runFingerprint.js';
import { ForgeRunGateError, sampleGateErrorOf } from '../src/modules/forge/ForgeRunGate.js';
import { SampleRefusedError } from '../src/modules/forge/sample/sampleDrawing.js';
import { SampleSourceOrg } from '../src/test/sampleSourceOrg.js';
import { SamplePlan } from '../src/modules/forge/sample/samplePlanStore.js';
import { AuditTrailStore } from '../src/modules/audit/auditTrail.js';
import { fileConfigStore } from './fileConfigStore.js';

/*
 * A sample of the whole org from the command line (`--depth all --fit share`):
 * its flags and their refusals, read before any org is reached; what its dry
 * run and its run say, line by line and as JSON; its codes and their exits;
 * and the command run whole against a source that answers the reads of a
 * sample as the org does (`test/sampleSourceOrg.ts`) and a target that takes
 * what it is sent: a dry run draws a plan, a run writes that plan's records
 * and no other (`--fit-plan`), a plan gone or drawn otherwise is refused.
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

const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }],
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
  Ticket__c: object('Ticket__c', 'a02', [{ name: 'Name' }]),
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

/**
 * The source: `accounts` accounts, a contact under each, `tickets` tickets of
 * their own; each record created a minute after the one before it, the
 * newest last — or, of the accounts, first (`datesAgainstIds`): their ids
 * then run against the order they were made in, as ids loaded hours apart
 * did on a scratch org.
 */
function sourceOf(accounts = 150, tickets = 50, datesAgainstIds = false): SampleSourceOrg {
  const org = new SampleSourceOrg();
  for (const [name, columns] of Object.entries(COLUMNS)) org.columns.set(name, columns);
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  for (let n = 1; n <= accounts; n++) {
    org.add('Account', {
      Id: sourceId('001', n),
      Name: `Account ${n}`,
      CreatedDate: at(datesAgainstIds ? accounts + 1 - n : n),
      IsDeleted: false,
    });
    org.add('Contact', {
      Id: sourceId('003', n),
      LastName: `Contact ${n}`,
      AccountId: sourceId('001', n),
      CreatedDate: at(n),
      IsDeleted: false,
    });
  }
  for (let n = 1; n <= tickets; n++) {
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

/**
 * The source, as the command reaches it: its statements answered by `org` as
 * the org answers them — a column the describe does not list refused, a
 * request line past what it holds refused — and those of an object it holds
 * no row of answered empty.
 */
function sourceConn(
  org: SampleSourceOrg,
  limits: Record<string, unknown> = LIMITS,
  describes: Record<string, DescribeSObjectResult> = DESCRIBES,
) {
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
    sobject: (name: string) => ({ describe: async () => describes[name] }),
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
      if (url === '/limits') return limits;
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
 * The target: it creates what it is sent, each record kept with the source id
 * the run wrote it for; it holds none of the source's, and answers every read
 * empty. A Ctrl-C comes during the first create of `interruptOn`. With
 * `taskOnTicket`, a flow of its own creates a task after each ticket is
 * inserted, as the Tooling API gives a flow's version: its definition read,
 * its record-create element named.
 */
function targetConn(
  options: {
    limits?: Record<string, unknown>;
    interruptOn?: string;
    firstId?: number;
    taskOnTicket?: boolean;
  } = {},
) {
  const flowVersion = '301000000000001AAA';
  const flows = options.taskOnTicket
    ? [
        {
          ApiName: 'Ticket_Task',
          Label: 'Ticket task',
          TriggerType: 'RecordAfterSave',
          RecordTriggerType: 'Create',
          TriggerObjectOrEvent: { QualifiedApiName: 'Ticket__c' },
          ActiveVersionId: flowVersion,
        },
      ]
    : [];
  const flowMetadata = { start: {}, recordCreates: [{ name: 'Follow_up', object: 'Task' }] };
  const limits = options.limits ?? LIMITS;
  const creates: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
  let made = options.firstId ?? 0;
  let interrupted = false;
  const idOf = (name: string): string =>
    `${DESCRIBES[name]?.keyPrefix ?? 'a09'}T${String(made++).padStart(11, '0')}AAA`;
  const conn = {
    version: '62.0',
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: Array<Record<string, unknown>>) => {
        creates.push({ name, rows: records });
        if (name === options.interruptOn && !interrupted) {
          interrupted = true;
          process.emit('SIGINT', 'SIGINT');
        }
        return records.map(() => ({ id: idOf(name), success: true, errors: [] }));
      },
      update: async (records: Array<Record<string, unknown>>) =>
        records.map((record) => ({ id: record['Id'], success: true, errors: [] })),
    }),
    describeGlobal: async () => ({ sobjects: globalOf() }),
    identity: async () => ({ user_id: RUN_USER }),
    query: async (soql: string) => {
      const organization = organizationOf(soql, TARGET_ORG);
      if (organization) return organization;
      // Its processes are read from the same view: it holds none.
      if (soql.includes(" ProcessType = 'Workflow'")) return page([]);
      if (soql.includes(' FROM FlowDefinitionView ')) return page(flows);
      return page([]);
    },
    queryMore: async () => page([]),
    tooling: {
      query: async (soql: string) =>
        page(flows.length > 0 && / FROM Flow\b/.test(soql) ? [{ Metadata: flowMetadata }] : []),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: string | { url: string; body?: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url === '/limits') return limits;
      if (url === '/tooling/composite' && typeof request !== 'string') {
        // Each part answered as the Tooling API answers it alone: a flow's
        // version retrieved by id with its metadata, any query empty.
        const { compositeRequest } = JSON.parse(String(request.body)) as {
          compositeRequest: Array<{ url: string; referenceId: string }>;
        };
        return {
          compositeResponse: compositeRequest.map((sub) => {
            const version = /\/tooling\/sobjects\/Flow\/(\w+)$/.exec(sub.url)?.[1];
            return {
              referenceId: sub.referenceId,
              httpStatusCode: 200,
              body: version ? { Id: version, Metadata: flowMetadata } : page([]),
            };
          }),
        };
      }
      return {};
    },
  };
  return { conn: conn as unknown as Connection, creates };
}

/** Both fake orgs answering for SRC and TGT. */
function withFakeOrgs(
  options: {
    source?: SampleSourceOrg;
    sourceLimits?: Record<string, unknown>;
    /** What the source describes, its objects' as both orgs describe them unless given. */
    sourceDescribes?: Record<string, DescribeSObjectResult>;
    target?: Parameters<typeof targetConn>[0];
  } = {},
) {
  const source = options.source ?? sourceOf();
  const target = targetConn(options.target);
  const conns = {
    SRC: sourceConn(source, options.sourceLimits, options.sourceDescribes),
    TGT: target.conn,
  };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
  return { source, target };
}

/** The source ids the target was sent, per object, in the order sent. */
function sentIds(creates: ReturnType<typeof targetConn>['creates']): Record<string, string[]> {
  const sent: Record<string, string[]> = {};
  for (const { name, rows } of creates) {
    for (const row of rows) {
      const label = String(row['Name'] ?? row['LastName']);
      (sent[name] ??= []).push(label);
    }
  }
  return sent;
}

/** The JSON a dry run of a sample prints, as far as these tests read it. */
interface DryRunJson {
  dryRun: boolean;
  wholeOrg: {
    sample: ReturnType<typeof sampleJson>;
    wouldInsert: Array<{ objectApiName: string; rows: number }>;
    totalRows: number;
  };
  wouldBeRefusedCodes?: string[];
}

/** The JSON of a refusal before the first write. */
interface RefusedJson {
  dryRun: boolean;
  refused: { code: string; message: string };
}

let stdout: string[];
let stderr: string[];
let printed: string[];
let journalDir: string;
const journalsBefore = process.env['SANDFORGE_JOURNAL_DIR'];

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  printed = [];
  journalDir = mkdtempSync(join(tmpdir(), 'sandforge-clone-sample-'));
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
  process.env['SANDFORGE_JOURNAL_DIR'] = journalsBefore;
  rmSync(journalDir, { recursive: true, force: true });
});

/** The folders of the dry runs' plans under the journal directory. */
function dryRunPlans(): string[] {
  const dir = join(journalDir, 'forge-samples');
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

describe('the command line of a sample of the whole org', () => {
  it('reads --fit share and each --fit-* flag into the options of the sample, --max-total among them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-plan-'));
    try {
      const args = parseArgs(
        argv(
          '--fit',
          'share',
          '--fit-within',
          '3.5',
          '--fit-seed',
          '7',
          '--fit-draw',
          'recent',
          '--fit-parents',
          'required',
          '--fit-children',
          '20',
          '--fit-whole',
          'Ticket__c',
          '--fit-whole',
          'Region__c',
          '--fit-whole',
          'Ticket__c',
          '--fit-floor',
          '0',
          '--fit-plan',
          join(dir, 'sample.json'),
          '--max-total',
          '500',
        ),
      );

      expect(args.sample).toEqual({
        options: {
          maxTotal: 500,
          withinMB: 3.5,
          seed: 7,
          draw: 'recent',
          parents: 'required',
          children: 20,
          whole: ['Ticket__c', 'Region__c'],
          floor: 0,
          // The manifest named, its folder taken.
          plan: dir,
        },
        maxTotalGiven: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds the sample by the default --max-total, said not given, and takes children all', () => {
    const args = parseArgs(argv('--fit', 'share', '--fit-children', 'all'));

    expect(args.sample).toEqual({
      options: { maxTotal: 10_000, children: 'all' },
      maxTotalGiven: false,
    });
    // The run's config carries the sample; the line without --fit share, none.
    expect(wholeOrgRunConfig(args).sample).toEqual({ maxTotal: 10_000, children: 'all' });
    expect(parseArgs(argv()).sample).toBeUndefined();
    expect(wholeOrgRunConfig(parseArgs(argv()))).not.toHaveProperty('sample');
  });

  it('keeps the plan replayed out of the config, and its SHA-256 alone in the setup the run is fingerprinted by', () => {
    const args = parseArgs(argv('--fit', 'share', '--fit-plan', '/plans/a', '--fit-seed', '3'));

    expect(wholeOrgRunConfig(args).sample).toEqual({ maxTotal: 10_000, seed: 3 });
    const setup = cliRunSetup(args, TARGET_ORG, {
      sourceOrgId: SOURCE_ORG,
      planSha256: 'a'.repeat(64),
    });
    expect(setup.sample).toEqual({
      maxTotal: 10_000,
      seed: 3,
      draw: 'uniform',
      parents: 'all',
      children: 100,
      floor: 1,
      whole: [],
      planSha256: 'a'.repeat(64),
    });
    expect(setup.sourceOrgId).toBe(SOURCE_ORG.slice(0, 15));
    expect(JSON.stringify(setup)).not.toContain('/plans/a');
    // A run of every record keeps the setup its journals were begun with.
    expect(
      cliRunSetup(parseArgs(argv()), TARGET_ORG, { sourceOrgId: SOURCE_ORG }),
    ).not.toHaveProperty('sample');
  });

  it('fingerprints the same options alike however they are said, and another seed otherwise', () => {
    const graph = {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    const of = (...flags: string[]) =>
      forgeRunFingerprint(
        graph,
        cliRunSetup(parseArgs(argv('--fit', 'share', ...flags)), TARGET_ORG),
      );

    expect(of()).toBe(of('--fit-seed', '1', '--fit-draw', 'uniform', '--fit-floor', '1'));
    expect(of('--fit-whole', 'B__c', '--fit-whole', 'A__c')).toBe(
      of('--fit-whole', 'A__c', '--fit-whole', 'B__c'),
    );
    expect(of('--fit-seed', '2')).not.toBe(of());
    expect(of('--max-total', '20')).not.toBe(of());
  });

  it.each([
    ['--fit-within', '2'],
    ['--fit-seed', '2'],
    ['--fit-draw', 'recent'],
    ['--fit-parents', 'required'],
    ['--fit-children', '5'],
    ['--fit-whole', 'Account'],
    ['--fit-floor', '2'],
    ['--fit-plan', '/plans/a'],
  ])('refuses %s without --fit share, exit 2, before any org is reached', (flag, value) => {
    expect(() => parseArgs(argv(flag, value))).toThrow(ExitCalled);

    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain(`${flag} goes with --depth all --fit share`);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('refuses --fit share without --depth all, exit 2: a walk reads what it reaches', () => {
    const line = [
      'node',
      'x',
      '--record',
      '001000000000001AAA',
      '--source',
      'S',
      '--target',
      'T',
      '--fit',
      'share',
    ];

    expect(() => parseArgs(line)).toThrow(ExitCalled);
    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain('--fit share goes with --depth all');
  });

  it.each([
    [['--fit', 'all'], '--fit takes share, once, not "all"'],
    [['--fit', 'share', '--fit', 'share'], '--fit takes share, once'],
    [['--fit', 'share', '--files'], '--fit share copies no files yet'],
    [['--fit', 'share', '--list-objects'], '--list-objects lists the objects of the graph'],
    [
      ['--fit', 'share', '--fit-plan', '/plans/a', '--resume', 'run-1'],
      '--fit-plan does not go with --resume',
    ],
    [['--fit', 'share', '--fit-within', '0'], '--fit-within takes a number of MB above 0'],
    [['--fit', 'share', '--fit-within', 'lots'], '--fit-within takes a number of MB above 0'],
    [['--fit', 'share', '--fit-within', '1000001'], '--fit-within takes a number of MB above 0'],
    [['--fit', 'share', '--fit-seed', '1.5'], '--fit-seed takes a whole number, 0 or more'],
    [['--fit', 'share', '--fit-seed', 'x'], '--fit-seed takes a whole number, 0 or more'],
    [['--fit', 'share', '--fit-draw', 'newest'], '--fit-draw takes uniform'],
    [['--fit', 'share', '--fit-parents', 'some'], '--fit-parents takes all'],
    [['--fit', 'share', '--fit-children', '0'], '--fit-children takes a whole number'],
    [['--fit', 'share', '--fit-children', '1000001'], '--fit-children takes a whole number'],
    [['--fit', 'share', '--fit-floor', '10001'], '--fit-floor takes a whole number of records'],
    [['--fit', 'share', '--fit-floor', 'one'], '--fit-floor takes a whole number of records'],
    [['--fit', 'share', '--fit-whole', 'Not-An-Object'], 'Invalid --fit-whole value'],
    [['--fit', 'share', '--fit-seed', '1', '--fit-seed', '2'], '--fit-seed is given twice'],
    [
      ['--fit', 'share', '--fit-whole', 'Ticket__c', '--exclude-object', 'Ticket__c'],
      '--fit-whole and --exclude-object both name Ticket__c',
    ],
  ])('refuses %j, exit 2, in its words, before any org is reached', (flags, words) => {
    expect(() => parseArgs(argv(...flags))).toThrow(ExitCalled);

    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain(words);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('refuses --max with --depth all in words that name --fit share', () => {
    expect(() => parseArgs(argv('--max', '10'))).toThrow(ExitCalled);

    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain(
      '--fit share copies a sample of the org that fits the target',
    );
  });
});

/** A sample as a plan keeps it: each part of its report, a few of each. */
function sampleReport(overrides: Partial<WholeOrgSample> = {}): WholeOrgSample {
  return {
    seed: 1,
    draw: 'uniform',
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
        sourceRows: 18_400,
        kept: 712,
        roots: 500,
        below: 0,
        asParents: 212,
      },
      {
        objectApiName: 'Contact',
        sourceRows: 50_000,
        kept: 1_070,
        roots: 0,
        below: 1_050,
        asParents: 20,
        childrenCut: [{ field: 'AccountId', rows: 230 }],
      },
      {
        objectApiName: 'Region__c',
        sourceRows: 30,
        kept: 30,
        roots: 0,
        below: 0,
        asParents: 0,
        whole: true,
      },
    ],
    whole: [{ objectApiName: 'Region__c', why: 'smallParent' }],
    heavyRoots: [
      {
        objectApiName: 'Account',
        id: '001S00000000099AAA',
        rows: 4_200,
        relation: { objectApiName: 'Task', field: 'WhatId' },
      },
    ],
    dropped: [{ objectApiName: 'Contact', rows: 3, reason: 'noParentInSource' }],
    leftEmpty: [{ objectApiName: 'Opportunity', field: 'CampaignId', rows: 12 }],
    noRecordDrawn: [{ objectApiName: 'Lead', sourceRows: 40 }],
    planRequests: { source: 120 },
    plan: {
      path: '/home/u/.sandforge/forge-samples/abc',
      sha256: 'f'.repeat(64),
      drawnAt: '2026-11-14T10:00:00.000Z',
      drawnBy: 'dryRun',
    },
    ...overrides,
  };
}

/** A summary of a run that wrote nothing. */
function emptySummary(): ExecutionSummary {
  return {
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    linkedCount: 0,
    updatedCount: 0,
    wouldInsertCount: 0,
    remapCount: 0,
    errors: [],
    existingRecords: [],
    remapTable: {},
    existingSourceIds: [],
    updatedSourceIds: [],
    createdByObject: {},
    readByObject: {},
    failedReads: [],
  } as unknown as ExecutionSummary;
}

describe('what a sample of the whole org says', () => {
  it('says what it keeps, how its roots were drawn, what it may take and what held it, then each object', () => {
    const lines = sampleLines(sampleReport(), { source: 'SRC', target: 'TGT', dryRun: true });

    expect(lines[0]).toBe(
      'sample: 1812 of 68470 record(s) of SRC, of 3 object(s): 0.41 % of the roots of each ' +
        'object (seed 1, spread over the org), with the records they reach and name; about ' +
        '3.5 MB of the 3.61 MB the sample may take (80 % of the 5 MB TGT has left of 5 MB, ' +
        '0.5 MB off for rounding); limited by the data storage TGT has left',
    );
    expect(lines).toContain(
      '  Account: 712 of 18400 (500 drawn, 0 under a parent, 212 as parents)',
    );
    expect(lines).toContain(
      '  Contact: 1070 of 50000 (0 drawn, 1050 under a parent, 20 as parents); left by the cap ' +
        'of 100 children a record, by the lookup naming their parent: AccountId 230',
    );
    expect(lines).toContain('  Region__c: 30 of 30 (copied whole (a small parent))');
    expect(lines).toContain('whole: Region__c (a small parent)');
    // Weighed against the room the target has, not what the sample may take.
    expect(lines).toContain(
      'heavy roots set aside, each bringing in more than a tenth of the room TGT has:',
    );
    expect(lines).toContain('  Account 001S00000000099AAA: 4200 record(s) through Task.WhatId');
    expect(lines).toContain(
      '  Contact: 3, a lookup they may not leave empty names a record SRC does not hold',
    );
    expect(lines).toContain('  Opportunity.CampaignId: 12 record(s)');
    expect(lines).toContain('  Lead: 40 in SRC');
    expect(lines).toContain(
      `sample plan: /home/u/.sandforge/forge-samples/abc (sha256 ${'f'.repeat(64)}, drawn ` +
        '2026-11-14T10:00:00.000Z by this dry run)',
    );
    expect(lines.at(-1)).toBe(
      '  drawing it sent 120 request(s) to SRC; --fit-plan /home/u/.sandforge/forge-samples/abc ' +
        'writes these records, within a day',
    );
  });

  // Run for real on a whole org: opportunities copied whole kept 3 of their 4
  // line items, drawn as roots; each amount came to the lines written, and
  // neither the dry run nor the run said so.
  it('says on the line of a master that keeps part of its details what it keeps of them, and that a total of them counts those written alone', () => {
    const report = sampleReport({
      objects: [
        ...sampleReport().objects,
        {
          objectApiName: 'Opportunity',
          sourceRows: 2,
          kept: 2,
          roots: 0,
          below: 0,
          asParents: 0,
          whole: true,
        },
        {
          objectApiName: 'OpportunityLineItem',
          sourceRows: 4,
          kept: 3,
          roots: 3,
          below: 0,
          asParents: 0,
        },
      ],
      whole: [
        { objectApiName: 'Region__c', why: 'smallParent' },
        { objectApiName: 'Opportunity', why: 'smallParent' },
      ],
      partialMasters: [
        { objectApiName: 'Account', details: 'Thing__c', field: 'Account__c', asParents: 212 },
        {
          objectApiName: 'Opportunity',
          details: 'OpportunityLineItem',
          field: 'OpportunityId',
          kept: 3,
          sourceRows: 4,
        },
      ],
    });

    const lines = sampleLines(report, { source: 'SRC', target: 'TGT', dryRun: true });

    expect(lines).toContain(
      '  Opportunity: 2 of 2 (copied whole (a small parent)); keeps 3 of its 4 ' +
        'OpportunityLineItem records (OpportunityLineItem.OpportunityId) in the sample: if it ' +
        'totals them (an amount, a roll-up summary), the total counts only those',
    );
    expect(lines).toContain(
      '  Account: 712 of 18400 (500 drawn, 0 under a parent, 212 as parents); the 212 brought ' +
        'in as parents keep only the Thing__c records (Thing__c.Account__c) drawn on their own: ' +
        'if they total them (an amount, a roll-up summary), the total counts only those',
    );
    expect(sampleJson(report).partialMasters).toEqual(report.partialMasters);
    expect(sampleJson(sampleReport()).partialMasters).toEqual([]);
  });

  it('says the newest by creation date of a draw of the most recent, never its seed', () => {
    const lines = sampleLines(sampleReport({ draw: 'recent', seed: 9 }), {
      source: 'SRC',
      target: 'TGT',
      dryRun: true,
    });

    expect(lines[0]).toContain('(the newest by creation date)');
    expect(lines[0]).not.toContain('seed');
    // An object the org sorts no creation date of is said read by its ids.
    const byIds = sampleLines(sampleReport({ draw: 'recent', newestByIds: ['Thing__c'] }), {
      source: 'SRC',
      target: 'TGT',
      dryRun: true,
    });
    expect(byIds).toContain(
      'newest by the order of their ids, the org sorting none of their creation dates — ids ' +
        'follow it within a load only: Thing__c',
    );
  });

  it.each([
    ['maxTotal', 'limited by --max-total 10000'],
    ['within', 'limited by --fit-within 3'],
    ['targetRequests', 'limited by the daily API requests TGT has left'],
    ['bulkBatches', 'limited by the daily Bulk API batches TGT has left'],
    ['sourceRequests', 'limited by the daily API requests SRC has left'],
    ['whole', 'every record of the org fits: leave out --fit share to copy the whole org'],
    [
      'heavyRoots',
      'every root fits but 1 heavy root(s) set aside below, each past a tenth of the room TGT ' +
        'has: they alone keep the sample from every root',
    ],
  ] as const)('says a sample held by %s in its words', (limitedBy, words) => {
    const sample = sampleReport();
    const lines = sampleLines(
      { ...sample, budget: { ...sample.budget, withinMB: 3, limitedBy } },
      { source: 'SRC', target: 'TGT', dryRun: false },
    );

    expect(lines[0].endsWith(`; ${words}`)).toBe(true);
  });

  it('says a sample held to the records asked when the target would not say its storage', () => {
    const lines = sampleLines(
      sampleReport({
        budget: { bytes: Number.MAX_SAFE_INTEGER, maxTotal: 50, limitedBy: 'maxTotal' },
      }),
      { source: 'SRC', target: 'TGT', dryRun: false },
    );

    expect(lines[0]).toContain(
      'about 3.5 MB, held to 50 records (--max-total): TGT would not say its data storage; ' +
        'limited by --max-total 50',
    );
    expect(lines[0]).not.toContain('9007199254740991');
  });

  it('says whose plan a run writes: its own, or a dry run’s it was given', () => {
    const own = sampleLines(sampleReport({ plan: { ...sampleReport().plan, drawnBy: 'run' } }), {
      source: 'SRC',
      target: 'TGT',
      dryRun: false,
    });
    const given = sampleLines(sampleReport(), { source: 'SRC', target: 'TGT', dryRun: false });

    expect(own.some((line) => line.endsWith('by this run)'))).toBe(true);
    expect(
      given.some((line) => line.endsWith('by a dry run, written by this run (--fit-plan))')),
    ).toBe(true);
    expect(given.at(-1)).toBe('  drawing it sent 120 request(s) to SRC');
  });

  it('gives the sample as JSON with every key in its place, and no byte bound as null', () => {
    const json = sampleJson(sampleReport());

    expect(Object.keys(json)).toEqual([
      'seed',
      'draw',
      'share',
      'floor',
      'parents',
      'children',
      'budget',
      'rows',
      'storageBytes',
      'objects',
      'whole',
      'heavyRoots',
      'dropped',
      'leftEmpty',
      'noRecordDrawn',
      'partialMasters',
      'planRequests',
      'plan',
    ]);
    expect(json.budget).toEqual({
      bytes: 3_774_874,
      remainingMB: 5,
      maxMB: 5,
      share: 0.8,
      roundingMB: 0.5,
      maxTotal: 10_000,
      limitedBy: 'storage',
    });
    expect(json.objects[1]).toEqual({
      objectApiName: 'Contact',
      sourceRows: 50_000,
      kept: 1_070,
      roots: 0,
      below: 1_050,
      asParents: 20,
      childrenCut: [{ field: 'AccountId', rows: 230 }],
    });
    expect(json.plan).toEqual({
      path: '/home/u/.sandforge/forge-samples/abc',
      sha256: 'f'.repeat(64),
      drawnAt: '2026-11-14T10:00:00.000Z',
      drawnBy: 'dryRun',
    });
    const unbounded = sampleJson(
      sampleReport({
        budget: { bytes: Number.MAX_SAFE_INTEGER, maxTotal: 50, limitedBy: 'maxTotal' },
      }),
    );
    expect(unbounded.budget).toEqual({ bytes: null, maxTotal: 50, limitedBy: 'maxTotal' });
  });

  it('says what a run wrote of its plan, per object, apart what left the source and what changed since', () => {
    const result: WholeOrgSampleResult = {
      seed: 1,
      draw: 'uniform',
      share: 0.0041,
      sha256: 'f'.repeat(64),
      drawnAt: '2026-11-14T10:00:00.000Z',
      objects: [
        {
          objectApiName: 'Account',
          sourceRows: 18_400,
          kept: 712,
          roots: 500,
          below: 0,
          asParents: 212,
          written: 712,
          goneSinceTheSample: 0,
          changedSinceTheSample: 0,
        },
        {
          objectApiName: 'Contact',
          sourceRows: 50_000,
          kept: 1_070,
          roots: 0,
          below: 1_050,
          asParents: 20,
          written: 1_068,
          goneSinceTheSample: 1,
          changedSinceTheSample: 1,
        },
      ],
      leftEmpty: [{ objectApiName: 'Opportunity', field: 'CampaignId', rows: 12 }],
    };

    expect(sampleResultLines(result, 'SRC')).toEqual([
      'sample (seed 1, spread over the org, 0.41 % of the roots of each object; plan sha256 ' +
        `${'f'.repeat(64)}, drawn 2026-11-14T10:00:00.000Z):`,
      '  Account: 712 written of 712 in the sample (500 drawn, 0 under a parent, 212 as ' +
        'parents) of 18400 in SRC',
      '  Contact: 1068 written of 1070 in the sample (0 drawn, 1050 under a parent, 20 as ' +
        'parents) of 50000 in SRC; 1 gone from SRC since the sample, not written; 1 changed ' +
        'since the sample: a record they cannot be written without is no longer the one the ' +
        'plan named, held back (failed)',
      '  left empty, their record outside the sample: Opportunity.CampaignId 12',
    ]);
    const json = sampleResultJson(result);
    expect(json.objects[1]).toEqual({
      objectApiName: 'Contact',
      sourceRows: 50_000,
      kept: 1_070,
      roots: 0,
      below: 1_050,
      asParents: 20,
      written: 1_068,
      goneSinceTheSample: 1,
      changedSinceTheSample: 1,
    });
    // Under result.sample, beside the counts of the run.
    const ran = jsonResult({ ...emptySummary(), sample: result }) as { sample?: unknown };
    expect(ran.sample).toEqual(json);
    expect(jsonResult(emptySummary())).not.toHaveProperty('sample');
  });

  it('names a sample in the question of its run, what it keeps and of what, when and by what it was drawn', () => {
    const question = {
      source: 'SRC',
      leftOut: 0,
      targetApi: { estimate: 40 },
      sourceApi: { estimate: 12 },
      restObjects: [],
      durationSeconds: 60,
      sample: {
        rows: 1_812,
        objects: 3,
        sourceRows: 68_470,
        storageMB: 3.5,
        budgetMB: 3.6,
        seed: 1,
        draw: 'uniform',
        share: 0.0041,
        limitedBy: 'storage',
        parents: 'all',
        children: 100,
        drawnAt: '2026-11-14T10:00:00.000Z',
        drawnBy: 'dryRun',
        minutesBefore: 3,
      },
    } as unknown as WholeOrgConfirmation;
    const plan = {
      totalRows: 1_812,
      objects: [
        { objectApiName: 'Account', rows: 712 },
        { objectApiName: 'Contact', rows: 1_070 },
        { objectApiName: 'Region__c', rows: 30 },
      ],
    } as unknown as Parameters<typeof wholeOrgQuestionWords>[1];

    expect(wholeOrgQuestionWords(question, plan, 'TGT', sampleReport())).toMatch(
      new RegExp(
        '^a sample of SRC: 1812 record\\(s\\) of 3 object\\(s\\) \\(of 68470 in SRC\\) into ' +
          'TGT, about 3\\.5 MB of the 3\\.6 MB it may take; seed 1, spread over the org, ' +
          '0\\.41 % of the roots; drawn at 2026-11-14T10:00:00\\.000Z by a dry run; 0 Bulk ' +
          'API job\\(s\\) among them',
      ),
    );
    // What the target's automation creates under its records, said with
    // what it takes: run for real, 1.65 MB of tasks a flow opens.
    const flowing = {
      ...question,
      sample: { ...question.sample, automationMB: 1.65 },
    } as unknown as WholeOrgConfirmation;
    expect(wholeOrgQuestionWords(flowing, plan, 'TGT', sampleReport())).toContain(
      "about 3.5 MB of the 3.6 MB it may take, 1.65 MB of it for what the target's automation creates; seed 1",
    );
    // Without a sample, the words of a clone of every record, as before.
    const every = { ...question, sample: undefined };
    expect(wholeOrgQuestionWords(every, plan, 'TGT')).toMatch(
      /^1812 record\(s\) of 3 object\(s\) of SRC into TGT, 0 Bulk API job\(s\) among them/,
    );
  });

  it('says before it draws about what its roots read of the source, by discovery’s counts', () => {
    const graph = {
      nodes: [
        { objectApiName: 'Account', recordCount: 4_500, included: true },
        { objectApiName: 'Contact', recordCount: 100, included: true },
        { objectApiName: 'Legacy__c', recordCount: 9_000, included: false },
        { objectApiName: 'Empty__c', recordCount: 0, included: true },
      ],
    } as unknown as Parameters<typeof sampleReadsLine>[0];

    // A count and three pages of 2 000 ids, then a count and a page.
    expect(sampleReadsLine(graph, {}, 'SRC')).toContain('at most about 6 request(s) of SRC');
    expect(sampleReadsLine(graph, {}, 'SRC')).toContain("every root's id");
    // The newest: no more than the records asked, a page each.
    const recent = sampleReadsLine(graph, { draw: 'recent', maxTotal: 50 }, 'SRC');
    expect(recent).toContain('at most about 4 request(s) of SRC');
    expect(recent).toContain('the newest by creation date');
    // Past a page, each page after the first may be read again a second apart:
    // three pages of accounts and two more, then a count and a page.
    expect(sampleReadsLine(graph, { draw: 'recent', maxTotal: 5_000 }, 'SRC')).toContain(
      'at most about 8 request(s) of SRC',
    );
  });

  it('says each step of the drawing once, as it begins', () => {
    const said: string[] = [];
    const print = samplingProgressPrinter((line) => said.push(line));

    print({ step: 'counting', rows: 0, requests: 0 });
    print({ step: 'counting', rows: 0, requests: 3 });
    print({ step: 'drawing', rows: 10, requests: 4 });

    expect(said).toEqual([
      'sampling: counting the roots of each object… (0 request(s) so far)',
      'sampling: reading the ids of the roots… (4 request(s) so far)',
    ]);
  });
});

describe('the budget a sample of the whole org is drawn against', () => {
  const sample = (flags: string[] = []) => {
    const args = parseArgs(argv('--fit', 'share', ...flags));
    if (!args.sample) throw new Error('no sample');
    return args.sample;
  };

  it('takes 80 % of what the target has left, half a MB off, the MB asked when lower, and the records asked', () => {
    const storage = { maxMB: 5, remainingMB: 5 };
    const terms = sampleBudgetOf({ storage, sample: sample(), target: 'TGT' });

    expect(terms.budget).toEqual({
      bytes: Math.floor(0.8 * 4.5 * 1024 * 1024),
      remainingMB: 5,
      maxMB: 5,
      share: 0.8,
      roundingMB: 0.5,
      maxTotal: 10_000,
      limitedBy: 'storage',
    });
    expect(terms.bytesLimit).toBe('storage');
    expect(terms.roomBytes).toBe(Math.floor(0.8 * 4.5 * 1024 * 1024));

    const within = sampleBudgetOf({
      storage,
      sample: sample(['--fit-within', '1']),
      target: 'TGT',
    });
    expect(within.budget).toMatchObject({ bytes: 1024 * 1024, withinMB: 1, limitedBy: 'within' });
    expect(within.bytesLimit).toBe('within');
    // The room the objects copied whole are weighed against is the target's, the MB asked aside.
    expect(within.roomBytes).toBe(Math.floor(0.8 * 4.5 * 1024 * 1024));
  });

  it('is refused SAMPLE_STORAGE_UNREAD when the target would not say its storage and nothing else bounds it', () => {
    let thrown: unknown;
    try {
      sampleBudgetOf({ storage: { unread: 'HTTP 500' }, sample: sample(), target: 'TGT' });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ForgeRunGateError);
    expect((thrown as ForgeRunGateError).code).toBe('SAMPLE_STORAGE_UNREAD');
    expect((thrown as Error).message).toContain('--fit-within <MB>');
    expect(sampleRefusalExit('SAMPLE_STORAGE_UNREAD')).toBe(1);
  });

  it('draws against the records asked, or the MB asked, when the target would not say its storage', () => {
    const records = sampleBudgetOf({
      storage: { unread: 'HTTP 500' },
      sample: sample(['--max-total', '50']),
      target: 'TGT',
    });
    expect(records.budget).toEqual({
      bytes: Number.MAX_SAFE_INTEGER,
      maxTotal: 50,
      limitedBy: 'maxTotal',
    });
    expect(records.roomBytes).toBe(50 * 2048);

    const mb = sampleBudgetOf({
      storage: { unread: 'HTTP 500' },
      sample: sample(['--fit-within', '2']),
      target: 'TGT',
    });
    expect(mb.budget).toEqual({
      bytes: 2 * 1024 * 1024,
      withinMB: 2,
      maxTotal: 10_000,
      limitedBy: 'within',
    });
  });

  it('keeps what the automation still running creates under each record off what the sample may take', () => {
    const terms = sampleBudgetOf({
      storage: { maxMB: 5, remainingMB: 5 },
      sample: sample(),
      target: 'TGT',
      automation: [
        { objectApiName: 'Case', bytes: 2048 },
        { objectApiName: 'Case', bytes: 1024 },
      ],
    });

    expect(terms.automationBytes?.('Case')).toBe(3072);
    expect(terms.automationBytes?.('Account')).toBe(0);
    // Held to the records asked, its storage unread, the same room is kept.
    const unread = sampleBudgetOf({
      storage: { unread: 'HTTP 500' },
      sample: sample(['--max-total', '50']),
      target: 'TGT',
      automation: [{ objectApiName: 'Case', bytes: 2048 }],
    });
    expect(unread.automationBytes?.('Case')).toBe(2048);
  });
});

describe('the codes a sample is refused under, and their exits', () => {
  it.each([
    ['SAMPLE_STORAGE_UNREAD', 1],
    ['SAMPLE_CANNOT_FIT', 1],
    ['SAMPLE_TOO_LARGE', 1],
    ['SAMPLE_PLAN_MISMATCH', 2],
    ['SAMPLE_PLAN_GONE', 2],
    ['API_BUDGET_EXCEEDED', 1],
    ['STORAGE_EXCEEDED', 1],
  ])('ends a run refused %s on %i', (code, exit) => {
    expect(sampleRefusalExit(code)).toBe(exit);
  });

  it('takes the drawing’s refusal of a sample too large to hold for its gate’s code, exit 1', () => {
    const gate = sampleGateErrorOf(
      new SampleRefusedError('SAMPLE_TOO_LARGE', 'More than 1000000 records to hold.'),
      'draw',
    );

    expect(gate?.code).toBe('SAMPLE_TOO_LARGE');
    expect(sampleRefusalExit(gate?.code ?? '')).toBe(1);
  });
});

describe('the describe a clone reads the fields of an object from', () => {
  it('keeps whether the org groups, orders and aggregates by a field, and says nothing it was not told', () => {
    const fields = fieldInfosOf({
      name: 'FeedItem',
      fields: [
        described({
          name: 'Id',
          type: 'id',
          aggregatable: false,
          groupable: false,
          sortable: true,
        }),
        described({
          name: 'ParentId',
          type: 'reference',
          referenceTo: ['Case'],
          groupable: true,
          sortable: undefined,
          aggregatable: undefined,
        }),
        described({
          name: 'Body',
          groupable: undefined,
          sortable: undefined,
          aggregatable: undefined,
        }),
      ],
    } as unknown as DescribeSObjectResult);

    expect(
      fields.map(({ name, groupable, sortable, aggregatable }) => ({
        name,
        groupable,
        sortable,
        aggregatable,
      })),
    ).toEqual([
      { name: 'Id', groupable: false, sortable: true, aggregatable: false },
      { name: 'ParentId', groupable: true, sortable: undefined, aggregatable: undefined },
      { name: 'Body', groupable: undefined, sortable: undefined, aggregatable: undefined },
    ]);
    expect(fields.map((field) => 'groupable' in field)).toEqual([true, true, false]);
  });
});

/** What `/limits` says of a Developer Edition, empty: 5 MB of data storage. */
const DEVELOPER_EDITION = {
  ...LIMITS,
  DataStorageMB: { Max: 5, Remaining: 5 },
};

/** The JSON a run of a sample prints, as far as these tests read it. */
interface RunJson {
  journal: string;
  sample: ReturnType<typeof sampleJson>;
  result: { status: string; successCount: number; sample: ReturnType<typeof sampleResultJson> };
}

/** The names of the records a plan holds of each object, as the fake source names them. */
async function namesOfThePlan(dir: string): Promise<Record<string, string[]>> {
  const plan = await SamplePlan.open(dir);
  const label: Record<string, string> = {
    Account: 'Account',
    Contact: 'Contact',
    Ticket__c: 'Ticket',
  };
  const names: Record<string, string[]> = {};
  for (const { objectApiName } of plan.manifest.objects) {
    for await (const ids of plan.ids(objectApiName)) {
      for (const id of ids) {
        (names[objectApiName] ??= []).push(`${label[objectApiName]} ${Number(id.slice(4, 15))}`);
      }
    }
  }
  return names;
}

/** `names` per object, each list sorted: what two runs are compared by. */
function sorted(names: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(names)
      .map(([object, list]) => [object, [...list].sort()] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The folders of plans beside the runs' journals. */
function runPlans(): string[] {
  const dir = join(journalDir, 'forge-runs');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.sample')) : [];
}

describe('sandforge-clone --depth all --fit share, run whole', () => {
  it('draws a plan in its dry run, says it line by line and under wholeOrg.sample, keeps it a day, and writes nothing', async () => {
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });

    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json')),
    ).toBeUndefined();

    const dry = JSON.parse(stdout.join('')) as DryRunJson;
    const { sample } = dry.wholeOrg;
    expect(sample.draw).toBe('uniform');
    expect(sample.budget.limitedBy).toBe('maxTotal');
    expect(sample.budget.maxTotal).toBe(60);
    expect(sample.rows).toBeLessThanOrEqual(60);
    expect(sample.rows).toBeGreaterThan(0);
    // The gate counts the plan's records, object by object.
    expect(dry.wholeOrg.totalRows).toBe(sample.rows);
    for (const { objectApiName, kept } of sample.objects) {
      expect(dry.wholeOrg.wouldInsert.find((o) => o.objectApiName === objectApiName)?.rows).toBe(
        kept,
      );
    }
    // A contact comes with its account, never without it.
    const kept = await namesOfThePlan(sample.plan.path);
    for (const contact of kept['Contact'] ?? []) {
      expect(kept['Account']).toContain(contact.replace('Contact', 'Account'));
    }
    expect(sample.plan.drawnBy).toBe('dryRun');
    expect(dryRunPlans()).toEqual([sample.plan.path]);
    expect(sample.planRequests.source).toBeGreaterThan(0);
    expect(orgs.target.creates).toEqual([]);
    const said = stderr.join('');
    expect(said).toContain(`sample: ${sample.rows} of 350 record(s) of SRC, of 3 object(s)`);
    expect(said).toContain('limited by --max-total 60');
    expect(said).toContain(`sample plan: ${sample.plan.path} (sha256 ${sample.plan.sha256}`);
    expect(said).toContain(`--fit-plan ${sample.plan.path} writes these records, within a day`);
    expect(said).toContain('sample: drawing it reads at most about');
    expect(said).toContain('sampling: counting the roots of each object');
  });

  it('writes with --fit-plan the records of the plan its dry run drew, every one and no other, beside its journal', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json')),
    ).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    const planned = await namesOfThePlan(dry.plan.path);

    stdout = [];
    stderr = [];
    const auditPath = join(journalDir, 'audit.json');
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(
        argv(
          '--fit',
          'share',
          '--max-total',
          '60',
          '--fit-plan',
          dry.plan.path,
          '--yes',
          '--json',
          '--audit',
          auditPath,
        ),
      ),
    ).toBeUndefined();

    const document = JSON.parse(stdout.join('')) as RunJson;
    expect(document.result.status).toBe('success');
    // The same plan, by its SHA-256, moved beside the run's journal.
    expect(document.sample.plan.sha256).toBe(dry.plan.sha256);
    expect(document.sample.plan.drawnBy).toBe('dryRun');
    expect(document.sample.plan.path).toBe(document.journal.replace(/\.ndjson$/, '.sample'));
    expect(existsSync(dry.plan.path)).toBe(false);
    expect(readFileSync(document.journal, 'utf8')).toContain(
      JSON.stringify({ sample: { dir: document.sample.plan.path, sha256: dry.plan.sha256 } }),
    );
    // Its records, each written once, and none other.
    expect(sorted(sentIds(orgs.target.creates))).toEqual(sorted(planned));
    for (const object of document.result.sample.objects) {
      expect(object.written).toBe(object.kept);
      expect(object.goneSinceTheSample).toBe(0);
      expect(object.changedSinceTheSample).toBe(0);
    }
    // Nothing drawn again: no root counted, no id read.
    expect(stderr.join('')).not.toContain('sampling:');
    expect(stderr.join('')).toContain(
      `sample: takes up the plan ${document.sample.plan.path}, drawn ${dry.plan.drawnAt}: no root`,
    );
    expect(stderr.join('')).toContain('--yes: written without the question: a sample of SRC:');
    // The audit trail keeps how it was drawn, and no id.
    const [entry] = new AuditTrailStore(fileConfigStore(auditPath)).list().entries;
    expect(entry.fit).toEqual(
      expect.objectContaining({
        module: 'forge',
        seed: 1,
        draw: 'uniform',
        limitedBy: 'maxTotal',
        kept: dry.rows,
      }),
    );
  });

  it('says what it wrote of the plan, object by object, after its summary', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });

    expect(await run(argv('--fit', 'share', '--max-total', '60', '--yes'))).toBeUndefined();

    const said = printed.join('\n');
    expect(said).toContain('status:  success');
    expect(said).toMatch(
      /\nsample \(seed 1, spread over the org, [\d.]+ % of the roots of each object; plan sha256 [0-9a-f]{64}, drawn /,
    );
    expect(said).toMatch(
      / {2}Account: \d+ written of \d+ in the sample \(\d+ drawn, 0 under a parent, 0 as parents\) of 150 in SRC/,
    );
    expect(runPlans()).toHaveLength(1);
  });

  it('is refused SAMPLE_PLAN_GONE, exit 2, nothing written, for a --fit-plan where no plan is', async () => {
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    const empty = join(journalDir, 'nothing-here');
    mkdirSync(empty);

    expect(await run(argv('--fit', 'share', '--fit-plan', empty, '--yes', '--json'))).toBe(2);

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_PLAN_GONE');
    expect(answer.refused.message).toContain(`Given: ${empty}. Nothing was written.`);
    expect(stderr.join('')).toContain(
      'refused (SAMPLE_PLAN_GONE): No plan of a sample is at the path',
    );
    expect(orgs.target.creates).toEqual([]);
    expect(readdirSync(join(journalDir))).not.toContain('forge-runs');
  });

  it('is refused SAMPLE_PLAN_MISMATCH, exit 2, nothing written, for a --fit-plan drawn with another seed', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--fit', 'share', '--fit-seed', '2', '--dry-run', '--json')),
    ).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;

    stdout = [];
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(await run(argv('--fit', 'share', '--fit-plan', dry.plan.path, '--yes', '--json'))).toBe(
      2,
    );

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_PLAN_MISMATCH');
    expect(answer.refused.message).toContain('was drawn for another setup of the run');
    expect(orgs.target.creates).toEqual([]);
    // Still there, for the run of its own setup.
    expect(existsSync(dry.plan.path)).toBe(true);
  });

  it('puts the plan of --fit-plan back where it was given when its run writes nothing', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json')),
    ).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;

    stdout = [];
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    // No --yes, and no terminal to answer the question.
    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--fit-plan', dry.plan.path, '--json')),
    ).toBe(1);

    expect((JSON.parse(stdout.join('')) as RefusedJson).refused.code).toBe(
      'CONFIRMATION_UNAVAILABLE',
    );
    expect(orgs.target.creates).toEqual([]);
    expect(existsSync(dry.plan.path)).toBe(true);
    expect((await SamplePlan.open(dry.plan.path)).sha256).toBe(dry.plan.sha256);
    expect(runPlans()).toEqual([]);
  });

  it('is taken up on its plan once stopped part way, each record of the plan written once', async () => {
    const first = withFakeOrgs({ target: { limits: DEVELOPER_EDITION, interruptOn: 'Contact' } });

    expect(await run(argv('--fit', 'share', '--max-total', '60', '--yes', '--json'))).toBe(130);

    const stopped = JSON.parse(stdout.join('')) as RunJson & { interrupted?: boolean };
    expect(stopped.interrupted).toBe(true);
    const planned = await namesOfThePlan(stopped.sample.plan.path);

    stdout = [];
    const second = withFakeOrgs({ target: { limits: DEVELOPER_EDITION, firstId: 500 } });
    expect(
      await run(
        argv('--fit', 'share', '--max-total', '60', '--yes', '--json', '--resume', stopped.journal),
      ),
    ).toBeUndefined();

    const taken = JSON.parse(stdout.join('')) as RunJson;
    expect(taken.result.status).toBe('success');
    expect(stderr.join('')).toContain(
      'sample: the run taken up goes on with the plan its journal names',
    );
    const written = [...first.target.creates, ...second.target.creates];
    expect(sorted(sentIds(written))).toEqual(sorted(planned));
  });

  it('takes up a run that wrote the plan of a dry run, by that plan, without --fit-plan', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json')),
    ).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    const planned = await namesOfThePlan(dry.plan.path);

    stdout = [];
    const flags = ['--fit', 'share', '--max-total', '60', '--yes', '--json'];
    const first = withFakeOrgs({ target: { limits: DEVELOPER_EDITION, interruptOn: 'Contact' } });
    expect(await run(argv(...flags, '--fit-plan', dry.plan.path))).toBe(130);
    const stopped = JSON.parse(stdout.join('')) as RunJson;

    stdout = [];
    const second = withFakeOrgs({ target: { limits: DEVELOPER_EDITION, firstId: 500 } });
    expect(await run(argv(...flags, '--resume', stopped.journal))).toBeUndefined();

    const taken = JSON.parse(stdout.join('')) as RunJson;
    expect(taken.result.status).toBe('success');
    expect(taken.sample.plan.sha256).toBe(dry.plan.sha256);
    const written = [...first.target.creates, ...second.target.creates];
    expect(sorted(sentIds(written))).toEqual(sorted(planned));
  });

  it('says again the plan of an earlier dry run with --fit-plan --dry-run, drawing nothing and moving nothing', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json')),
    ).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;

    stdout = [];
    stderr = [];
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(
        argv(
          '--fit',
          'share',
          '--max-total',
          '60',
          '--fit-plan',
          dry.plan.path,
          '--dry-run',
          '--json',
        ),
      ),
    ).toBeUndefined();

    const again = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    expect(again.plan).toEqual(dry.plan);
    expect(stderr.join('')).toContain('by a dry run, said again by this one (--fit-plan)');
    expect(stderr.join('')).not.toContain('sampling:');
    expect(dryRunPlans()).toEqual([dry.plan.path]);
  });

  it('is refused SAMPLE_PLAN_GONE, exit 2, when the plan of the run it takes up is gone, and SAMPLE_PLAN_MISMATCH without --fit share', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION, interruptOn: 'Contact' } });
    expect(await run(argv('--fit', 'share', '--max-total', '60', '--yes', '--json'))).toBe(130);
    const stopped = JSON.parse(stdout.join('')) as RunJson;

    // Taken up as a run of every record: refused before the plan is looked at.
    stdout = [];
    stderr = [];
    let orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--max-total', '60', '--yes', '--json', '--resume', stopped.journal)),
    ).toBe(2);
    expect((JSON.parse(stdout.join('')) as RefusedJson).refused.code).toBe('SAMPLE_PLAN_MISMATCH');
    expect(stderr.join('')).toContain('take it up with --fit share');
    expect(orgs.target.creates).toEqual([]);

    rmSync(stopped.sample.plan.path, { recursive: true, force: true });
    stdout = [];
    stderr = [];
    orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(
        argv('--fit', 'share', '--max-total', '60', '--yes', '--json', '--resume', stopped.journal),
      ),
    ).toBe(2);

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_PLAN_GONE');
    expect(answer.refused.message).toContain('is no longer on this machine');
    expect(answer.refused.message).toContain(`It was in ${stopped.sample.plan.path}.`);
    expect(orgs.target.creates).toEqual([]);
  });

  it('is refused SAMPLE_PLAN_MISMATCH, exit 2, when a run of every record is taken up with --fit share', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION, interruptOn: 'Contact' } });
    expect(await run(argv('--max-total', '400', '--yes', '--json'))).toBe(130);
    const stopped = JSON.parse(stdout.join('')) as RunJson;

    stdout = [];
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(
        argv(
          '--fit',
          'share',
          '--max-total',
          '400',
          '--yes',
          '--json',
          '--resume',
          stopped.journal,
        ),
      ),
    ).toBe(2);

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_PLAN_MISMATCH');
    expect(answer.refused.message).toContain('copied every record of the whole org, not a sample');
    expect(orgs.target.creates).toEqual([]);
  });

  it('is refused SAMPLE_STORAGE_UNREAD, exit 1, when the target would not say its storage and neither --fit-within nor --max-total is given', async () => {
    const unsaid = { DailyApiRequests: LIMITS.DailyApiRequests };
    let orgs = withFakeOrgs({ target: { limits: unsaid } });

    expect(await run(argv('--fit', 'share', '--dry-run', '--json'))).toBe(1);

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_STORAGE_UNREAD');
    expect(answer.refused.message).toContain('(--fit-within <MB>) or the most records');
    expect(dryRunPlans()).toEqual([]);

    // The records asked hold it: drawn, and said held to them.
    stdout = [];
    stderr = [];
    orgs = withFakeOrgs({ target: { limits: unsaid } });
    await run(argv('--fit', 'share', '--max-total', '40', '--dry-run', '--json'));
    expect(stderr.join('')).toContain(
      'held to 40 records (--max-total): TGT would not say its data storage',
    );
    expect(orgs.target.creates).toEqual([]);
  });

  it('is refused SAMPLE_CANNOT_FIT, exit 1, naming the heaviest, when the roots each object keeps alone take more than it may', async () => {
    const orgs = withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });

    expect(await run(argv('--fit', 'share', '--fit-within', '0.001', '--dry-run', '--json'))).toBe(
      1,
    );

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('SAMPLE_CANNOT_FIT');
    expect(answer.refused.message).toContain('No sample of the whole org fits');
    expect(answer.refused.message).toContain('the heaviest are');
    expect(answer.refused.message).toContain('--fit-floor 0');
    expect(orgs.target.creates).toEqual([]);
    expect(dryRunPlans()).toEqual([]);
  });

  it('draws the newest by their creation date with --fit-draw recent, not by the order of their ids', async () => {
    withFakeOrgs({ source: sourceOf(150, 50, true), target: { limits: DEVELOPER_EDITION } });

    expect(
      await run(
        argv('--fit', 'share', '--fit-draw', 'recent', '--max-total', '20', '--dry-run', '--json'),
      ),
    ).toBeUndefined();

    const sample = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    expect(sample.draw).toBe('recent');
    expect(stderr.join('')).toContain('(the newest by creation date)');
    // The accounts made last have the lowest ids here.
    const accounts = (await namesOfThePlan(sample.plan.path))['Account'] ?? [];
    expect(accounts.length).toBeGreaterThan(0);
    for (const name of accounts) expect(Number(name.split(' ')[1])).toBeLessThanOrEqual(20);
  });

  it('draws the same plan twice with the same seed, and another with another seed', async () => {
    const shaOf = async (...flags: string[]): Promise<string> => {
      stdout = [];
      withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
      expect(
        await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json', ...flags)),
      ).toBeUndefined();
      return (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample.plan.sha256;
    };

    const first = await shaOf();
    expect(await shaOf()).toBe(first);
    expect(await shaOf('--fit-seed', '5')).not.toBe(first);
  });

  it('sends the source no count by parent of an object whose ids its describe says the org does not aggregate', async () => {
    /** What the source sent of a count of contacts grouped by their account. */
    const counts = (source: SampleSourceOrg) =>
      source.sent.filter(({ soql }) => /COUNT\(Id\)/.test(soql) && / FROM Contact /.test(soql));
    // One child a record: the contacts of the accounts drawn are counted by account first.
    const flags = ['--fit', 'share', '--max-total', '60', '--fit-children', '1', '--dry-run'];
    const counted = sourceOf();
    withFakeOrgs({ source: counted, target: { limits: DEVELOPER_EDITION } });
    expect(await run(argv(...flags))).toBeUndefined();
    expect(counts(counted).length).toBeGreaterThan(0);

    // The org refuses the count, as a scratch org refused COUNT(Id) of feed items,
    // and its describe says so: the count is never sent.
    const refusing = sourceOf();
    refusing.uncountedIds.add('Contact');
    const contact = DESCRIBES['Contact'];
    const unaggregated = {
      ...DESCRIBES,
      Contact: {
        ...contact,
        fields: contact.fields.map((f) => (f.name === 'Id' ? { ...f, aggregatable: false } : f)),
      } as DescribeSObjectResult,
    };
    withFakeOrgs({
      source: refusing,
      sourceDescribes: unaggregated,
      target: { limits: DEVELOPER_EDITION },
    });
    expect(await run(argv(...flags))).toBeUndefined();
    expect(counts(refusing)).toEqual([]);
  });

  it('keeps room under each record for what a flow of the target still running creates, and fits fewer records', async () => {
    const keptOf = async (taskOnTicket: boolean) => {
      stdout = [];
      stderr = [];
      withFakeOrgs({
        source: sourceOf(0, 200),
        target: { limits: DEVELOPER_EDITION, taskOnTicket },
      });
      expect(
        await run(
          argv(
            '--fit',
            'share',
            '--fit-within',
            '0.1',
            '--accept-automation',
            '--dry-run',
            '--json',
          ),
        ),
      ).toBeUndefined();
      return (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;
    };

    const bare = await keptOf(false);
    const flowing = await keptOf(true);
    expect(stderr.join('')).toContain('Ticket task');
    // A ticket and the task the flow makes under it take twice what a ticket does.
    expect(bare.budget.limitedBy).toBe('within');
    expect(flowing.budget.limitedBy).toBe('within');
    expect(bare.rows).toBe(51);
    expect(flowing.rows).toBe(25);
  });

  // Run for real on a whole org into a Developer Edition, the sample counted
  // the 844 tasks a flow opens under its contacts, 1.65 MB: its line said
  // "about 3.6 MB of the 3.6 MB" and the gate "about 1.95 MB", and nothing
  // said where the rest went.
  it('says, in its line, its JSON and its question, the part of what it takes that a flow still running creates', async () => {
    const drawn = async (taskOnTicket: boolean) => {
      stdout = [];
      stderr = [];
      withFakeOrgs({
        source: sourceOf(0, 200),
        target: { limits: DEVELOPER_EDITION, taskOnTicket },
      });
      expect(
        await run(
          argv(
            '--fit',
            'share',
            '--fit-within',
            '0.1',
            '--accept-automation',
            '--dry-run',
            '--json',
          ),
        ),
      ).toBeUndefined();
      return {
        sample: (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample,
        said: stderr.join(''),
      };
    };

    const bare = await drawn(false);
    expect(bare.sample.budget).not.toHaveProperty('automationMB');
    expect(bare.said).not.toContain('for what its automation creates');

    const flowing = await drawn(true);
    // A task under each of the 25 tickets kept.
    expect(flowing.sample.rows).toBe(25);
    expect(flowing.sample.budget.automationMB).toBeCloseTo((25 * 2_048) / (1024 * 1024));
    expect(flowing.said).toMatch(/sample: .* MB for what its automation creates/);
    expect(flowing.said).toMatch(
      /write gate: 25 record\(s\) .*of it for what the target's automation creates under them/,
    );
  });

  // Run for real on a whole org into a Developer Edition with 5 MB left: the
  // gate counted 1 412 records, about 2.76 MB, and let them through, while a
  // flow no mute reaches opens a task under each of the 1 200 contacts, 2.34
  // MB more; and --fit share was never offered.
  it('refuses every record of the org once what a flow still running creates under them is counted past the storage, and offers --fit share', async () => {
    const dryRunOf = async (taskOnTicket: boolean) => {
      stdout = [];
      stderr = [];
      withFakeOrgs({
        source: sourceOf(200, 1_500),
        target: { limits: DEVELOPER_EDITION, taskOnTicket },
      });
      const code = await run(argv('--accept-automation', '--dry-run', '--json'));
      return {
        code,
        ...(JSON.parse(stdout.join('')) as {
          wholeOrg: { storage: { verdict: string; estimateMB: number; automationMB?: number } };
          wouldBeRefusedCodes?: string[];
        }),
      };
    };

    // 1 900 records, 3.7 MB of the 5 MB: they fit, a task under each ticket
    // aside.
    const quiet = await dryRunOf(false);
    expect(quiet.code).toBeUndefined();
    expect(quiet.wholeOrg.storage.verdict).toBe('fits');
    expect(quiet.wouldBeRefusedCodes ?? []).not.toContain('STORAGE_EXCEEDED');

    const flowing = await dryRunOf(true);
    expect(flowing.code).toBe(1);
    expect(flowing.wholeOrg.storage.verdict).toBe('exceeds');
    expect(flowing.wholeOrg.storage.automationMB).toBeCloseTo((1_500 * 2_048) / (1024 * 1024));
    expect(flowing.wouldBeRefusedCodes).toContain('STORAGE_EXCEEDED');
    const said = stderr.join('');
    expect(said).toContain("of it for what the target's automation creates under them");
    expect(said).toContain('copy a sample of the org that fits it (--fit share');
  });

  it('refuses a plan the target no longer has room for, nothing written: simulate again', async () => {
    withFakeOrgs({ target: { limits: DEVELOPER_EDITION } });
    expect(
      await run(argv('--fit', 'share', '--max-total', '60', '--dry-run', '--json')),
    ).toBeUndefined();
    const dry = (JSON.parse(stdout.join('')) as DryRunJson).wholeOrg.sample;

    stdout = [];
    const orgs = withFakeOrgs({
      target: { limits: { ...LIMITS, DataStorageMB: { Max: 5, Remaining: 0.6 } } },
    });
    expect(
      await run(
        argv('--fit', 'share', '--max-total', '60', '--fit-plan', dry.plan.path, '--yes', '--json'),
      ),
    ).toBe(1);

    const answer = JSON.parse(stdout.join('')) as RefusedJson;
    expect(answer.refused.code).toBe('STORAGE_EXCEEDED');
    expect(answer.refused.message).toContain('The sample was fitted to');
    expect(answer.refused.message).toContain('Simulate again');
    expect(orgs.target.creates).toEqual([]);
    expect(existsSync(dry.plan.path)).toBe(true);
  });
});
