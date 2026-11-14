import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation, FrozenLoadPlanInfo } from '@sandforge/shared';

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
import { TargetAutomationReader } from '../src/modules/forge/TargetAutomationReader.js';
import { memoryPermissionOrg } from '../src/test/memoryPermissionOrg.js';
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
    status: z.enum(['completed', 'completed-with-errors', 'partial']),
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
    refusalCodes: z.array(name).optional(),
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
          tookAlong: z
            .object({ count, objects: z.array(name) })
            .strict()
            .optional(),
          cameAlong: z
            .object({ count, objects: z.array(name) })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    includeChanged: z.boolean(),
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
    includeChanged: z.boolean(),
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

  it('gives a dry run of a load asked to mute what a real load would assign, silence and lift beside', async () => {
    const mutePlan = {
      assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Bypass_Flow'] }],
      silenced: [
        {
          objectApiName: 'Contact',
          kind: 'flow' as const,
          name: 'Welcome',
          permission: 'Bypass_Flow',
        },
      ],
      stillRuns: [],
      alsoLifts: [
        {
          objectApiName: 'Contact',
          kind: 'validationRule' as const,
          name: 'Email_Required',
          permission: 'Bypass_VR',
          permissionSet: 'PS_Bypass',
        },
      ],
    };
    const mutedAutomation = {
      state: 'planned' as const,
      assigned: [],
      held: [],
      permissions: ['Bypass_Flow'],
      silenced: mutePlan.silenced,
      stillRan: [],
      alsoLifted: mutePlan.alsoLifts,
    };
    const answer = await frozenAnswer('load', [], {
      ...context(),
      mute: { mutedAutomation, mutePlan },
    });

    expect(answer.mutedAutomation?.alsoLifted?.map((entry) => entry.name)).toEqual([
      'Email_Required',
    ]);
    expect(answer.mutePlan?.assign.map((set) => set.permissionSet)).toEqual(['PS_Bypass']);
    expect(await frozenAnswer('load', [], context())).not.toHaveProperty('mutePlan');
  });

  it('says a stopped load ended cancelled, and the mapping a removal reads', async () => {
    // Run on the trap org, a reload stopped in its sweep answered neither,
    // its code in `posted` alone.
    const stopped = {
      type: 'frozen:load:error',
      payload: { code: 'LOAD_CANCELLED', message: 'The load was cancelled …', written: 0 },
    };

    const answer = await frozenAnswer('load', [stopped], context());

    expect(answer.status).toBe('cancelled');
    expect(answer.mapping).toBe(join(sasDir, `referenceid-mapping.${ORG_ID}.json`));
    // Refused before it wrote, a load says no status of its own.
    expect(
      await frozenAnswer(
        'load',
        [{ type: 'frozen:load:error', payload: { code: 'AUTOMATION_NOT_ACCEPTED', written: 0 } }],
        context(),
      ),
    ).not.toHaveProperty('status');
  });

  it('gives a load what the target gave, as read back, and a dry run what the describe says', async () => {
    const predicted = {
      objectApiName: 'Opportunity',
      rows: 1,
      why: { masterInSource: 1 },
      predicted: {
        developerName: 'SFX_Retail',
        label: 'SFX Retail',
        basis: 'onlyOneOpen' as const,
      },
    };
    const readBack = {
      ...predicted,
      readBack: {
        read: 1,
        types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 1 }],
      },
    };
    const plan = (recordTypesGiven?: unknown) => ({
      type: 'frozen:load:preview:response',
      payload: { plan: { perObject: [], ...(recordTypesGiven ? { recordTypesGiven } : {}) } },
    });
    const report = {
      type: 'frozen:load:response',
      payload: {
        report: { perObject: [], mappingPath: 'mapping.json', recordTypesGiven: [readBack] },
      },
    };

    expect((await frozenAnswer('load', [plan([predicted])], context())).recordTypesGiven).toEqual([
      predicted,
    ]);
    expect((await frozenAnswer('load', [report], context())).recordTypesGiven).toEqual([readBack]);
    expect(await frozenAnswer('load', [plan()], context())).not.toHaveProperty('recordTypesGiven');
  });

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
    expect(read.objects[0]).not.toHaveProperty('tookAlong');
  });

  it('gives a removal including changes what it took along per object, beside its counts', async () => {
    // Run for real, the contact made by hand that went with an account of the
    // load was said in the panel's answer alone: a script reading the counts
    // read "Contact: 4 deleted", the load's four.
    const object = {
      planned: 2,
      deleted: 2,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    };
    const answer = await frozenAnswer(
      'remove',
      [
        {
          type: 'frozen:remove:response',
          payload: {
            result: {
              status: 'success',
              includeChanged: true,
              finishedAt: 'x',
              objects: [
                { ...object, objectApiName: 'Contact', planned: 4, deleted: 4 },
                {
                  ...object,
                  objectApiName: 'Account',
                  tookAlong: { count: 1, objects: ['Contact'] },
                },
              ],
            },
          },
        },
      ],
      context(),
    );

    const read = removeAnswer.parse(answer);
    expect(read.objects[0]).not.toHaveProperty('tookAlong');
    expect(read.objects[1]).toMatchObject({
      objectApiName: 'Account',
      deleted: 2,
      tookAlong: { count: 1, objects: ['Contact'] },
    });
    // What was asked, at the root: GC13 and GC15 read it from nowhere.
    expect(read.includeChanged).toBe(true);
  });

  it('gives a removal what it took along that came with the load’s records, and whether changes were asked, at its root', async () => {
    const answer = await frozenAnswer(
      'remove',
      [
        {
          type: 'frozen:remove:response',
          payload: {
            result: {
              status: 'success',
              includeChanged: false,
              finishedAt: 'x',
              objects: [
                {
                  objectApiName: 'Account',
                  planned: 2,
                  deleted: 2,
                  alreadyGone: 0,
                  keptChanged: 0,
                  keptDependents: 0,
                  refused: 0,
                  heldBy: [],
                  unchecked: [],
                  reasons: [],
                  cameAlong: { count: 1, objects: ['Contact'] },
                },
              ],
            },
          },
        },
      ],
      context(),
    );

    const read = removeAnswer.parse(answer);
    expect(read.objects[0]).toMatchObject({ cameAlong: { count: 1, objects: ['Contact'] } });
    expect(read.objects[0]).not.toHaveProperty('tookAlong');
    expect(read.includeChanged).toBe(false);
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
    // Nothing fires: a removal's preview reads the org's triggers and rules here.
    tooling: { query: vi.fn(async () => page([])), queryMore: vi.fn() },
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
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
  return { writes, conn };
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

  describe('while the target runs automation as its purge deletes', () => {
    /** A trigger that fires as a contact is deleted, and no bypass of it. */
    const FIRING = {
      objectsRead: ['Account', 'Contact'],
      objects: [
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [{ name: 'ContactCleanup', events: ['beforeDelete'] }],
        },
      ],
      unread: [],
    } as unknown as ForgeTargetAutomation;

    beforeEach(() => {
      vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(FIRING);
    });

    afterEach(() => {
      vi.mocked(TargetAutomationReader.prototype.read).mockRestore();
    });

    it('names it and writes nothing unaccepted: exit 1, where it purged unasked', async () => {
      const { writes } = targetOrg();
      await loaded();

      await main(
        argv('load', '--config', configPath, '--target', 'TGT', '--reload', '--yes', '--json'),
      );

      expect(writes).toEqual([]);
      expect(process.exitCode).toBe(1);
      const answer = JSON.parse(printed.join('')) as {
        refusals: string[];
        ended: boolean;
        refused?: { code: string; message: string };
      };
      expect(answer.ended).toBe(true);
      expect(answer.refusals[0]).toContain('ContactCleanup');
      expect(answer.refusals[0]).toContain('--accept-automation');
      // Said of the reload: it said "this removal" and "remove all the same"
      // of a load asked to replace the one before.
      expect(answer.refusals[0]).toContain(
        "TGT runs automation on the records this reload's purge deletes: Contact: Apex trigger ContactCleanup",
      );
      expect(answer.refusals[0]).toContain('Add --accept-automation to reload all the same');
      expect(answer.refusals[0]).not.toContain('removal');
      // A pipeline reads the code, as it reads a refused clone's, seed's or sync's.
      expect(answer.refused).toEqual({
        code: 'AUTOMATION_NOT_ACCEPTED',
        message: answer.refusals[0],
      });
    });

    it('goes past it accepted, and hands the load on', async () => {
      targetOrg();
      await loaded();

      await main(
        argv(
          'load',
          '--config',
          configPath,
          '--target',
          'TGT',
          '--reload',
          '--accept-automation',
          '--yes',
          '--json',
        ),
      );

      const answer = JSON.parse(printed.join('')) as {
        refusals?: string[];
        posted: Array<{ type: string }>;
      };
      expect(answer.refusals).toBeUndefined();
      expect(answer.posted.map((message) => message.type)).toContain('operation:started');
    });

    it('asks nothing of a first load, which purges nothing', async () => {
      targetOrg();

      await main(
        argv('load', '--config', configPath, '--target', 'TGT', '--reload', '--yes', '--json'),
      );

      const answer = JSON.parse(printed.join('')) as {
        refusals?: string[];
        posted: Array<{ type: string }>;
      };
      expect(answer.refusals).toBeUndefined();
      expect(answer.posted.map((message) => message.type)).toContain('operation:started');
    });
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
    // Beside it, the code the load itself is refused with: the words alone, a
    // pipeline could not tell one refusal from another.
    expect(read.refusalCodes).toEqual(['MAX_RECORDS']);
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

  describe('with --mute-automation, by a user who cannot assign permission sets', () => {
    /** The objects the permission org answers for: a mute's reads of the permission sets. */
    const PERMISSION_OBJECTS =
      /\bFROM\s+(Organization|UserPermissionAccess|PermissionSetAssignment|SetupEntityAccess|ObjectPermissions|CustomPermission|PermissionSet)\b/i;

    /** A flow on the accounts a bypass keeps quiet, which a set of the target holds. */
    const QUIETED = {
      objectsRead: ['Account', 'Contact'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [
            {
              apiName: 'Account_Welcome',
              label: 'Account welcome',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [{ name: 'Load_Data', bypass: true }],
            },
          ],
          triggers: [],
        },
      ],
      bypassGrants: [
        {
          permission: 'Load_Data',
          permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
        },
      ],
      unread: [],
    } as unknown as ForgeTargetAutomation;

    /** The target, its permission sets read as the org answers a user without the right. */
    function withoutTheRight() {
      const { conn: base } = targetOrg();
      const permissions = memoryPermissionOrg({
        userId: '005000000000001AAA',
        organizationId: ORG_ID,
        canAssign: false,
        sets: [{ id: '0PS000000000001AAA', name: 'Data_Load' }],
      });
      const conn = {
        ...base,
        identity: permissions.connection.identity,
        query: async (soql: string) =>
          !soql.includes('IsSandbox') && PERMISSION_OBJECTS.test(soql)
            ? permissions.connection.query(soql)
            : base.query(soql),
        sobject: (object: string) =>
          object === 'PermissionSetAssignment'
            ? permissions.connection.sobject(object)
            : base.sobject(object),
      };
      vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(QUIETED);
      return permissions;
    }

    it('says a load would be refused for it, assigns nothing and plans no mute: exit 1, where it said "mute planned"', async () => {
      const permissions = withoutTheRight();
      vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue(PLAN);

      await main(
        argv(
          'load',
          '--config',
          configPath,
          '--target',
          'TGT',
          '--dry-run',
          '--mute-automation',
          // What still runs accepted: the mute's refusal is said alone.
          '--accept-automation',
          '--json',
        ),
      );

      expect(process.exitCode).toBe(1);
      const answer = JSON.parse(printed.join('')) as {
        refusals?: string[];
        refusalCodes?: string[];
        mutedAutomation?: unknown;
      };
      expect(answer.refusals).toEqual([
        expect.stringContaining('the user the run writes as cannot assign permission sets'),
      ]);
      // The code the load itself is refused with, below.
      expect(answer.refusalCodes).toEqual(['MUTE_NO_RIGHT']);
      expect(answer).not.toHaveProperty('mutedAutomation');
      expect(permissions.assignments()).toEqual([]);
      expect(permissions.writes).toEqual([]);
    });

    it('is refused so by the load itself, before it writes', async () => {
      const permissions = withoutTheRight();

      await main(
        argv(
          'load',
          '--config',
          configPath,
          '--target',
          'TGT',
          '--mute-automation',
          '--yes',
          '--json',
        ),
      );

      expect(process.exitCode).toBe(1);
      const answer = JSON.parse(printed.join('')) as {
        posted: Array<{ type: string; payload: { code?: string } }>;
        refused?: { code: string; message: string };
      };
      expect(answer.posted.find((m) => m.type === 'frozen:load:error')?.payload.code).toBe(
        'MUTE_NO_RIGHT',
      );
      // Beside the posted error, as a clone refused for its mute gives it.
      expect(answer.refused?.code).toBe('MUTE_NO_RIGHT');
      expect(permissions.assignments()).toEqual([]);
    });
  });
});

describe('sandforge-frozen load, refused for its emails before it writes', () => {
  /** The trap Developer Edition's contact flow: two single emails a contact, and no bypass. */
  const EMAILING = {
    objectsRead: ['Account', 'Contact'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          {
            apiName: 'Contact_Welcome',
            label: 'Contact welcome',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions: [],
            messages: [
              { kind: 'email', name: 'Send welcome', limit: 'SingleEmail' },
              { kind: 'email', name: 'Send reminder', limit: 'SingleEmail' },
            ],
          },
        ],
        triggers: [],
      },
    ],
    unread: [],
  } as unknown as ForgeTargetAutomation;

  it('ends on the line a refused run ends on, its code named, and gives the code under refused: exit 1', async () => {
    const { writes, conn } = targetOrg();
    // The org as the trap Developer Edition answered the gate's reads: its
    // limits, one single email left today, and the line of Apex that sends
    // nothing, which goes through on All email.
    const answering = {
      ...conn,
      request: async ({ url }: { url: string }) => {
        if (url === '/limits') {
          return {
            SingleEmail: { Max: 15, Remaining: 1 },
            DailyWorkflowEmails: { Max: 8040, Remaining: 8040 },
          };
        }
        if (url.startsWith('/tooling/executeAnonymous')) return { compiled: true, success: true };
        throw new Error(`not answered: ${url}`);
      },
    };
    vi.mocked(makeConn).mockReturnValue(answering as unknown as Connection);
    vi.mocked(getJsforceConnection).mockResolvedValue(answering as never);
    vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(EMAILING);
    const said: string[] = [];
    vi.mocked(process.stderr.write).mockImplementation(((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as never);

    // What runs as it writes accepted: what refuses it is its emails.
    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--accept-automation',
        '--yes',
        '--json',
      ),
    );

    expect(writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    const answer = JSON.parse(printed.join('')) as {
      refused?: { code: string; message: string };
      refusalCodes?: string[];
    };
    expect(answer.refused).toEqual({
      code: 'FROZEN_EMAILS_EXCEEDED',
      message: expect.stringContaining('1 of 15 left today'),
    });
    expect(answer.refusalCodes).toEqual(['FROZEN_EMAILS_EXCEEDED']);
    // Run for real, it said "! frozen:load:error: … [FROZEN_EMAILS_EXCEEDED]"
    // where the help promises "refused (CODE): …", as a load refused for its
    // purge or its checkpoint says it; what it was judged on stays above it.
    const lines = said.join('').trimEnd().split('\n');
    expect(lines.at(-1)).toBe(`refused (FROZEN_EMAILS_EXCEEDED): ${answer.refused?.message}`);
    expect(lines.at(-2)).toMatch(/^ {2}(emails|deliverability): /);
    expect(said.join('')).not.toContain('! frozen:load:error');
  });
});

describe('sandforge-frozen load, and what the target runs as it inserts', () => {
  /*
   * A flow after save on the creation of a contact that sends nothing, as the
   * one a scratch org ran on opportunity products, which deleted each the
   * second it went in: the load asked nothing of it, and only its
   * verification saw it.
   */
  const FOLLOWING_UP = {
    objectsRead: ['Account', 'Contact'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          {
            apiName: 'Contact_Follow_Up',
            label: 'Contact follow-up',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions: [],
            messages: [],
          },
        ],
        triggers: [],
      },
    ],
    unread: [],
  } as unknown as ForgeTargetAutomation;

  /** The stderr lines of the run, split. */
  const stderrLines = (): string[] =>
    vi
      .mocked(process.stderr.write)
      .mock.calls.map(([chunk]) => String(chunk))
      .join('')
      .trimEnd()
      .split('\n');

  beforeEach(() => {
    vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(FOLLOWING_UP);
  });

  it('writes nothing without --accept-automation, names what runs, and ends on its refused line: exit 1', async () => {
    const { writes } = targetOrg();
    const load = vi.spyOn(FrozenDatasetLoader.prototype, 'load');

    await main(argv('load', '--config', configPath, '--target', 'TGT', '--yes', '--json'));

    expect(writes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const answer = JSON.parse(printed.join('')) as {
      refused?: { code: string; message: string };
      refusalCodes?: string[];
    };
    expect(answer.refused?.code).toBe('AUTOMATION_NOT_ACCEPTED');
    expect(answer.refused?.message).toContain(
      'TGT runs automation as this load inserts its records and updates them: Contact: flow ' +
        '"Contact follow-up" (insert).',
    );
    expect(answer.refused?.message).toContain('Add --accept-automation to load all the same');
    expect(answer.refusalCodes).toEqual(['AUTOMATION_NOT_ACCEPTED']);
    const lines = stderrLines();
    expect(lines).toContain(
      'target automation: what the target runs as the load inserts its records and updates them',
    );
    expect(lines).toContain('  Contact: flow "Contact follow-up" (insert)');
    expect(lines.at(-1)).toBe(`refused (AUTOMATION_NOT_ACCEPTED): ${answer.refused?.message}`);
  });

  it('says with --dry-run that a load would be refused for it, and not once accepted', async () => {
    targetOrg();
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue({
      orgId: ORG_ID,
      mode: { pilot: false, reload: false },
      plannedAt: '2026-10-21T10:00:00.000Z',
      perObject: [],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
    } as unknown as FrozenLoadPlanInfo);

    await main(argv('load', '--config', configPath, '--target', 'TGT', '--dry-run', '--json'));

    expect(process.exitCode).toBe(1);
    const refused = JSON.parse(printed.join('')) as {
      refusalCodes?: string[];
      posted: Array<{ type: string; payload: { plan?: FrozenLoadPlanInfo } }>;
    };
    expect(refused.refusalCodes).toEqual(['AUTOMATION_NOT_ACCEPTED']);
    expect(stderrLines()).toContainEqual(
      expect.stringMatching(
        /^a load would be refused \(AUTOMATION_NOT_ACCEPTED\): TGT runs automation/,
      ),
    );

    printed.length = 0;
    vi.mocked(process.stderr.write).mockClear();
    process.exitCode = undefined;
    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--dry-run',
        '--accept-automation',
        '--json',
      ),
    );

    // Done: no code set, which exits 0.
    expect(process.exitCode).toBeUndefined();
    const accepted = JSON.parse(printed.join('')) as {
      refusalCodes?: string[];
      posted: Array<{ type: string; payload: { plan?: FrozenLoadPlanInfo } }>;
    };
    expect(accepted).not.toHaveProperty('refusalCodes');
    const plan = accepted.posted.find((m) => m.type === 'frozen:load:preview:response')?.payload
      .plan;
    expect(plan?.automation).toEqual({
      firing: [
        { objectApiName: 'Contact', kind: 'flow', name: 'Contact follow-up', writes: ['insert'] },
      ],
      accepted: true,
    });
    expect(stderrLines()).toContain(
      '  accepted (--accept-automation): the load writes all the same',
    );
  });

  it('names the set --mute-automation would assign, but not to an environment that relays it and mutes nothing', async () => {
    const quietFor = {
      ...FOLLOWING_UP,
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              ...(FOLLOWING_UP.objects[0].flows[0] as object),
              permissions: [{ name: 'Load_Data', bypass: true }],
            },
          ],
          triggers: [],
        },
      ],
      bypassGrants: [
        {
          permission: 'Load_Data',
          permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
        },
      ],
    } as unknown as ForgeTargetAutomation;
    vi.mocked(TargetAutomationReader.prototype.read).mockResolvedValue(quietFor);
    const refusal = async (): Promise<string | undefined> => {
      printed.length = 0;
      targetOrg();
      await main(argv('load', '--config', configPath, '--target', 'TGT', '--yes', '--json'));
      return (JSON.parse(printed.join('')) as { refused?: { message: string } }).refused?.message;
    };

    expect(await refusal()).toContain('With --mute-automation, the load assigns Data_Load');
    vi.stubEnv('SANDFORGE_RELAYED_BY', 'sandforge env');
    try {
      const relayed = await refusal();
      expect(relayed).toContain('Add --accept-automation to load all the same');
      expect(relayed).not.toContain('--mute-automation');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('goes on to the load with --accept-automation', async () => {
    targetOrg();
    const load = vi
      .spyOn(FrozenDatasetLoader.prototype, 'load')
      .mockRejectedValue(new Error('stopped here: the load was reached'));

    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--accept-automation',
        '--yes',
        '--json',
      ),
    );

    expect(load).toHaveBeenCalledTimes(1);
    const answer = JSON.parse(printed.join('')) as { refused?: unknown };
    expect(answer).not.toHaveProperty('refused');
  });
});

describe('sandforge-frozen load, held to the daily API requests the target has left', () => {
  /** What the target runs as the records go in: nothing, read in no request. */
  const NOTHING_RUNS = {
    objectsRead: ['Account', 'Contact'],
    objects: [],
    bypassGrants: [],
    unread: [],
    requests: 0,
  } as unknown as ForgeTargetAutomation;

  /** The target, its limits saying it has `remaining` of its 15,000 daily requests left. */
  function limitedTo(remaining: number): string[] {
    const { writes, conn } = targetOrg();
    const answering = {
      ...conn,
      request: async ({ url }: { url: string }) => {
        if (url === '/limits') return { DailyApiRequests: { Max: 15_000, Remaining: remaining } };
        throw new Error(`not answered: ${url}`);
      },
    };
    vi.mocked(makeConn).mockReturnValue(answering as unknown as Connection);
    vi.mocked(getJsforceConnection).mockResolvedValue(answering as never);
    vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(NOTHING_RUNS);
    return writes;
  }

  it('ends on the line a refused run ends on, its code named, and gives the code under refused: exit 1', async () => {
    // A load read no limit of the requests: into an org whose integrations
    // had spent the day's, it stopped part way through.
    const writes = limitedTo(3);
    const said: string[] = [];
    vi.mocked(process.stderr.write).mockImplementation(((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as never);

    await main(argv('load', '--config', configPath, '--target', 'TGT', '--yes', '--json'));

    expect(writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    const answer = JSON.parse(printed.join('')) as {
      refused?: { code: string; message: string };
      refusalCodes?: string[];
    };
    expect(answer.refused).toEqual({
      code: 'API_BUDGET_EXCEEDED',
      message: expect.stringContaining('has 3 of its 15000 daily requests left'),
    });
    expect(answer.refusalCodes).toEqual(['API_BUDGET_EXCEEDED']);
    const lines = said.join('').trimEnd().split('\n');
    expect(lines.at(-1)).toBe(`refused (API_BUDGET_EXCEEDED): ${answer.refused?.message}`);
    expect(said.join('')).not.toContain('! frozen:load:error');
  });

  it('says with --dry-run what a load would take and that it would be refused: exit 1', async () => {
    const writes = limitedTo(3);
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue({
      orgId: ORG_ID,
      mode: { pilot: false, reload: false },
      plannedAt: '2026-10-21T10:00:00.000Z',
      perObject: [],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
    } as unknown as FrozenLoadPlanInfo);

    await main(argv('load', '--config', configPath, '--target', 'TGT', '--dry-run'));

    expect(writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    const said = printed.join('');
    expect(said).toMatch(
      /\n {2}API requests: about \d+, of the 3 the target has left of its 15000 a day: more than it has left\n/,
    );
    expect(said).toContain('a load would be refused (API_BUDGET_EXCEEDED): The run takes about');
  });

  it('says on a load it lets by what it took of what the target had left', async () => {
    limitedTo(14_000);
    vi.spyOn(FrozenDatasetLoader.prototype, 'load').mockResolvedValue({
      status: 'completed',
      orgId: ORG_ID,
      mode: { pilot: false, reload: false },
      startedAt: '2026-10-21T10:00:00.000Z',
      durationMs: 10,
      alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
      placeholders: [],
      requiredDefaults: [],
      perObject: [],
      pass2: { resolved: 0, unresolved: [] },
      personContact: { restored: 0, sent: [], unresolved: [] },
      statuses: { restored: 0, refused: [] },
      purge: { deleted: {}, deactivated: {}, failures: [] },
      mappingPath: '',
      contractPath: join(sasDir, 'no-such-contract.json'),
    } as never);

    await main(argv('load', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(printed.join('')).toMatch(
      /\n {2}API requests: about \d+, of the 14000 the target has left of its 15000 a day\n/,
    );
  });
});
