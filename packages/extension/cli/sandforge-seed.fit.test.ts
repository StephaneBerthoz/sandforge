/**
 * A seed from the command line fitted to what its target has left of its
 * data storage: `--fit share`, `--fit-cap`, `--fit-within`, what a dry run
 * says and its summary carries, the counts a refusal says --fit share would
 * seed, and the order a run keeps from its reads to its result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation } from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));

/** Every step a run makes, in the order it makes it. */
const steps: string[] = [];
/** What the target runs on the objects read, as the tests set it. */
let automationOf: (objects: readonly string[]) => ForgeTargetAutomation | Promise<never>;

vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async (_target: string, objects: readonly string[]) => {
      steps.push('automation read');
      return automationOf(objects);
    },
  })),
}));
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return {
    ...actual,
    muteForRun: vi.fn((...args: Parameters<typeof actual.muteForRun>) => {
      steps.push('lease plan');
      return actual.muteForRun(...args);
    }),
  };
});
vi.mock('../src/modules/seed/seedFit.js', async (original) => {
  const actual = await original<typeof import('../src/modules/seed/seedFit.js')>();
  return {
    ...actual,
    seedRoomOf: vi.fn((...args: Parameters<typeof actual.seedRoomOf>) => {
      steps.push('still running');
      return actual.seedRoomOf(...args);
    }),
  };
});

import { makeConn } from './sfSession.js';
import { fitOfArgs, main, parseArgs } from './sandforge-seed.js';
import { memoryPermissionOrg } from '../src/test/memoryPermissionOrg.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';

/** A field as the fake org describes it. */
const field = (name: string, type: string, over: Record<string, unknown> = {}) => ({
  name,
  type,
  createable: true,
  nillable: true,
  defaultedOnCreate: false,
  length: 80,
  referenceTo: [],
  picklistValues: [],
  ...over,
});

const DESCRIBES: Record<string, unknown> = {
  Account: {
    name: 'Account',
    createable: true,
    recordTypeInfos: [],
    fields: [
      field('Id', 'id', { createable: false, nillable: false }),
      field('Name', 'string', { nillable: false }),
    ],
  },
  Contact: {
    name: 'Contact',
    createable: true,
    recordTypeInfos: [],
    fields: [
      field('Id', 'id', { createable: false, nillable: false }),
      field('LastName', 'string', { nillable: false }),
      field('AccountId', 'reference', { referenceTo: ['Account'], length: 18 }),
    ],
  },
};

/** A target whose account flow creates a Task under each account created, which nothing keeps quiet. */
function creating(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Account',
        flows: [
          {
            apiName: 'Account_Follow_Up',
            label: 'Account follow-up',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions: [{ name: 'Account_Bypass', bypass: true, held: false }],
            creates: ['Task'],
          },
        ],
        triggers: [{ name: 'AccountTrigger', events: ['afterInsert'] }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: [
      {
        permission: 'Account_Bypass',
        permissionSets: [{ name: 'Account_Bypass_Set', label: 'Account bypass', grants: 1 }],
      },
    ],
    requests: 1,
  };
}

/**
 * A sandbox of `maxMB` of data storage, all of it left, that takes every
 * record it is sent through REST and puts each step down in `steps`.
 */
function fakeOrg(maxMB = 5, perms?: ReturnType<typeof memoryPermissionOrg>) {
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const base = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (sent: unknown[]) => {
        steps.push(`write ${name}`);
        return sent.map(() => ({ success: true, id: `001${String(made++).padStart(12, '0')}AAA` }));
      },
    }),
    describe: async (name: string) => DESCRIBES[name],
    describeGlobal: async () => ({
      sobjects: Object.keys(DESCRIBES).map((name) => ({ name, createable: true })),
    }),
    query: async (soql: string) =>
      soql.includes('DefaultLocaleSidKey')
        ? page([{ DefaultLocaleSidKey: 'en_US' }])
        : soql.includes('FROM Organization')
          ? page([{ Id: '00D000000000002AAA', IsSandbox: true }])
          : page([]),
    tooling: { query: async () => page([]) },
    request: async () => {
      steps.push('limits read');
      return {
        DataStorageMB: { Max: maxMB, Remaining: maxMB },
        DailyApiRequests: { Max: 15_000, Remaining: 15_000 },
        SingleEmail: { Max: 15, Remaining: 15 },
      };
    },
  };
  const conn = perms
    ? {
        ...base,
        identity: perms.connection.identity,
        query: (soql: string) =>
          /FROM (UserPermissionAccess|PermissionSet|PermissionSetAssignment|SetupEntityAccess|CustomPermission|ObjectPermissions)\b/.test(
            soql,
          )
            ? perms.connection.query(soql)
            : base.query(soql),
        sobject: (name: string) =>
          name === 'PermissionSetAssignment' ? perms.connection.sobject(name) : base.sobject(name),
      }
    : base;
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  return conn;
}

/** A seed of `accounts` accounts into TGT, two contacts each, with `extra` flags. */
function argv(accounts: number, ...extra: string[]): string[] {
  return [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--object',
    `Account:${accounts}`,
    '--object',
    'Contact:1',
    '--relation',
    'Contact.AccountId=Account',
    '--per-parent',
    '2',
    '--locale',
    'en_US',
    '--seed',
    '7',
    ...extra,
  ];
}

describe('the fit flags', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run a parse that is meant to be refused, and report the exit and what it said. */
  function refuse(...extra: string[]): { code: number | undefined; message: string } {
    let code: number | undefined;
    let message = '';
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c;
      throw new Error('exit');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      message += chunk;
      return true;
    }) as never);
    try {
      parseArgs(argv(10, ...extra));
    } catch {
      // `process.exit` is stubbed to throw so the parse stops where it would.
    }
    return { code, message };
  }

  it('reads a fit by share, caps by object and for every object, and a bound', () => {
    expect(parseArgs(argv(10)).fit).toBeUndefined();
    expect(parseArgs(argv(10, '--fit', 'share')).fit).toEqual({ share: true });
    expect(
      parseArgs(
        argv(
          10,
          '--fit-cap',
          'Account=10',
          '--fit-cap',
          '50',
          '--fit',
          'share',
          '--fit-within',
          '2.5',
        ),
      ).fit,
    ).toEqual({ share: true, caps: { all: 50, objects: { Account: 10 } }, withinMB: 2.5 });
    expect(
      fitOfArgs(['--fit-cap', 'Contact=3'], () => {
        throw new Error('refused');
      }),
    ).toEqual({ share: false, caps: { objects: { Contact: 3 } } });
  });

  it('refuses a fit line that does not read, exit 2, by name', () => {
    expect(refuse('--fit', 'all')).toEqual({
      code: 2,
      message: '--fit takes share, once, not "all".\n',
    });
    expect(refuse('--fit-cap', 'Account=0').message).toMatch(
      /^--fit-cap wants "<Object>=<n>" or "<n>", n a whole number from 1 to 100000, not "Account=0"/,
    );
    expect(refuse('--fit-cap', 'Account=x').code).toBe(2);
    expect(refuse('--fit-cap', 'Account=1', '--fit-cap', 'Account=2').message).toBe(
      '--fit-cap Account: give each object one cap.\n',
    );
    expect(refuse('--fit-within', '3').message).toBe(
      '--fit-within goes with --fit share or --fit-cap.\n',
    );
    expect(refuse('--fit', 'share', '--fit-within', '-1').code).toBe(2);
    expect(refuse('--fit', 'share', '--fit-within', '0').code).toBe(2);
    expect(refuse('--fit', 'share', '--fit-within', 'lots').code).toBe(2);
  });
});

describe('a seed fitted from the command line', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    steps.length = 0;
    automationOf = creating;
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
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  /** The summary a run printed with --json. */
  const summary = () =>
    JSON.parse(stdout.join('')) as {
      fit?: Record<string, unknown> & {
        applied: boolean;
        objects: Array<{ objectApiName: string; before: number; after: number }>;
      };
      storage?: { bytes: number; verdict: string; refusal?: string };
      result: { objectResults: Array<{ objectApiName: string; recordsCreated: number }> };
    };

  it('says the counts a dry run fits by share, and a gate they pass, room kept for what the flow creates', async () => {
    fakeOrg();

    await main(argv(2_000, '--fit', 'share', '--dry-run'));

    const out = stdout.join('');
    // 4,000 contacts under 2,000 accounts, about 11.7 MB, in a 5 MB org.
    expect(out).toMatch(
      /fit: share [\d.]+ %, the largest that fits 3\.6 MB: 80 % of the 5 MB TGT says it has left of 5, 0\.5 MB kept first for the rounding of what it says; [\d.]+ MB of it kept for what its flows still running create under these records\n/,
    );
    expect(out).toMatch(/\n {2}Account {2}\d+ of 2000\n {2}Contact {2}\d+ of 4000\n/);
    expect(out).toContain('  not counted: what Apex trigger AccountTrigger on Account creates\n');
    expect(out).toMatch(/data storage: about [\d.]+ MB to write, TGT has 5 MB left of 5 MB\n/);
    expect(out).not.toContain('a real run would be refused');
    // The gate met again by the counts fitted, its limits read again.
    expect(steps.filter((step) => step === 'limits read').length).toBe(2);
    expect(steps.indexOf('automation read')).toBeLessThan(steps.indexOf('limits read'));
  });

  it('carries the fit in its summary, and dry-runs the counts it fitted', async () => {
    fakeOrg();

    await main(argv(2_000, '--fit', 'share', '--dry-run', '--json'));

    const { fit, storage, result } = summary();
    expect(fit).toMatchObject({ applied: true, heldBy: 'storage', budget: { roundingMB: 0.5 } });
    const accounts = fit?.objects.find((o) => o.objectApiName === 'Account')?.after ?? 0;
    expect(accounts).toBeGreaterThan(0);
    expect(accounts).toBeLessThan(2_000);
    // Each account with its two contacts, and the Task its flow creates: within 80 % of 4.5 MB.
    expect(fit?.objects[1]?.after).toBe(2 * accounts);
    expect(accounts * (1 + 2 + 1) * 2048).toBeLessThanOrEqual(0.8 * 4.5 * 1024 * 1024);
    expect((accounts + 1) * (1 + 2 + 1) * 2048).toBeGreaterThan(0.8 * 4.5 * 1024 * 1024);
    expect(storage?.verdict).toBe('fits');
    expect(result.objectResults.map((o) => [o.objectApiName, o.recordsCreated])).toEqual([
      ['Account', accounts],
      ['Contact', 2 * accounts],
    ]);
  });

  it('caps an object and writes its children under the accounts kept', async () => {
    fakeOrg(500);

    await main(argv(2_000, '--fit-cap', 'Account=10', '--dry-run', '--json'));

    const { fit, result } = summary();
    expect(fit?.objects.map((o) => o.after)).toEqual([10, 20]);
    expect(fit).toMatchObject({ applied: true, caps: { objects: { Account: 10 } } });
    expect(result.objectResults.map((o) => o.recordsCreated)).toEqual([10, 20]);
  });

  it('refuses a cap on an object the seed does not write, exit 2', async () => {
    fakeOrg();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(main(argv(10, '--fit-cap', 'Lead=3', '--dry-run'))).rejects.toThrow('exit 2');
    expect(stderr.join('')).toBe('--fit-cap Lead: the seed writes no Lead.\n');
  });

  it('says, past the storage, the counts --fit share would seed, and a real run writes nothing', async () => {
    fakeOrg();

    await main(argv(2_000, '--dry-run', '--json'));
    const { fit, storage } = summary();
    expect(storage?.refusal).toMatch(/^The records to write take about/);
    expect(fit).toMatchObject({ applied: false, heldBy: 'storage' });
    expect(stderr.join('')).toMatch(/\n {2}--fit share would seed: share [\d.]+ %/);

    stdout.length = 0;
    steps.length = 0;
    await expect(main(argv(2_000))).rejects.toThrow(/^The records to write take about/);
    expect(stdout.join('')).toMatch(/\n {2}--fit share would seed: share [\d.]+ %/);
    expect(steps.some((step) => step.startsWith('write '))).toBe(false);
  });

  /** A dry run, `--json`, of 2,000 accounts and 2,000 articles the org has no object for. */
  async function dryRunWithArticles(...extra: string[]): Promise<void> {
    fakeOrg();
    const dir = mkdtempSync(join(tmpdir(), 'seed-optional-'));
    const object = (objectApiName: string, recordCount: number, optional: boolean) => ({
      objectApiName,
      recordCount,
      ...(optional ? { optional } : {}),
      fieldRules: [
        {
          fieldApiName: 'Name',
          fieldType: 'string',
          ruleType: 'static',
          config: { staticValue: 'x' },
        },
      ],
      excludedFields: [],
      insertOrder: 0,
    });
    const file = join(dir, 'template.json');
    writeFileSync(
      file,
      JSON.stringify({
        name: 'With articles',
        description: '',
        strategy: 'faker',
        objects: [object('Account', 2_000, false), object('Knowledge__kav', 2_000, true)],
        tags: [],
      }),
    );

    try {
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
        ...extra,
        '--dry-run',
        '--json',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('says in its summary the storage of what the org takes, as an environment sums it', async () => {
    await dryRunWithArticles();

    // The 2,000 accounts at 2 KB each, none of the articles the run skips.
    expect(summary().storage?.bytes).toBe(2_000 * 2 * 1024);
  });

  it('says in its summary the storage of the counts it fitted, of what the org takes', async () => {
    await dryRunWithArticles('--fit', 'share');

    const { fit, storage } = summary();
    expect(fit?.objects.map((o) => o.objectApiName)).toEqual(['Account']);
    expect(storage?.bytes).toBe((fit?.objects[0]?.after ?? 0) * 2 * 1024);
  });

  it('counts no optional object the org does not have: the fit neither cuts for it nor names it', async () => {
    await dryRunWithArticles('--fit', 'share');

    const { fit } = summary();
    // Each account and the task its flow creates, in 3.6 MB: no room is left to articles,
    // which would have cut the accounts by half more.
    expect(fit?.objects.map((o) => o.objectApiName)).toEqual(['Account']);
    expect(fit?.objects[0]?.after).toBeGreaterThan(800);
  });

  it('refuses a seed its caps leave past what fits, and writes nothing', async () => {
    fakeOrg();

    await expect(
      main(argv(2_000, '--fit-cap', 'Account=1500', '--fit-within', '1')),
    ).rejects.toThrow(
      /^The seed was refused before it wrote anything: it cannot be fitted to TGT: with these caps the seed takes [\d.]+ MB, room for what the org's automation creates under them included, past the 1 MB that fit: lower them, or fit by share\. Nothing was written\.$/,
    );
    expect(steps.some((step) => step.startsWith('write '))).toBe(false);
  });

  it('reads, plans its mute and what still runs, fits, meets its gate again, then holds the bypass only while it writes', async () => {
    const SET = '0PSxx0000000001AAA';
    const perms = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Account_Bypass_Set' }],
      beforeWrite: (write) => {
        steps.push(write.kind === 'insert' ? 'assign' : 'unassign');
      },
    });
    fakeOrg(5, perms);

    await main(argv(50, '--fit', 'share', '--fit-within', '0.02', '--mute-automation', '--json'));
    steps.push('result');

    const writes = steps.filter((step) => step.startsWith('write '));
    expect(steps).toEqual([
      'automation read',
      'lease plan',
      'still running',
      'limits read',
      'limits read',
      'assign',
      ...writes,
      'unassign',
      'result',
    ]);
    expect(writes).toEqual(['write Account', 'write Contact']);
    const asStep = (step: string): WritePathStep =>
      step.startsWith('write ')
        ? 'write'
        : ((
            {
              'automation read': 'reads',
              'limits read': 'reads',
              'lease plan': 'leasePlan',
              'still running': 'stillRunning',
              assign: 'leaseAcquire',
              unassign: 'leaseRelease',
              result: 'result',
            } as Record<string, WritePathStep>
          )[step] as WritePathStep);
    expect(writePathOrderDefects(steps.map(asStep))).toEqual([]);
    // The muted flow creates nothing: no room kept, the trigger named.
    const { fit, result } = summary();
    expect(fit).toMatchObject({ applied: true, budget: { automationMB: 0 } });
    expect(perms.assignments()).toEqual([]);
    const accounts = fit?.objects[0]?.after ?? 0;
    // 0.02 MB: 10 records of 2 KB, an account with its two contacts three times.
    expect(result.objectResults.map((o) => o.recordsCreated)).toEqual([accounts, 2 * accounts]);
    expect(accounts).toBe(3);
  });
});
