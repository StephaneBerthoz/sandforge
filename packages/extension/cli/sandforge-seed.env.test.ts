import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({ objectsRead: [], objects: [], unread: [] }),
  })),
}));
// The id a run draws for itself, the same each time: what its output names.
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

import { makeConn } from './sfSession.js';
import { readRunFile } from '../src/modules/sync/SyncRunCreations.js';
import {
  ENV_RUN_ID_RE,
  main,
  parseArgs,
  readTemplateFile,
  runIdRefusal,
} from './sandforge-seed.js';

/*
 * The two lines an environment gives a seed: the template it converted from
 * its file, in a file of its own (`--template-file`), and the id it chose for
 * the run (`--run-id`). A seed run without them prints, writes and keeps
 * exactly what it did before they existed.
 */

/** Asset, as the fake org describes every object it is asked of: a name to fill. */
const ASSET = {
  name: 'Asset',
  createable: true,
  recordTypeInfos: [],
  fields: [
    { name: 'Id', type: 'id', createable: false, nillable: false, length: 18 },
    { name: 'Name', type: 'string', createable: true, nillable: false, length: 80 },
  ].map((f) => ({ referenceTo: [], defaultedOnCreate: false, picklistValues: [], ...f })),
};

/** Account, in an org with person accounts: a company's name, a person's, its record type. */
const ACCOUNT = {
  ...ASSET,
  name: 'Account',
  fields: [
    ...ASSET.fields,
    ...['LastName', 'RecordTypeId'].map((name) => ({
      name,
      type: name === 'RecordTypeId' ? 'reference' : 'string',
      createable: true,
      nillable: true,
      length: 80,
      referenceTo: [],
      defaultedOnCreate: false,
      picklistValues: [],
    })),
  ],
};

/** The org's person account record type, when it has person accounts. */
const PERSON_TYPE = '012000000000001AAA';

/**
 * A sandbox that takes every record it is sent through REST, runs nothing as
 * they are created and has room for them; `sent` keeps each call's records.
 * With `personTypes`, it has person accounts of those record types; with
 * `assetTypes`, Asset has those record types, as its describe lists them.
 */
function fakeOrg(personTypes: string[] = [], assetTypes: unknown[] = []) {
  let made = 0;
  const sent: Array<{ objectApiName: string; records: Array<Record<string, unknown>> }> = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const asset =
    assetTypes.length === 0
      ? ASSET
      : {
          ...ASSET,
          recordTypeInfos: assetTypes,
          fields: [...ASSET.fields, ...ACCOUNT.fields.filter((f) => f.name === 'RecordTypeId')],
        };
  const conn = {
    sobject: (objectApiName: string) => ({
      describe: async () => (objectApiName === 'Account' ? ACCOUNT : asset),
      create: async (records: Array<Record<string, unknown>>) => {
        sent.push({ objectApiName, records });
        return records.map(() => ({
          success: true,
          id: `02i${String(made++).padStart(12, '0')}AAA`,
        }));
      },
    }),
    describe: async (objectApiName: string) => (objectApiName === 'Account' ? ACCOUNT : asset),
    describeGlobal: async () => ({
      sobjects: [
        { name: 'Asset', createable: true },
        { name: 'Account', createable: true },
      ],
    }),
    query: async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true }]);
      }
      if (soql.includes('IsPersonType = true')) {
        return page(personTypes.map((Id) => ({ Id, DeveloperName: 'PersonAccount' })));
      }
      return page([]);
    },
    tooling: { query: async () => page([]) },
    request: async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      SingleEmail: { Max: 5_000, Remaining: 5_000 },
    }),
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  return { sent };
}

const LINE = [
  'node',
  'sandforge-seed.ts',
  '--target',
  'TGT',
  '--object',
  'Asset:3',
  '--locale',
  'en_US',
  '--seed',
  '7',
];

/** A template as the environment writes one for a resource of two assets. */
function templateJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'SFENV assets',
    description: '',
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Asset',
        recordCount: 2,
        fieldRules: [
          {
            fieldApiName: 'Name',
            fieldType: 'string',
            ruleType: 'static',
            config: { staticValue: 'SFENV asset' },
          },
        ],
        excludedFields: [],
        insertOrder: 0,
      },
    ],
    tags: [],
    ...overrides,
  };
}

let journal: string;
let journalBefore: string | undefined;
let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  journal = mkdtempSync(join(tmpdir(), 'sandforge-seed-env-journal-'));
  process.env['SANDFORGE_JOURNAL_DIR'] = journal;
  dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-env-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(journal, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Stop at `process.exit`, keeping its code. */
function stubExit(): () => number | undefined {
  let code: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`exit ${c}`);
  }) as never);
  return () => code;
}

/**
 * What a stream said, the journal folder written `<journal>` and the path
 * under it with `/`: on Windows the folder comes back with backslashes, and
 * doubled where the summary is JSON.
 */
const said = (lines: readonly string[]): string =>
  lines
    .join('')
    .split(JSON.stringify(journal).slice(1, -1))
    .join('<journal>')
    .split(journal)
    .join('<journal>')
    .replace(/<journal>[\\/\w.-]+/g, (path) => path.replace(/\\{1,2}/g, '/'));

describe('a seed run without the environment’s lines', () => {
  // Read off the command before --template-file and --run-id existed, the
  // clock stopped and the drawn id fixed: byte for byte what a run printed.
  const RUN_FILE = '<journal>/seed-runs/sandforge-seed-00000000-0000-4000-8000-000000000000.ndjson';
  const LOGGED = [
    'sandforge-seed  -> TGT',
    'seed: 7  (--seed 7 draws the same again)',
    'locale: en_US',
    '  Asset: Name',
    'data storage: about 0.01 MB to write, TGT has 150 MB left of 200 MB',
    'target automation: what TGT runs as these records are created',
    '  nothing runs on them: no flow, Apex trigger, process or workflow rule',
    'template: sandforge-seed (1 object(s))',
    '',
  ];
  const summary = (dryRun: boolean): Record<string, unknown> => ({
    tool: 'sandforge-seed',
    target: 'TGT',
    ...(dryRun ? {} : { targetOrgId: '00D000000000002AAA' }),
    dryRun,
    seed: 7,
    startedAt: '2026-10-01T09:00:00.000Z',
    finishedAt: '2026-10-01T09:00:00.000Z',
    emails: { checks: [] },
    // A dry run's gates, added for an environment to sum them: the 2 KB each
    // of the three assets takes, and the one REST call that writes them,
    // against what the target's `/limits` say — this org's list no daily
    // requests. A run's summary is as it was.
    ...(dryRun
      ? {
          storage: {
            bytes: 6_144,
            verdict: 'fits',
            estimateMB: 6_144 / (1024 * 1024),
            maxMB: 200,
            remainingMB: 150,
          },
          apiRequests: {
            verdict: 'unread',
            estimate: 1,
            unread: 'the limits the org answered list no DailyApiRequests',
          },
        }
      : {}),
    result: {
      templateId: 'cli-1790845200000',
      operationId: 'sandforge-seed-00000000-0000-4000-8000-000000000000',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Asset',
          recordsCreated: 3,
          recordsFailed: 0,
          createdIds: dryRun
            ? ['dry-0', 'dry-1', 'dry-2']
            : ['02i000000000000AAA', '02i000000000001AAA', '02i000000000002AAA'],
          errors: [],
        },
      ],
      totalRecordsCreated: 3,
      totalRecordsFailed: 0,
      duration: 0,
      timestamp: '2026-10-01T09:00:00.000Z',
    },
    ...(dryRun ? {} : { runFile: RUN_FILE }),
    elapsedMs: 0,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'));
    fakeOrg();
  });

  it('prints a run’s --json summary and lines as it did, and keeps its file as it did', async () => {
    await main([...LINE, '--json']);

    expect(said(stdout)).toBe(`${JSON.stringify(summary(false), null, 2)}\n`);
    expect(said(stderr)).toBe(
      [
        ...LOGGED,
        'executing… (REAL)',
        `run file: ${RUN_FILE} (--remove ${RUN_FILE} takes back what the run creates)`,
        '  Asset: 3 written, 0 refused',
        '',
      ].join('\n'),
    );
    const file = readFileSync(
      join(journal, 'seed-runs', 'sandforge-seed-00000000-0000-4000-8000-000000000000.ndjson'),
      'utf8',
    ).replace(/"writer":\{"pid":\d+,"hostStartedAt":"[^"]+"\}/, '"writer":"<this process>"');
    expect(file).toBe(
      [
        '{"run":{"runId":"sandforge-seed-00000000-0000-4000-8000-000000000000","configId":"sandforge-seed","configName":"sandforge-seed","sourceOrgId":"TGT","targetOrgId":"TGT","startedAt":"2026-10-01T09:00:00.000Z","targetOrganizationId":"00D000000000002AAA","answersNameJobs":true,"writer":"<this process>"}}',
        '{"sending":{"object":"Asset","rows":3,"at":"2026-10-01T09:00:00.000Z"}}',
        '{"object":"Asset","created":["02i000000000000AAA","02i000000000001AAA","02i000000000002AAA"],"at":"2026-10-01T09:00:00.000Z"}',
        '{"end":{"at":"2026-10-01T09:00:00.000Z","status":"success"}}',
        '',
      ].join('\n'),
    );
  });

  it('prints a dry run’s --json summary as it did with its gates added, its lines as they were, and keeps no file', async () => {
    await main([...LINE, '--dry-run', '--json']);

    expect(said(stdout)).toBe(`${JSON.stringify(summary(true), null, 2)}\n`);
    expect(said(stderr)).toBe(
      [...LOGGED, 'executing… (DRY-RUN)', '  [dry-run] Asset: 3 record(s) (REST)', ''].join('\n'),
    );
    expect(existsSync(join(journal, 'seed-runs'))).toBe(false);
  });

  it('prints a run’s lines as it did without --json', async () => {
    await main(LINE);

    expect(said(stderr)).toBe('');
    expect(said(stdout)).toBe(
      [
        ...LOGGED,
        'executing… (REAL)',
        `run file: ${RUN_FILE} (--remove ${RUN_FILE} takes back what the run creates)`,
        '  Asset: 3 written, 0 refused',
        '',
        'status:  success',
        'created: 3',
        '  Asset: 3 created, 0 failed',
        'seed: 7',
        '',
        `created 3 record(s) in TGT: --remove ${RUN_FILE} takes them back`,
        '',
        'done in 0ms',
        '',
      ].join('\n'),
    );
  });

  it('prints a dry run’s lines as it did without --json', async () => {
    await main([...LINE, '--dry-run']);

    expect(said(stderr)).toBe('');
    expect(said(stdout)).toBe(
      [
        ...LOGGED,
        'executing… (DRY-RUN)',
        '  [dry-run] Asset: 3 record(s) (REST)',
        '',
        'status:  success',
        'created: 3',
        '  Asset: 3 created, 0 failed',
        'seed: 7',
        '',
        'done in 0ms',
        '',
      ].join('\n'),
    );
  });
});

describe('--template-file', () => {
  it('runs the template a file holds, its objects and rules as the file says them', async () => {
    const { sent } = fakeOrg();
    const file = join(dir, 'assets.json');
    writeFileSync(file, JSON.stringify(templateJson({ id: 'env-template-1' })));

    await main([
      'node',
      'sandforge-seed.ts',
      '--target',
      'TGT',
      '--template-file',
      file,
      '--seed',
      '7',
      '--locale',
      'en_US',
      '--batch-size',
      '1',
      '--json',
    ]);

    // No batch size in the file: the line's, a record a call.
    expect(sent.map((call) => call.records.length)).toEqual([1, 1]);
    expect(sent.flatMap((call) => call.records.map((record) => record.Name))).toEqual([
      'SFENV asset',
      'SFENV asset',
    ]);
    const answer = JSON.parse(stdout.join('')) as {
      result: { templateId: string; status: string; totalRecordsCreated: number };
    };
    expect(answer.result).toMatchObject({
      templateId: 'env-template-1',
      status: 'success',
      totalRecordsCreated: 2,
    });
    expect(stderr.join('')).toContain('template: SFENV assets (1 object(s))');
  });

  it('refuses a file the schema refuses, with each issue and where, before any org is reached', async () => {
    fakeOrg();
    vi.mocked(makeConn).mockClear();
    const file = join(dir, 'bad.json');
    const bad = templateJson();
    delete bad.name;
    (bad.objects as Array<Record<string, unknown>>)[0].recordCount = 0;
    writeFileSync(file, JSON.stringify(bad));
    const code = stubExit();

    await expect(
      main(['node', 'sandforge-seed.ts', '--target', 'TGT', '--template-file', file]),
    ).rejects.toThrow('exit 2');

    expect(code()).toBe(2);
    expect(makeConn).not.toHaveBeenCalled();
    const refusal = stderr.join('');
    expect(refusal).toContain(
      `--template-file ${file} is not a seed template the panel would run:`,
    );
    expect(refusal).toMatch(/\n {2}name: /);
    expect(refusal).toMatch(/\n {2}objects\.0\.recordCount: /);
  });

  it('refuses a file that is not JSON, and one it cannot read', () => {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'objects: Account');

    expect(readTemplateFile(file, 200)).toEqual({
      refusal: expect.stringMatching(/^--template-file .* is not JSON: /),
    });
    expect(readTemplateFile(join(dir, 'missing.json'), 200)).toEqual({
      refusal: expect.stringMatching(/^--template-file .* cannot be read: /),
    });
  });

  it('keeps a batch size the file gives, and fills an id, a version and dates it leaves out', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'));
    const file = join(dir, 'assets.json');
    const given = templateJson();
    (given.objects as Array<Record<string, unknown>>)[0].batchSize = 50;
    writeFileSync(file, JSON.stringify(given));

    const read = readTemplateFile(file, 200);

    expect(read).toEqual({
      template: expect.objectContaining({
        id: 'cli-1790845200000',
        version: 1,
        createdAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-01T09:00:00.000Z',
        objects: [expect.objectContaining({ objectApiName: 'Asset', batchSize: 50 })],
      }),
    });
  });

  it.each([
    ['--template', 'prebuilt-minimal-demo'],
    ['--object', 'Asset:2'],
    ['--relation', 'Contact.AccountId=Account'],
  ])('goes with no %s, the file saying what to write', (flag, value) => {
    const code = stubExit();

    expect(() =>
      parseArgs([
        'node',
        'sandforge-seed.ts',
        '--target',
        'TGT',
        '--template-file',
        'assets.json',
        flag,
        value,
      ]),
    ).toThrow('exit 2');

    expect(code()).toBe(2);
    expect(stderr.join('')).toContain('Give --template-file alone');
  });

  it('writes the accounts it gives a person account record type as person accounts, as the panel does', async () => {
    const { sent } = fakeOrg([PERSON_TYPE]);
    const file = join(dir, 'people.json');
    writeFileSync(
      file,
      JSON.stringify(
        templateJson({
          objects: [
            {
              objectApiName: 'Account',
              recordCount: 1,
              fieldRules: [
                { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Co' } },
                { fieldApiName: 'LastName', ruleType: 'static', config: { staticValue: 'Doe' } },
                {
                  fieldApiName: 'RecordTypeId',
                  fieldType: 'reference',
                  ruleType: 'static',
                  config: { staticValue: PERSON_TYPE },
                },
              ],
              excludedFields: [],
              insertOrder: 0,
            },
          ],
        }),
      ),
    );

    await main([
      'node',
      'sandforge-seed.ts',
      '--target',
      'TGT',
      '--template-file',
      file,
      '--seed',
      '7',
      '--locale',
      'en_US',
      '--json',
    ]);

    const [account] = sent.flatMap((call) => call.records);
    expect(account).toMatchObject({ LastName: 'Doe', RecordTypeId: PERSON_TYPE });
    expect(account).not.toHaveProperty('Name');
    const answer = JSON.parse(stdout.join('')) as { notes?: string[] };
    expect(answer.notes).toEqual([
      expect.stringContaining('Account: the template gives it person account record types'),
    ]);
  });
});

describe('--template-file with parents named by id', () => {
  /** Accounts another resource created, by the ids an environment hands over. */
  const ACCOUNTS = ['001000000000001AAA', '001000000000002AAA'];

  /**
   * The fake org, its assets taking an account, its accounts' ids starting
   * 001, and holding of the accounts named those in `held`.
   */
  function orgHolding(held: readonly string[]) {
    const org = fakeOrg();
    const conn = vi.mocked(makeConn)({} as never) as unknown as {
      query: (soql: string) => Promise<unknown>;
      describe: (objectApiName: string) => Promise<unknown>;
      sobject: (objectApiName: string) => Record<string, unknown>;
    };
    const assetWithAccount = {
      ...ASSET,
      keyPrefix: '02i',
      fields: [
        ...ASSET.fields,
        {
          name: 'AccountId',
          type: 'reference',
          createable: true,
          nillable: true,
          length: 18,
          referenceTo: ['Account'],
          defaultedOnCreate: false,
          picklistValues: [],
        },
      ],
    };
    const described = (objectApiName: string) =>
      objectApiName === 'Account' ? { ...ACCOUNT, keyPrefix: '001' } : assetWithAccount;
    const asked: string[] = [];
    const query = conn.query;
    conn.query = async (soql: string) => {
      if (soql.startsWith('SELECT Id FROM Account WHERE Id IN')) {
        asked.push(soql);
        return { totalSize: held.length, done: true, records: held.map((Id) => ({ Id })) };
      }
      return query(soql);
    };
    conn.describe = async (objectApiName: string) => described(objectApiName);
    const sobject = conn.sobject;
    conn.sobject = (objectApiName: string) => ({
      ...sobject(objectApiName),
      describe: async () => described(objectApiName),
    });
    return { ...org, asked };
  }

  /** Two assets, one under each account named. */
  function assetsUnderAccounts(): string {
    const file = join(dir, 'assets-under-accounts.json');
    writeFileSync(
      file,
      JSON.stringify(
        templateJson({
          relations: [
            {
              childObject: 'Asset',
              lookupField: 'AccountId',
              parentObject: 'Account',
              parents: { kind: 'records', ids: ACCOUNTS },
              distribution: { mode: 'perParent', count: 1 },
            },
          ],
        }),
      ),
    );
    return file;
  }

  const line = (file: string): string[] => [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--template-file',
    file,
    '--seed',
    '7',
    '--locale',
    'en_US',
    '--json',
  ];

  it('places each asset under an account it names, once the org holds them', async () => {
    const { sent, asked } = orgHolding(ACCOUNTS);

    await main(line(assetsUnderAccounts()));

    expect(asked).toEqual([`SELECT Id FROM Account WHERE Id IN ('${ACCOUNTS.join("', '")}')`]);
    expect(sent.flatMap((call) => call.records.map((record) => record.AccountId))).toEqual(
      ACCOUNTS,
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('refuses the run before its first write when an account it names is no longer in the org, naming it', async () => {
    const { sent } = orgHolding([ACCOUNTS[0]]);

    await main(line(assetsUnderAccounts()));

    expect(sent).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(stdout.join('')).toContain(
      `1 of the 2 Account record(s) the relation on Asset.AccountId names are no longer in the org: ${ACCOUNTS[1]}.`,
    );
  });
});

describe('--template-file with rows placed by key', () => {
  /** The fake org, its assets taking an account. */
  function orgWithAssetAccounts() {
    const org = fakeOrg();
    const conn = vi.mocked(makeConn)({} as never) as unknown as {
      describe: (objectApiName: string) => Promise<unknown>;
      sobject: (objectApiName: string) => Record<string, unknown>;
    };
    const assetWithAccount = {
      ...ASSET,
      fields: [
        ...ASSET.fields,
        {
          name: 'AccountId',
          type: 'reference',
          createable: true,
          nillable: true,
          length: 18,
          referenceTo: ['Account'],
          defaultedOnCreate: false,
          picklistValues: [],
        },
      ],
    };
    const described = (objectApiName: string) =>
      objectApiName === 'Account' ? ACCOUNT : assetWithAccount;
    conn.describe = async (objectApiName: string) => described(objectApiName);
    const sobject = conn.sobject;
    conn.sobject = (objectApiName: string) => ({
      ...sobject(objectApiName),
      describe: async () => described(objectApiName),
    });
    return org;
  }

  /** Two accounts, and three assets each under the account its row names. */
  function keyedFile(): string {
    const file = join(dir, 'keyed.json');
    const object = (objectApiName: string, insertOrder: number, rows: unknown[]) => ({
      objectApiName,
      recordCount: rows.length,
      fieldRules: [],
      excludedFields: [],
      insertOrder,
      rows,
    });
    writeFileSync(
      file,
      JSON.stringify({
        name: 'Keyed assets',
        strategy: 'template',
        objects: [
          object('Account', 0, [
            { key: 'a1', values: { Name: 'Acme' } },
            { key: 'a2', values: { Name: 'Globex' } },
          ]),
          object('Asset', 1, [
            { key: 'x1', parentKey: 'a1', values: { Name: 'Router' } },
            { key: 'x2', parentKey: 'a2', values: { Name: 'Modem' } },
            { key: 'x3', parentKey: 'a2', values: { Name: 'Box' } },
          ]),
        ],
        relations: [
          {
            childObject: 'Asset',
            lookupField: 'AccountId',
            parentObject: 'Account',
            parents: { kind: 'generated' },
            distribution: { mode: 'byKey' },
          },
        ],
      }),
    );
    return file;
  }

  const line = (file: string, ...more: string[]): string[] => [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--template-file',
    file,
    '--seed',
    '7',
    '--json',
    ...more,
  ];

  /** What each object of a run's --json summary wrote and failed. */
  const counts = (): Array<[string, number, number]> =>
    (
      JSON.parse(stdout.join('')) as {
        result: {
          objectResults: Array<{
            objectApiName: string;
            recordsCreated: number;
            recordsFailed: number;
          }>;
        };
      }
    ).result.objectResults.map((r) => [r.objectApiName, r.recordsCreated, r.recordsFailed]);

  it('writes each asset under the account its row names', async () => {
    const { sent } = orgWithAssetAccounts();

    await main(line(keyedFile()));

    // The fake org numbers its ids in the order it creates them: the accounts first.
    const [accounts, assets] = sent;
    const accountOf = (id: unknown) => accounts.records[Number(String(id).slice(3, 15))]?.Name;
    expect(accounts.objectApiName).toBe('Account');
    expect(assets.records.map((r) => [r.Name, accountOf(r.AccountId)])).toEqual([
      ['Router', 'Acme'],
      ['Modem', 'Globex'],
      ['Box', 'Globex'],
    ]);
    expect(counts()).toEqual([
      ['Account', 2, 0],
      ['Asset', 3, 0],
    ]);
  });

  it('plans in a dry run every row the run writes', async () => {
    const { sent } = orgWithAssetAccounts();

    await main(line(keyedFile(), '--dry-run'));

    expect(sent).toEqual([]);
    expect(counts()).toEqual([
      ['Account', 2, 0],
      ['Asset', 3, 0],
    ]);
  });
});

describe('--record-type with --template-file', () => {
  /** Asset's record types in the fake org: two open to the user, one inactive. */
  const ASSET_TYPES = [
    { recordTypeId: '012000000000010AAA', developerName: 'Hardware', available: true },
    { recordTypeId: '012000000000011AAA', developerName: 'Software', available: true },
    { recordTypeId: '012000000000012AAA', developerName: 'Legacy', available: true, active: false },
  ];
  const line = (file: string, ...more: string[]): string[] => [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--template-file',
    file,
    '--seed',
    '7',
    '--locale',
    'en_US',
    ...more,
    '--json',
  ];

  it('gives a template file’s object the record types it names, by their Ids in the org', async () => {
    const { sent } = fakeOrg([], ASSET_TYPES);
    const file = join(dir, 'assets.json');
    writeFileSync(file, JSON.stringify(templateJson()));

    await main(line(file, '--record-type', 'Asset=Hardware'));

    expect(sent.flatMap((call) => call.records.map((record) => record.RecordTypeId))).toEqual([
      '012000000000010AAA',
      '012000000000010AAA',
    ]);
    stdout.length = 0;
    sent.length = 0;

    await main(line(file, '--record-type', 'Asset=Hardware,Software'));

    for (const id of sent.flatMap((call) => call.records.map((record) => record.RecordTypeId))) {
      expect(['012000000000010AAA', '012000000000011AAA']).toContain(id);
    }
  });

  it('refuses a record type the object has not open, naming those it has, and writes nothing', async () => {
    const { sent } = fakeOrg([], ASSET_TYPES);
    const file = join(dir, 'assets.json');
    writeFileSync(file, JSON.stringify(templateJson()));
    const code = stubExit();

    await expect(main(line(file, '--record-type', 'Asset=Legacy'))).rejects.toThrow('exit 2');

    expect(code()).toBe(2);
    expect(stderr.join('')).toContain(
      '--record-type Asset=Legacy: record type Legacy is inactive. Open to them: Hardware, Software.',
    );
    expect(sent).toEqual([]);
  });

  it('refuses an object the file does not write, and one it types already, before any org is reached', async () => {
    fakeOrg([], ASSET_TYPES);
    vi.mocked(makeConn).mockClear();
    const file = join(dir, 'assets.json');
    writeFileSync(file, JSON.stringify(templateJson()));
    const code = stubExit();

    await expect(main(line(file, '--record-type', 'Contact=Customer'))).rejects.toThrow('exit 2');
    expect(stderr.join('')).toContain(
      '--record-type Contact: the template file writes no Contact; it writes Asset.',
    );

    const typed = templateJson();
    (
      (typed.objects as Array<Record<string, unknown>>)[0].fieldRules as Array<
        Record<string, unknown>
      >
    ).push({
      fieldApiName: 'RecordTypeId',
      fieldType: 'reference',
      ruleType: 'static',
      config: { staticValue: '012000000000011AAA' },
    });
    writeFileSync(file, JSON.stringify(typed));
    await expect(main(line(file, '--record-type', 'Asset=Hardware'))).rejects.toThrow('exit 2');

    expect(code()).toBe(2);
    expect(stderr.join('')).toContain(
      '--record-type Asset: the template file gives Asset its record type already, by a ' +
        'RecordTypeId rule: give it in one place.',
    );
    expect(makeConn).not.toHaveBeenCalled();
  });
});

describe('--run-id', () => {
  const RUN_ID = 'env-case-flow-accounts-1-6f1c2b0a-3d4e-4f50-8a6b-7c8d9e0f1a2b';

  it('names the run, its file and its summary’s run by the id the environment chose', async () => {
    fakeOrg();

    await main([...LINE, '--run-id', RUN_ID, '--json']);

    const answer = JSON.parse(stdout.join('')) as {
      result: { operationId: string };
      runFile: string;
    };
    expect(answer.result.operationId).toBe(RUN_ID);
    expect(answer.runFile).toBe(join(journal, 'seed-runs', `${RUN_ID}.ndjson`));
    expect(readRunFile(readFileSync(answer.runFile, 'utf8'))?.runId).toBe(RUN_ID);
  });

  it('refuses an id a run keeps already, before any org is reached, and leaves its file as it was', async () => {
    fakeOrg();
    await main([...LINE, '--run-id', RUN_ID, '--json']);
    const file = join(journal, 'seed-runs', `${RUN_ID}.ndjson`);
    const before = readFileSync(file, 'utf8');
    vi.mocked(makeConn).mockClear();
    const code = stubExit();

    await expect(main([...LINE, '--run-id', RUN_ID, '--json'])).rejects.toThrow('exit 2');

    expect(code()).toBe(2);
    expect(makeConn).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain(`--run-id ${RUN_ID}: a run of that id is kept already`);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(runIdRefusal('env-never-run', journal)).toBeUndefined();
  });

  it.each([
    'sandforge-seed-1',
    'env-',
    'env-Upper',
    'env-a/b',
    'env-a_b',
    `env-${'a'.repeat(197)}`,
  ])('refuses %s, which is no environment’s id, before any org is reached', (runId) => {
    const code = stubExit();

    expect(() => parseArgs([...LINE, '--run-id', runId])).toThrow('exit 2');

    expect(code()).toBe(2);
    expect(stderr.join('')).toContain('--run-id takes "env-"');
  });

  it('takes an id of 200 characters at most', () => {
    expect(ENV_RUN_ID_RE.test(`env-${'a'.repeat(196)}`)).toBe(true);
    expect(ENV_RUN_ID_RE.test(RUN_ID)).toBe(true);
  });
});
