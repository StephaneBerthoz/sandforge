import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type {
  ForgeTargetAutomation,
  FrozenLoadPlanInfo,
  MutedAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';

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
// The checkpoint the load takes first, and the mute's lease the handler
// takes, as the command and the handler ask them: each tested on its own,
// here in the order they are called.
vi.mock('./beforeRunCheckpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beforeRunCheckpoint.js')>();
  return { ...actual, commandCheckpoints: vi.fn(actual.commandCheckpoints) };
});
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { makeConn } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { FrozenDatasetLoader } from '../src/modules/frozendataset/FrozenDatasetLoader.js';
import type { FrozenLoadReport } from '../src/modules/frozendataset/loadTypes.js';
import { FrozenDatasetHandler } from '../src/bridge/handlers/FrozenDatasetHandler.js';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { TargetAutomationReader } from '../src/modules/forge/TargetAutomationReader.js';
import {
  writePathOrderDefects,
  type BeforeRunTake,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { CHECKPOINT_STOPPED_WORDS } from '../src/modules/forge/ForgeRunGate.js';
import {
  commandCheckpoints,
  type CommandCheckpointAsk,
  type CommandCheckpoints,
} from './beforeRunCheckpoint.js';
import {
  datasetObjectsOf,
  frozenLoadWrote,
  loadPlanWrites,
  main,
  parseArgs,
} from './sandforge-frozen.js';

/** The target, a sandbox, as its `Organization` record answers. */
const ORG_ID = '00D000000000009AAA';

/** What the target runs on the opportunities: a flow whose bypass `Data_Load` holds. */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Opportunity'],
  objects: [
    {
      objectApiName: 'Opportunity',
      flows: [
        {
          apiName: 'Deal_Welcome',
          label: 'Deal welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
          creates: [],
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
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

/** What the checkpoint of the load would hold and cost, as its scope says. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 3, apiRequests: 12, apiRequestsLeft: 14_000, seconds: 4, bytes: 6_000 },
  objects: ['Account', 'Contact'],
  added: [],
  notHeld: [],
  keepDays: 7,
};
/** The checkpoint the take keeps. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-120000-e5f6',
  name: 'Before Frozen Dataset load 2026-11-01 12:00 UTC',
  takenAt: '2026-11-01T12:00:03.000Z',
  expiresAt: '2026-11-08T12:00:00.000Z',
  objects: ['Account', 'Contact'],
  records: 0,
  bytes: 512,
  requests: 10,
  added: [],
  notHeld: [],
};

let sasDir: string;
let datasetDir: string;
let configPath: string;
let printed: string[];
let errored: string[];

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

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
      volumetry: {
        budgetMax: 2500,
        measured: { Account: 2, Contact: 1, Case: 0 },
        measuredAt: 'x',
      },
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

/** One page of a query answer. */
const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

/**
 * The target: a sandbox that answers what it is, and that its user may assign
 * permission sets — which a dry run's mute now asks, as the load's does —, and
 * nothing else.
 */
function targetOrg(): void {
  const conn = {
    query: vi.fn(async (soql: string) =>
      soql.includes('IsSandbox')
        ? page([{ Id: ORG_ID, IsSandbox: true }])
        : /\bFROM UserPermissionAccess\b/.test(soql)
          ? page([{ PermissionsAssignPermissionSets: true, PermissionsManageUsers: false }])
          : page([]),
    ),
    queryMore: vi.fn(),
    describe: vi.fn(async (object: string) => ({ name: object, fields: [] })),
    describeGlobal: vi.fn(async () => ({ sobjects: [] })),
    soap: {
      getServerTimestamp: vi.fn(async () => ({ timestamp: new Date().toISOString() })),
      getUserInfo: vi.fn(async () => ({ userId: '005000000000001AAA' })),
    },
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
}

/** What a load that inserted `inserted` accounts reports. */
function reportOf(inserted: number): FrozenLoadReport {
  return {
    status: 'completed',
    orgId: ORG_ID,
    mode: { pilot: false, reload: false },
    startedAt: '2026-11-01T12:00:05.000Z',
    durationMs: 5,
    alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
    placeholders: [],
    requiredDefaults: [],
    perObject: [
      {
        objectApiName: 'Account',
        fromFiles: 2,
        inserted,
        reused: 2 - inserted,
        skippedDuplicates: [],
        failed: [],
      },
    ],
    pass2: { resolved: 0, unresolved: [] },
    personContact: { restored: 0, unresolved: [] },
    purge: { deleted: {}, deactivated: {}, failures: [] },
    mappingPath: join(sasDir, 'referenceid-mapping.json'),
    contractPath: join(sasDir, 'contract.json'),
  } as unknown as FrozenLoadReport;
}

/** The checkpoint the load asks for, each call in `events`: its scope answers `estimate`, its take `take`. */
function checkpointsOf(
  events: string[],
  options: {
    estimate?: Partial<RunCheckpointEstimate>;
    take?: () => Promise<BeforeRunTake>;
  } = {},
) {
  const asked: CommandCheckpointAsk[] = [];
  const port: CommandCheckpoints = {
    scope: vi.fn(async (ask: CommandCheckpointAsk) => {
      asked.push(ask);
      events.push('scope');
      return { ...ESTIMATE, ...options.estimate };
    }),
    take: vi.fn(async () => {
      events.push('take');
      return options.take ? options.take() : { taken: true as const, checkpoint: TAKEN };
    }),
    settle: vi.fn(async (taken: RunCheckpointTaken, wrote: boolean) => {
      events.push(`settle ${String(wrote)}`);
      return wrote ? taken : { state: 'deleted' as const, deleted: 'nothingWritten' as const };
    }),
  };
  vi.mocked(commandCheckpoints).mockReturnValue(port);
  return { port, asked };
}

/** A mute whose lease holds one set, its acquire and release in `events`. */
function muteOf(events: string[]): void {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Bypass_Flow'],
    silenced: [],
    stillRan: [],
  };
  vi.mocked(muteForRun).mockResolvedValue({
    automation: undefined,
    muted,
    prepared: {
      acquire: async () => {
        events.push('lease');
        return {
          outcome: muted,
          release: async () => {
            events.push('release');
            return { ...muted, released: true };
          },
        };
      },
    },
  } as never);
}

/** The load writes as it is told: `inserted` accounts, each write in `events`. */
function loadWrites(events: string[], inserted = 2): void {
  vi.spyOn(FrozenDatasetLoader.prototype, 'load').mockImplementation(async () => {
    if (inserted > 0) events.push('write Account');
    return reportOf(inserted);
  });
  // The verification a load chains reads the target: not what is held here.
  vi.spyOn(
    FrozenDatasetHandler.prototype as unknown as { runVerification: () => Promise<void> },
    'runVerification',
  ).mockResolvedValue(undefined);
}

const argv = (...args: string[]): string[] => ['node', 'sandforge-frozen.ts', ...args];
const load = (...more: string[]) =>
  argv('load', '--config', configPath, '--target', 'TGT', '--yes', ...more);

/** The JSON a step printed on stdout. */
const answer = () =>
  JSON.parse(printed.join('')) as Record<string, unknown> & {
    posted: Array<{ type: string }>;
  };

beforeEach(() => {
  sasDir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-checkpoint-'));
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
  errored = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    printed.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    errored.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  process.exitCode = undefined;
  targetOrg();
  // Unless a case scripts it, the target runs nothing as the load writes:
  // the gate on its emails reads what it runs, which is not what is tested here.
  vi.spyOn(TargetAutomationReader.prototype, 'read').mockImplementation(
    async (_orgId, objects) => ({
      objectsRead: [...objects],
      objects: [],
      bypassGrants: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 1,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(muteForRun).mockReset();
  process.exitCode = undefined;
  rmSync(sasDir, { recursive: true, force: true });
});

describe('sandforge-frozen load --checkpoint-first', () => {
  it('takes it once the load may write, before the handler’s lease and its first write, and keeps it once the load wrote', async () => {
    const events: string[] = [];
    const { asked } = checkpointsOf(events);
    muteOf(events);
    loadWrites(events);

    await main(load('--mute-automation', '--checkpoint-first', '--json'));

    expect(events).toEqual(['scope', 'take', 'lease', 'write Account', 'release', 'settle true']);
    // The --yes stands for the question, asked before the take.
    const steps = events.map((event): WritePathStep => {
      if (event === 'scope') return 'stillRunning';
      if (event === 'take') return 'checkpointTake';
      if (event === 'lease') return 'leaseAcquire';
      if (event === 'release') return 'leaseRelease';
      if (event.startsWith('write')) return 'write';
      return 'result';
    });
    expect(writePathOrderDefects(['reads', 'question', ...steps])).toEqual([]);
    // The objects the dataset holds records of.
    expect(asked[0].written).toEqual(['Account', 'Contact']);
    expect(answer().checkpoint).toEqual(TAKEN);
    // The handler is asked for no checkpoint of its own.
    expect(errored.join('')).toContain(
      '  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ' +
        'ck-20261101-120000-e5f6 --mute-automation',
    );
    expect(vi.mocked(commandCheckpoints).mock.calls[0][0]).toMatchObject({
      module: 'frozen',
      request: {},
      org: { id: ORG_ID, orgType: 'Sandbox' },
    });
  });

  it('deletes it when the load reports it wrote nothing', async () => {
    const events: string[] = [];
    checkpointsOf(events);
    loadWrites(events, 0);

    await main(load('--checkpoint-first', '--json'));

    expect(events).toEqual(['scope', 'take', 'settle false']);
    expect(answer().checkpoint).toEqual({ state: 'deleted', deleted: 'nothingWritten' });
  });

  it('sends no load when its scope is refused, in the command’s words, and exits 1', async () => {
    const events: string[] = [];
    checkpointsOf(events, {
      estimate: { refusal: { code: 'RUN_WRITING', message: 'Another run writes to TGT.' } },
    });
    loadWrites(events);

    await main(load('--checkpoint-first', '--json'));

    expect(events).toEqual(['scope']);
    expect(answer().posted.some((message) => message.type === 'frozen:load:response')).toBe(false);
    expect(errored.join('')).toContain(
      'The checkpoint before the run was refused: Another run writes to TGT. Fix what refuses ' +
        'it, or run without --checkpoint-first to write without one. Nothing was written.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('sends no load when the take is refused, and exits 1', async () => {
    const events: string[] = [];
    checkpointsOf(events, {
      take: async () => ({ taken: false, refusal: { code: 'DISK', message: 'Too little room.' } }),
    });
    loadWrites(events);

    await main(load('--checkpoint-first'));

    expect(events).toEqual(['scope', 'take']);
    expect(process.exitCode).toBe(1);
  });

  it('stops at Ctrl-C during the take, sends no load, keeps nothing, and exits 130', async () => {
    const events: string[] = [];
    checkpointsOf(events, {
      take: async () => {
        process.emit('SIGINT');
        return { taken: false, stopped: true };
      },
    });
    loadWrites(events);

    await main(load('--checkpoint-first'));

    expect(events).toEqual(['scope', 'take']);
    expect(errored.join('')).toContain(CHECKPOINT_STOPPED_WORDS);
    expect(process.exitCode).toBe(130);
  });

  it('says on a dry run what it would hold and cost, from the objects the plan writes, and takes nothing', async () => {
    const events: string[] = [];
    const { port, asked } = checkpointsOf(events);
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue({
      orgId: ORG_ID,
      perObject: [
        { objectApiName: 'Account', fromFiles: 2, toInsert: 2, toPurge: 0, toDeactivate: 0 },
        { objectApiName: 'Contact', fromFiles: 1, toInsert: 0, toPurge: 0, toDeactivate: 0 },
      ],
      placeholders: [],
    } as unknown as FrozenLoadPlanInfo);

    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--dry-run',
        '--checkpoint-first',
        '--json',
      ),
    );

    expect(events).toEqual(['scope']);
    expect(port.take).not.toHaveBeenCalled();
    expect(asked[0].written).toEqual(['Account']);
    expect(answer().checkpoint).toEqual(ESTIMATE);
    expect(errored.join('')).toContain('  Checkpoint first: about 3 records of 2 objects');
  });

  it('says on a dry run what the target would give, and that the mute a real load holds may open more', async () => {
    vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(AUTOMATION);
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue({
      orgId: ORG_ID,
      mode: { pilot: false, reload: false },
      perObject: [
        { objectApiName: 'Opportunity', fromFiles: 1, toInsert: 1, toPurge: 0, toDeactivate: 0 },
      ],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypesGiven: [
        {
          objectApiName: 'Opportunity',
          rows: 1,
          why: { masterInSource: 1 },
          predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
        },
      ],
    } as unknown as FrozenLoadPlanInfo);

    await main(
      argv('load', '--config', configPath, '--target', 'TGT', '--dry-run', '--mute-automation'),
    );

    const said = printed.join('');
    expect(said).toContain('record types the target would give the records created without one');
    expect(said).toContain('would go in as SFX_Retail');
    expect(said).toContain('may open other record types');
  });

  it('says on a dry run that a real load would be refused for its checkpoint, exit 1', async () => {
    checkpointsOf([], {
      estimate: { refusal: { code: 'TOO_MANY_RECORDS', message: 'Past its limit.' } },
    });
    vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue({
      orgId: ORG_ID,
      perObject: [
        { objectApiName: 'Account', fromFiles: 2, toInsert: 2, toPurge: 0, toDeactivate: 0 },
      ],
      placeholders: [],
    } as unknown as FrozenLoadPlanInfo);

    await main(
      argv(
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--dry-run',
        '--checkpoint-first',
        '--json',
      ),
    );

    expect(answer().refusals).toEqual([
      'The checkpoint before the run was refused: Past its limit. Fix what refuses it, leave an ' +
        'object out of it (--checkpoint-exclude-object <ApiName>), or run without ' +
        '--checkpoint-first to write without one.',
    ]);
    expect(answer().refusalCodes).toEqual(['CHECKPOINT_REFUSED']);
    expect(errored.join('')).toContain(
      'a load would be refused (CHECKPOINT_REFUSED): The checkpoint before the run was refused',
    );
    expect(process.exitCode).toBe(1);
  });

  it('refuses the option with another step than load, exit 2', () => {
    expect(() =>
      parseArgs(argv('verify', '--config', 'f.json', '--target', 'TGT', '--checkpoint-first')),
    ).toThrow(ExitCalled);
    expect(errored.join('')).toBe('--checkpoint-first goes with load. Run with --help.\n');
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--checkpoint-first'))
        .checkpointFirst,
    ).toEqual({});
  });
});

describe('what a load writes, as its checkpoint is told it', () => {
  it('reads the objects a plan inserts, purges, deactivates or makes placeholders of', () => {
    expect(
      loadPlanWrites({
        perObject: [
          { objectApiName: 'Account', toInsert: 1, toPurge: 0, toDeactivate: 0 },
          { objectApiName: 'Contact', toInsert: 0, toPurge: 0, toDeactivate: 0 },
          { objectApiName: 'Order', toInsert: 0, toPurge: 2, toDeactivate: 0 },
          { objectApiName: 'Contract', toInsert: 0, toPurge: 0, toDeactivate: 1 },
        ],
        placeholders: [
          { placeholderObjectApiName: 'Account' },
          { placeholderObjectApiName: 'Pricebook2' },
        ],
      } as unknown as FrozenLoadPlanInfo),
    ).toEqual(['Account', 'Order', 'Contract', 'Pricebook2']);
  });

  it('reads the objects a dataset holds records of from its manifest, else from its files', () => {
    expect(datasetObjectsOf(datasetDir)).toEqual(['Account', 'Contact']);
    writeFileSync(join(datasetDir, 'manifest.json'), JSON.stringify({ version: '1.4.0' }));
    expect(datasetObjectsOf(datasetDir)).toEqual(['Account', 'Contact']);
    expect(datasetObjectsOf(join(sasDir, 'none'))).toEqual([]);
  });

  it('takes a load for one that wrote by its report, and by its error unless that says it wrote nothing', () => {
    const reported = (report: Record<string, unknown>) =>
      frozenLoadWrote([{ type: 'frozen:load:response', payload: { report } }]);
    const base = {
      perObject: [{ objectApiName: 'Account', inserted: 0 }],
      placeholders: [],
      purge: { deleted: {}, deactivated: {} },
    };
    expect(reported(base)).toBe(false);
    expect(reported({ ...base, perObject: [{ objectApiName: 'Account', inserted: 1 }] })).toBe(
      true,
    );
    expect(reported({ ...base, purge: { deleted: { Account: 2 }, deactivated: {} } })).toBe(true);
    expect(reported({ ...base, placeholders: [{ placeholderObjectApiName: 'Account' }] })).toBe(
      true,
    );

    const failed = (code: string) =>
      frozenLoadWrote([{ type: 'frozen:load:error', payload: { code } }]);
    expect(failed('REPLACE_LEAVES_RECORDS')).toBe(false);
    expect(failed('MUTE_NO_RIGHT')).toBe(false);
    // Stopped or failed part way: what it wrote is not told, and the checkpoint is kept.
    expect(failed('LOAD_CANCELLED')).toBe(true);
    expect(failed('LOAD_ERROR')).toBe(true);
  });
});
