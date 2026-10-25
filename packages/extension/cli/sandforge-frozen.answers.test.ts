import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import type { Connection } from 'jsforce';
import type { FrozenLoadPlanInfo } from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({
    alias,
    username: 'someone@example.invalid',
    instanceUrl: 'https://target.example.invalid',
    accessToken: 'token',
  })),
  makeConn: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { makeConn } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { SasReferenceIdMappingStore } from '../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import { FrozenDatasetLoader } from '../src/modules/frozendataset/FrozenDatasetLoader.js';
import { frozenDatasetDigest } from '../src/modules/frozendataset/datasetDigest.js';
import { frozenAnswer, main } from './sandforge-frozen.js';

/*
 * What an environment reads of each step's --json answer — the dataset's
 * digest, per object what the step counted, the mapping file, verify's
 * verdict per object — each held to a schema, as the environment's reader
 * holds it.
 */

/** The target, a sandbox, as its `Organization` record answers. */
const ORG_ID = '00D000000000009AAA';

const count = z.number().int().nonnegative();
const name = z.string().min(1);
const datasetSchema = z
  .object({ dir: name, digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), version: name })
  .strict();
const answerBase = {
  tool: z.literal('sandforge-frozen'),
  posted: z.array(z.object({ type: name }).loose()),
};
const verdictSchema = z
  .object({
    status: z.enum(['PASSED', 'PARTIAL', 'FAILED', 'UNSTABLE']),
    objects: z
      .array(
        z
          .object({
            objectApiName: name,
            verdict: z.enum(['PASSED', 'FAILED']),
            expected: count,
            found: count,
            notLoaded: count,
            orphans: count,
            missingKeys: count,
            personContactsUnlinked: count.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const extractAnswer = z
  .object({
    ...answerBase,
    step: z.literal('extract'),
    dataset: datasetSchema,
    objects: z.array(z.object({ objectApiName: name, records: count }).strict()).min(1),
  })
  .strict();
const loadAnswer = z
  .object({
    ...answerBase,
    step: z.literal('load'),
    dataset: datasetSchema,
    mapping: name,
    objects: z
      .array(
        z
          .object({
            objectApiName: name,
            fromFiles: count,
            inserted: count,
            reused: count,
            duplicates: count,
            failed: count,
          })
          .strict(),
      )
      .min(1),
    verdict: verdictSchema,
  })
  .strict();
const dryRunAnswer = z
  .object({
    ...answerBase,
    step: z.literal('load'),
    dataset: datasetSchema,
    mapping: name,
    objects: z
      .array(
        z
          .object({
            objectApiName: name,
            fromFiles: count,
            toInsert: count,
            toLink: count,
            notSent: count,
            toPurge: count,
            toDeactivate: count,
          })
          .strict(),
      )
      .min(1),
    refusals: z.array(name).optional(),
  })
  .strict();
const verifyAnswer = z
  .object({
    ...answerBase,
    step: z.literal('verify'),
    dataset: datasetSchema,
    mapping: name,
    verdict: verdictSchema,
  })
  .strict();
const removeAnswer = z
  .object({
    ...answerBase,
    step: z.literal('remove'),
    mapping: name,
    status: z.enum(['success', 'partial', 'failure', 'cancelled']),
    objects: z.array(
      z
        .object({
          objectApiName: name,
          planned: count,
          deleted: count,
          alreadyGone: count,
          keptChanged: count,
          keptDependents: count,
          refused: count,
          notReached: count,
          notVisible: count,
        })
        .strict(),
    ),
  })
  .strict();
const previewAnswer = z
  .object({
    ...answerBase,
    step: z.literal('remove'),
    preview: z.literal(true),
    mapping: name,
    objects: z.array(
      z
        .object({
          objectApiName: name,
          planned: count,
          toDelete: count,
          alreadyGone: count,
          changedSince: count,
          keptChanged: count,
          undeletable: count,
          notVisible: count,
          unread: count,
        })
        .strict(),
    ),
    refusals: z.array(name).optional(),
    ended: z.literal(true).optional(),
  })
  .strict();

let sasDir: string;
let datasetDir: string;
let configPath: string;
let printed: string[];

/** A dataset frozen into `dir`: two accounts and a contact. */
function freeze(dir: string): void {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: '1.4.0',
      status: 'frozen',
      frozenAt: '2026-10-20T08:00:00.000Z',
      source: { orgId: '00D000000000001AAA', decisionDate: '2026-10-20T07:00:00.000Z' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: { budgetMax: 2500, measured: { Account: 2, Contact: 1 }, measuredAt: 'x' },
      controls: {
        nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: 'x' },
        dryRunLoad: null,
        author: 'qa',
        date: 'x',
      },
    }),
  );
  const data = (objectApiName: string, ids: string[]) =>
    JSON.stringify({
      objectApiName,
      records: ids.map((referenceId) => ({ referenceId, fields: { Name: referenceId } })),
    });
  writeFileSync(join(dir, 'data', 'Account.json'), data('Account', ['Account-1', 'Account-2']));
  writeFileSync(join(dir, 'data', 'Contact.json'), data('Contact', ['Contact-1']));
}

beforeEach(() => {
  sasDir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-answers-'));
  datasetDir = join(sasDir, 'dataset');
  freeze(datasetDir);
  configPath = join(sasDir, 'frozen.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      rootObject: 'Account',
      axes: [
        {
          name: 'account',
          label: 'Account',
          filterField: 'Name',
          valuesSoql: 'SELECT Name axisValue FROM Account GROUP BY Name',
        },
      ],
      edgeCases: [],
      budgetMaxRecords: 2500,
      candidatesPerCombination: 1,
      sasDir,
    }),
  );
  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    printed.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(sasDir, { recursive: true, force: true });
});

describe('the --json answer of each step, as an environment reads it', () => {
  const context = () => ({ datasetDir, sasDir, targetOrgId: ORG_ID });
  const verdict = {
    status: 'failed',
    checks: [],
    attempts: 2,
    measuredAt: '2026-10-21T09:00:00.000Z',
    objects: [
      {
        objectApiName: 'Account',
        status: 'passed',
        expected: 2,
        found: 2,
        notLoaded: 0,
        orphans: 0,
        missingKeys: 0,
      },
      {
        objectApiName: 'Contact',
        status: 'failed',
        expected: 1,
        found: 0,
        notLoaded: 0,
        orphans: 0,
        missingKeys: 0,
      },
    ],
  };

  it('gives an extraction the dataset it froze, its digest and version, and its records per object', async () => {
    const answer = await frozenAnswer(
      'extract',
      [
        {
          type: 'frozen:extract:response',
          payload: {
            datasetDir,
            recordCount: 3,
            manifest: {
              version: '1.4.0',
              volumetry: { measured: { Account: 2, Contact: 1, Case: 0 } },
            },
          },
        },
      ],
      context(),
    );

    const read = extractAnswer.parse(answer);
    expect(read.dataset).toEqual({
      dir: datasetDir,
      digest: await frozenDatasetDigest(datasetDir),
      version: '1.4.0',
    });
    expect(read.objects).toEqual([
      { objectApiName: 'Account', records: 2 },
      { objectApiName: 'Contact', records: 1 },
    ]);
  });

  it('gives a load its dataset, the mapping it wrote, its counts per object and the verdict per object of the verification it chains', async () => {
    const mappingPath = join(sasDir, 'referenceid-mapping.org.json');
    const answer = await frozenAnswer(
      'load',
      [
        {
          type: 'frozen:load:response',
          payload: {
            report: {
              status: 'completed',
              mappingPath,
              perObject: [
                {
                  objectApiName: 'Account',
                  fromFiles: 2,
                  inserted: 2,
                  reused: 0,
                  skippedDuplicates: [],
                  failed: [],
                },
              ],
            },
          },
        },
        { type: 'frozen:verify:result', payload: { verdict } },
      ],
      context(),
    );

    const read = loadAnswer.parse(answer);
    expect(read.mapping).toBe(mappingPath);
    expect(read.verdict.objects.map((o) => [o.objectApiName, o.verdict])).toEqual([
      ['Account', 'PASSED'],
      ['Contact', 'FAILED'],
    ]);
    expect(read.verdict.status).toBe('FAILED');
  });

  it('gives a dry run of a load the counts it would write per object, the mapping it would write, and what it would be refused for', async () => {
    const answer = await frozenAnswer(
      'load',
      [
        {
          type: 'frozen:load:preview:response',
          payload: {
            plan: {
              perObject: [
                {
                  objectApiName: 'Account',
                  fromFiles: 2,
                  toInsert: 1,
                  reusedByKeys: 1,
                  reusedFromCatalog: 0,
                  fieldsDropped: 0,
                  picklistsRewritten: 0,
                  notSent: 0,
                  toPurge: 0,
                  toDeactivate: 0,
                },
              ],
            },
          },
        },
      ],
      { ...context(), refusals: ['This load would insert 1 record(s), more than the 0 it may'] },
    );

    const read = dryRunAnswer.parse(answer);
    expect(read.objects[0]).toMatchObject({ toInsert: 1, toLink: 1 });
    expect(read.mapping).toBe(join(sasDir, `referenceid-mapping.${ORG_ID}.json`));
    expect(read.refusals).toHaveLength(1);
  });

  it('gives a verification the dataset of the load it verified, the mapping and its verdict per object', async () => {
    const answer = await frozenAnswer(
      'verify',
      [
        {
          type: 'frozen:verify:result',
          payload: { verdict: { ...verdict, manifestPath: join(datasetDir, 'manifest.json') } },
        },
      ],
      { ...context(), datasetDir: join(sasDir, 'configured-elsewhere') },
    );

    const read = verifyAnswer.parse(answer);
    expect(read.dataset.dir).toBe(datasetDir);
    expect(read.dataset.digest).toBe(await frozenDatasetDigest(datasetDir));
  });

  it('gives a removal the mapping it took its records from, how it ended and what it did per object', async () => {
    const answer = await frozenAnswer(
      'remove',
      [
        {
          type: 'frozen:remove:response',
          payload: {
            result: {
              status: 'partial',
              includeChanged: false,
              finishedAt: 'x',
              objects: [
                {
                  objectApiName: 'Contact',
                  planned: 1,
                  deleted: 0,
                  alreadyGone: 0,
                  keptChanged: 1,
                  keptDependents: 0,
                  refused: 0,
                  heldBy: [],
                  unchecked: [],
                  reasons: [],
                },
              ],
            },
          },
        },
      ],
      context(),
    );

    const read = removeAnswer.parse(answer);
    expect(read.objects[0]).toMatchObject({ keptChanged: 1, notReached: 0, notVisible: 0 });
  });
});

/** One page of a query answer. */
const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

type Row = Record<string, unknown> & { Id: string };

/**
 * The target: a sandbox holding the account and the contact a load created;
 * every write it is sent is kept.
 */
function targetOrg(contactModified = '2026-10-20T10:02:00.000+0000') {
  const rows = new Map<string, Row[]>([
    [
      'Account',
      [
        {
          Id: '001000000000001AAA',
          CreatedDate: '2026-10-20T10:01:00.000+0000',
          LastModifiedDate: '2026-10-20T10:01:00.000+0000',
        },
      ],
    ],
    [
      'Contact',
      [
        {
          Id: '003000000000001AAA',
          CreatedDate: '2026-10-20T10:02:00.000+0000',
          LastModifiedDate: contactModified,
        },
      ],
    ],
  ]);
  const writes: string[] = [];
  const conn = {
    query: vi.fn(async (soql: string) => {
      if (soql.includes('IsSandbox')) return page([{ Id: ORG_ID, IsSandbox: true }]);
      if (soql === 'SELECT Id FROM Organization') return page([{ Id: ORG_ID }]);
      const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
      if (!match) return page([]);
      const [, columns, object, field, list] = match;
      const wanted = new Set(list.split(', ').map((q) => q.slice(1, -1)));
      return page(
        (rows.get(object) ?? [])
          .filter((row) => wanted.has(String(row[field])))
          .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]]))),
      );
    }),
    queryMore: vi.fn(),
    describe: vi.fn(async (object: string) => ({
      name: object,
      deletable: true,
      fields: [],
      childRelationships: [],
    })),
    describeGlobal: vi.fn(async () => ({ sobjects: [] })),
    soap: {
      getServerTimestamp: vi.fn(async () => ({ timestamp: new Date().toISOString() })),
      getUserInfo: vi.fn(async () => ({ userId: '005000000000001AAA' })),
    },
    sobject: (object: string) => ({
      destroy: vi.fn(async () => {
        writes.push(`destroy ${object}`);
        return [];
      }),
      update: vi.fn(async () => {
        writes.push(`update ${object}`);
        return [];
      }),
      create: vi.fn(async () => {
        writes.push(`create ${object}`);
        return [];
      }),
    }),
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  return { writes };
}

/** A load into the target that created the account and the contact. */
async function loaded(): Promise<void> {
  await new SasReferenceIdMappingStore(sasDir, {
    orgId: ORG_ID,
    organizationId: ORG_ID,
    now: () => new Date('2026-10-20T10:05:00.000Z'),
  }).persist(
    new Map([
      ['Account-1', '001000000000001AAA'],
      ['Contact-1', '003000000000001AAA'],
    ]),
    {
      created: [
        { objectApiName: 'Account', referenceIds: ['Account-1'] },
        { objectApiName: 'Contact', referenceIds: ['Contact-1'] },
      ],
      startedAt: new Date('2026-10-20T10:00:00.000Z'),
      writtenBetween: { first: '2026-10-20T10:01:00.000Z', last: '2026-10-20T10:04:00.000Z' },
    },
  );
}

const argv = (...args: string[]): string[] => ['node', 'sandforge-frozen.ts', ...args];

describe('sandforge-frozen remove --preview', () => {
  it('says what the removal would do, per object, deletes nothing, asks nothing and ends as done', async () => {
    const { writes } = targetOrg();
    await loaded();

    // No --yes, and no terminal: a question would have stopped it, exit 2.
    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--preview', '--json'));

    expect(writes).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    const read = previewAnswer.parse(JSON.parse(printed.join('')));
    expect(read.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', planned: 1, toDelete: 1 }),
      expect.objectContaining({ objectApiName: 'Account', planned: 1, toDelete: 1 }),
    ]);
    expect(read.mapping).toBe(join(sasDir, `referenceid-mapping.${ORG_ID}.json`));
    expect(read.refusals).toBeUndefined();
  });

  it('says without --json what it would delete and keep, in words', async () => {
    targetOrg('2026-10-20T11:00:00.000+0000');
    await loaded();

    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--preview'));

    const said = printed.join('');
    expect(said).toContain('preview: what a removal would do; nothing was deleted');
    expect(said).toContain('  Contact: 1 kept, changed since the load of 1');
    expect(said).toContain('  Account: 1 to delete of 1');
  });
});

describe('sandforge-frozen load --reload, a replace', () => {
  it('is refused before anything is written when the removal of the load before would keep a record changed since: exit 1', async () => {
    const { writes } = targetOrg('2026-10-20T11:00:00.000+0000');
    await loaded();

    await main(
      argv('load', '--config', configPath, '--target', 'TGT', '--reload', '--yes', '--json'),
    );

    expect(writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    const answer = JSON.parse(printed.join('')) as {
      posted: Array<{ type: string; payload: { code?: string } }>;
    };
    expect(answer.posted.find((m) => m.type === 'frozen:load:error')?.payload.code).toBe(
      'REPLACE_LEAVES_RECORDS',
    );
  });
});

describe('sandforge-frozen load --dry-run --max-total', () => {
  /** What the preview reads the load would do: three records to insert. */
  const PLAN = {
    orgId: ORG_ID,
    mode: { pilot: false, reload: false },
    plannedAt: '2026-10-21T10:00:00.000Z',
    perObject: [
      {
        objectApiName: 'Account',
        fromFiles: 2,
        toInsert: 2,
        reusedByKeys: 0,
        reusedFromCatalog: 0,
        fieldsDropped: 0,
        picklistsRewritten: 0,
        notSent: 0,
        toPurge: 0,
        toDeactivate: 0,
      },
      {
        objectApiName: 'Contact',
        fromFiles: 1,
        toInsert: 1,
        reusedByKeys: 0,
        reusedFromCatalog: 0,
        fieldsDropped: 0,
        picklistsRewritten: 0,
        notSent: 0,
        toPurge: 0,
        toDeactivate: 0,
      },
    ],
    excludedObjects: [],
    removals: [],
    placeholders: [],
    requiredDefaults: [],
    recordTypeIssues: 0,
    personContacts: 0,
    earlierLoads: 0,
  } as unknown as FrozenLoadPlanInfo;

  it('says a load held to fewer records than it would insert would be refused, its plan said beside it: exit 1', async () => {
    targetOrg();
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue(PLAN);

    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--dry-run',
        '--max-total',
        '2',
        '--json',
      ),
    );

    expect(process.exitCode).toBe(1);
    const read = dryRunAnswer.parse(JSON.parse(printed.join('')));
    expect(read.objects.map((o) => o.toInsert)).toEqual([2, 1]);
    expect(read.refusals).toEqual([
      expect.stringContaining('This load would insert 3 record(s), more than the 2 it may'),
    ]);
  });

  it('ends as done when the load fits the count it is held to', async () => {
    targetOrg();
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue(PLAN);

    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--dry-run',
        '--max-total',
        '3',
        '--json',
      ),
    );

    expect(process.exitCode ?? 0).toBe(0);
    expect(dryRunAnswer.parse(JSON.parse(printed.join(''))).refusals).toBeUndefined();
  });
});
