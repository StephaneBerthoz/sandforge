/**
 * The checkpoint a run of `sandforge-sync` takes of what it writes before its
 * first write (`--checkpoint-first`), through the real orchestrator over a
 * pair of fake orgs: when it is taken, what a dry run says of it, and what
 * becomes of it, each step of the run counted in the order it was made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Connection } from 'jsforce';
import type {
  ForgeTargetAutomation,
  MutedAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
  SyncSimulationResult,
} from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({
    alias,
    username: `${alias}@example.invalid`,
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
  })),
  makeConn: vi.fn(),
}));
// What the target runs, as the reader the clone's command reads it with
// would answer it: given by each test.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: () => ({ read: readAutomation }),
}));
// The checkpoint the run takes first and the mute's lease, as the run asks
// them: each tested on its own, here in the order the run calls them.
vi.mock('./beforeRunCheckpoint.js', async (original) => {
  const actual = await original<typeof import('./beforeRunCheckpoint.js')>();
  return { ...actual, commandCheckpoints: vi.fn(actual.commandCheckpoints) };
});
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { makeConn } from './sfSession.js';
import {
  commandCheckpoints,
  type CommandCheckpointAsk,
  type CommandCheckpoints,
} from './beforeRunCheckpoint.js';
import {
  inTheCommandsWords,
  main,
  parseArgs,
  parseRemoveArgs,
  readRunSummary,
} from './sandforge-sync.js';
import {
  BEFORE_RUN_DELETED_WORDS,
  writePathOrderDefects,
  type BeforeRunTake,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { CHECKPOINT_STOPPED_WORDS } from '../src/modules/forge/ForgeRunGate.js';
import { MuteRefusedError, muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { readRunFile } from '../src/modules/sync/SyncRunCreations.js';

/** What the checkpoint of the run would hold and cost, as its scope says. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 30, apiRequests: 68, apiRequestsLeft: 14_000, seconds: 12, bytes: 60_000 },
  objects: ['Account'],
  added: [],
  notHeld: [],
  keepDays: 7,
};
/** The checkpoint the take keeps. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-110000-c3d4',
  name: 'Before Sync run 2026-11-01 11:00 UTC',
  takenAt: '2026-11-01T11:00:04.000Z',
  expiresAt: '2026-11-08T11:00:00.000Z',
  objects: ['Account'],
  records: 30,
  bytes: 60_000,
  requests: 66,
  added: [],
  notHeld: [],
};

/** What the target runs on the objects a run writes. */
function automationOf(objects: ForgeTargetAutomation['objects']): ForgeTargetAutomation {
  return {
    objectsRead: objects.map((o) => o.objectApiName),
    objects,
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };
}

/** A flow of the target that creates a task for each account it inserts. */
const ACCOUNT_TASK = automationOf([
  {
    objectApiName: 'Account',
    flows: [
      {
        apiName: 'Account_Task',
        label: 'Account task',
        timing: 'afterSave',
        startsOn: 'create',
        condition: 'read',
        permissions: [],
        creates: ['Task'],
      },
    ],
    triggers: [],
  },
]);

/** The command line, after the script's own two words. */
const argv = (...rest: string[]): string[] => [
  'node',
  'sandforge-sync.ts',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--object',
  'Account',
  ...rest,
];

/** The two accounts of the source. */
const ACCOUNTS = [
  { Id: '001000000000001AAA', Name: 'One' },
  { Id: '001000000000002AAA', Name: 'Two' },
];

/** A field as the fake orgs describe it. */
const field = (name: string, type: string, over: Record<string, unknown> = {}) => ({
  name,
  type,
  createable: true,
  updateable: true,
  queryable: true,
  nillable: true,
  defaultedOnCreate: false,
  length: 80,
  referenceTo: [],
  picklistValues: [],
  ...over,
});

const DESCRIBED = {
  name: 'Account',
  createable: true,
  updateable: true,
  recordTypeInfos: [],
  fields: [field('Id', 'id', { createable: false, updateable: false }), field('Name', 'string')],
};

/** The account's types in a target that has one besides Master, the user's default. */
const RECORD_TYPES = [
  {
    recordTypeId: '012000000000000AAA',
    developerName: 'Master',
    name: 'Master',
    available: true,
    active: true,
    master: true,
    defaultRecordTypeMapping: false,
  },
  {
    recordTypeId: '012000000000001AAA',
    developerName: 'Partner',
    name: 'Partner',
    available: true,
    active: true,
    master: false,
    defaultRecordTypeMapping: true,
  },
];

/** Who the session is, as the target says: asked once of a run that writes. */
const whoIsAsked = vi.fn(async () => ({ user_id: '005000000000007AAA' }));

/**
 * A source and a sandbox target of accounts, with room to spare unless
 * `limits` says; each write to the target in `events`, each refused when
 * `refuse` says. With `recordTypes` the target's accounts have a type besides
 * Master: its describes once a lease is held and its read of the types the
 * records were given go in `events` too.
 */
function orgs(
  events: string[],
  limits?: Record<string, unknown>,
  refuse = false,
  recordTypes = false,
): void {
  const page = (records: unknown[]) => ({ records, totalSize: records.length, done: true });
  const conn = (side: 'source' | 'target') => ({
    version: '66.0',
    query: async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true }]);
      }
      if (soql.startsWith('SELECT RecordTypeId, COUNT(Id) n')) {
        events.push('read back');
        return page([{ RecordTypeId: '012000000000001AAA', n: 2 }]);
      }
      if (/COUNT\(\)/.test(soql)) {
        return { records: [], totalSize: side === 'source' ? ACCOUNTS.length : 0, done: true };
      }
      if (soql.includes('FROM Account')) return page(side === 'source' ? ACCOUNTS : []);
      return page([]);
    },
    queryMore: async () => page([]),
    sobject: () => ({
      describe: async () => {
        if (side === 'target' && recordTypes && events.includes('lease')) {
          events.push('described again');
        }
        return recordTypes && side === 'target'
          ? { ...DESCRIBED, recordTypeInfos: RECORD_TYPES }
          : DESCRIBED;
      },
      create: async (records: unknown[]) => {
        events.push('write');
        return records.map((_, i) =>
          refuse
            ? {
                success: false,
                errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'No.' }],
              }
            : { id: `001${String(i + 10).padStart(12, '0')}AAA`, success: true, errors: [] },
        );
      },
    }),
    describe: async () => DESCRIBED,
    tooling: { query: async () => page([]), queryMore: async () => page([]) },
    // Who the session is, asked as jsforce asks it of a connection that has
    // not before: the API's root, then the identity URL, each a request.
    async identity(this: { request: (url: string) => Promise<unknown> }) {
      await this.request('/');
      await this.request('/id');
      return whoIsAsked();
    },
    request: async (request: string | { url: string }) =>
      request === '/' || request === '/id'
        ? {}
        : (limits ?? {
            DataStorageMB: { Max: 200, Remaining: 150 },
            DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
            SingleEmail: { Max: 15, Remaining: 15 },
          }),
  });
  const source = conn('source');
  const target = conn('target');
  vi.mocked(makeConn).mockImplementation(
    (session) => (session.alias === 'SRC' ? source : target) as unknown as Connection,
  );
}

/** The checkpoint the run asks for, each call in `events`: its scope answers `estimate`, its take `take`. */
function checkpointsOf(
  events: string[],
  options: {
    estimate?: Partial<RunCheckpointEstimate>;
    scopeFails?: string;
    take?: BeforeRunTake;
  } = {},
) {
  const asked: CommandCheckpointAsk[] = [];
  const port: CommandCheckpoints = {
    scope: vi.fn(async (ask: CommandCheckpointAsk) => {
      asked.push(ask);
      events.push('scope');
      if (options.scopeFails !== undefined) throw new Error(options.scopeFails);
      return { ...ESTIMATE, ...options.estimate };
    }),
    take: vi.fn(async () => {
      events.push('take');
      return options.take ?? { taken: true as const, checkpoint: TAKEN };
    }),
    settle: vi.fn(async (taken: RunCheckpointTaken, wrote: boolean) => {
      events.push(`settle ${String(wrote)}`);
      return wrote ? taken : { state: 'deleted' as const, deleted: 'nothingWritten' as const };
    }),
  };
  vi.mocked(commandCheckpoints).mockReturnValue(port);
  return { port, asked };
}

/** A mute whose lease holds one set, each acquire and release in `events`; refused when `refused` says. */
function muteOf(events: string[], refused = false): void {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Bypass_Flow'],
    silenced: [],
    stillRan: [],
  };
  vi.mocked(muteForRun).mockImplementation((async () => {
    events.push('lease plan');
    return {
      automation: automationOf([{ objectApiName: 'Account', flows: [], triggers: [] }]),
      muted,
      prepared: {
        acquire: async () => {
          events.push('lease');
          if (refused) {
            throw new MuteRefusedError({ code: 'MUTE_FAILED', message: 'The set was refused.' });
          }
          // Once is enough, and again answers the same, as a lease does: the
          // run gives it back after its last write, its command as it ends.
          let released = false;
          return {
            outcome: muted,
            release: async () => {
              if (!released) events.push('release');
              released = true;
              return { ...muted, released: true };
            },
          };
        },
      },
    };
  }) as never);
}

/** Thrown where the command would exit: a test reads the code. */
class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

describe('sandforge-sync --checkpoint-first', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as never);
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(automationOf([]));
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
    vi.mocked(commandCheckpoints).mockReset();
  });

  /** The exit code `main` ends on, once it has. */
  const exitOf = async (line: string[]): Promise<number | undefined> => {
    try {
      await main(line);
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    } catch (thrown: unknown) {
      if (thrown instanceof Exited) return thrown.code;
      throw thrown;
    }
  };

  it('takes it once the gate let the run through, before the lease and the first write, and keeps it once the run wrote', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events);
    muteOf(events);

    expect(await exitOf(argv('--mute-automation', '--checkpoint-first', '--json'))).toBe(0);

    expect(events).toEqual([
      'lease plan',
      'scope',
      'take',
      'lease',
      'write',
      'release',
      'settle true',
    ]);
    // The flags stand for the question a command line is never asked.
    const steps = events.map((event): WritePathStep => {
      if (event === 'lease plan') return 'leasePlan';
      if (event === 'scope') return 'stillRunning';
      if (event === 'take') return 'checkpointTake';
      if (event === 'lease') return 'leaseAcquire';
      if (event === 'release') return 'leaseRelease';
      if (event === 'write') return 'write';
      return 'result';
    });
    expect(writePathOrderDefects(['reads', ...steps])).toEqual([]);
    const summary = JSON.parse(out.join('')) as { checkpoint: RunCheckpointTaken };
    expect(summary.checkpoint).toEqual(TAKEN);
    expect(err.join('')).toContain(
      `checkpoint before the run: ${TAKEN.checkpointId} '${TAKEN.name}', 1 object(s), 30 ` +
        'record(s), kept until 2026-11-08',
    );
    expect(err.join('')).toContain(
      `  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ${TAKEN.checkpointId} ` +
        '--mute-automation',
    );
    expect(vi.mocked(commandCheckpoints).mock.calls[0][0]).toMatchObject({
      module: 'sync',
      request: {},
      org: { id: '00D000000000002AAA', orgType: 'Sandbox' },
      own: { runId: vi.mocked(commandCheckpoints).mock.calls[0][0].operationId },
    });
  });

  it('hands the run the lease the gate took: the record types read again under it, given back after the last write and before they are read back', async () => {
    const events: string[] = [];
    orgs(events, undefined, false, true);
    checkpointsOf(events);
    muteOf(events);

    expect(await exitOf(argv('--mute-automation', '--checkpoint-first', '--json'))).toBe(0);

    expect(events).toEqual([
      'lease plan',
      'scope',
      'take',
      'lease',
      'described again',
      'write',
      'release',
      'read back',
      'settle true',
    ]);
    const steps: Record<string, WritePathStep> = {
      'lease plan': 'leasePlan',
      scope: 'stillRunning',
      take: 'checkpointTake',
      lease: 'leaseAcquire',
      'described again': 'afterLeaseCheck',
      write: 'write',
      release: 'leaseRelease',
      'read back': 'recordTypeReadBack',
      'settle true': 'result',
    };
    expect(writePathOrderDefects(events.map((event) => steps[event] as WritePathStep))).toEqual([]);
    expect(JSON.parse(out.join('')).result.mutedAutomation).toMatchObject({ released: true });
  });

  it('counts the record types it reads back with the requests of the checkpoint', async () => {
    orgs([], undefined, false, true);
    checkpointsOf([]);

    await exitOf(argv('--checkpoint-first', '--dry-run', '--json'));

    const printed = JSON.parse(out.join('')) as { simulation: SyncSimulationResult };
    // The run's call, the read back and the checkpoint's 68; and what the
    // command sent the target before its gate — its limits, read once —, and
    // who a run writes as, which the dry run does not ask.
    expect(printed.simulation.writeCheck?.apiRequests?.estimate).toBe(70 + 1 + 2);
  });

  it('names the checkpoint in the run’s file, which outlives the run', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events);

    await exitOf(argv('--checkpoint-first', '--json'));

    const { created } = JSON.parse(out.join('')) as { created: { runFile: string } };
    const kept = readRunFile(readFileSync(created.runFile, 'utf8'));
    expect(kept?.checkpoint).toEqual(TAKEN);
  });

  it('holds what the flows that still run create, from the objects it counted', async () => {
    const events: string[] = [];
    orgs(events);
    readAutomation.mockResolvedValue(ACCOUNT_TASK);
    const { asked } = checkpointsOf(events);

    await exitOf(argv('--checkpoint-first'));

    expect(asked).toHaveLength(1);
    expect(asked[0].written).toEqual(['Account']);
    expect(asked[0].running.firing.map((entry) => [entry.name, entry.flow?.creates])).toEqual([
      ['Account task', ['Task']],
    ]);
  });

  it('takes its days and the objects it leaves out to the checkpoint', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events);

    await exitOf(
      argv(
        '--checkpoint-first',
        '--checkpoint-keep-days',
        '30',
        '--checkpoint-exclude-object',
        'Task',
      ),
    );

    expect(vi.mocked(commandCheckpoints).mock.calls[0][0].request).toEqual({
      keepDays: 30,
      excluded: ['Task'],
    });
  });

  it('says with --dry-run what it would hold and cost, gives it under checkpoint, counts its requests, and takes nothing', async () => {
    const events: string[] = [];
    orgs(events);
    const { port } = checkpointsOf(events);
    whoIsAsked.mockClear();

    expect(await exitOf(argv('--checkpoint-first', '--dry-run', '--json'))).toBe(0);

    expect(events).toEqual(['scope']);
    expect(port.take).not.toHaveBeenCalled();
    // Nothing is written to hold to the user it writes as.
    expect(whoIsAsked).not.toHaveBeenCalled();
    const printed = JSON.parse(out.join('')) as {
      checkpoint: RunCheckpointEstimate;
      simulation: SyncSimulationResult;
    };
    expect(printed.checkpoint).toEqual(ESTIMATE);
    expect(printed.simulation.checkpoint).toEqual(ESTIMATE);
    // One call of the run's two accounts, and the checkpoint's 68; its
    // limits, read once, and who a run writes as.
    expect(printed.simulation.writeCheck?.apiRequests?.estimate).toBe(69 + 1 + 2);
    expect(printed.simulation.writeCheck?.verdict).toBe('asks');
  });

  it('says in the lines of a dry run what it would hold, without a word of a take', async () => {
    orgs([]);
    checkpointsOf([]);

    await exitOf(argv('--checkpoint-first', '--dry-run'));

    expect(out.join('')).toContain(
      '  Checkpoint first: about 30 records of 1 object, 68 API requests, 12 s, 0.1 MB on this ' +
        "machine, unencrypted, and none of the org's storage, kept 7 days.",
    );
    expect(out.join('')).not.toContain('checkpoint before the run:');
  });

  it('scopes a dry run on what still runs once the mute it asks for holds', async () => {
    const events: string[] = [];
    orgs(events);
    readAutomation.mockResolvedValue(ACCOUNT_TASK);
    muteOf(events);
    const { asked } = checkpointsOf(events);

    await exitOf(argv('--mute-automation', '--checkpoint-first', '--dry-run', '--json'));

    expect(events).toEqual(['lease plan', 'scope']);
    expect(asked[0].running.firing).toEqual([]);
    expect(JSON.parse(out.join('')).mutedAutomation).toMatchObject({ assigned: ['PS_Bypass'] });
  });

  it("says with --dry-run that a real run would be refused past the target's daily API requests, the checkpoint's part counted", async () => {
    const limits = {
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 40 },
    };
    orgs([], limits);
    checkpointsOf([]);

    await exitOf(argv('--checkpoint-first', '--dry-run'));

    expect(out.join('')).toContain(
      'a run would be refused before it writes (API_BUDGET_EXCEEDED): it takes more API ' +
        'requests than the target has left today',
    );

    // Without it, the run's own requests fit.
    out.length = 0;
    orgs([], limits);
    await exitOf(argv('--dry-run'));
    expect(out.join('')).not.toContain('a run would be refused');
  });

  it.each([
    [
      'the daily API requests, the checkpoint’s counted',
      {
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 40 },
      },
      'API_BUDGET_EXCEEDED',
    ],
    [
      'the data storage',
      {
        DataStorageMB: { Max: 200, Remaining: 0 },
        DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
      },
      'SYNC_STORAGE_EXCEEDED',
    ],
  ])(
    'gives with --dry-run --json, under wouldBeRefused, the refusal past %s that a real run meets',
    async (_label, limits, code) => {
      // The lines said it; the key a pipeline reads did not, and the run exited 1.
      orgs([], limits);
      checkpointsOf([]);
      await exitOf(argv('--checkpoint-first', '--dry-run', '--json'));
      const dry = JSON.parse(out.join('')) as {
        wouldBeRefused?: string[];
        wouldBeRefusedCodes?: string[];
      };

      out.length = 0;
      orgs([], limits);
      checkpointsOf([]);
      expect(await exitOf(argv('--checkpoint-first', '--json'))).toBe(1);
      const real = JSON.parse(out.join('')) as { refused: { code: string; message: string } };

      expect(real.refused.code).toBe(code);
      expect(dry.wouldBeRefused).toEqual([real.refused.message]);
      // Its code beside it: the words alone, a pipeline could not tell them apart.
      expect(dry.wouldBeRefusedCodes).toEqual([real.refused.code]);
    },
  );

  it('refuses a run past the requests the target has left, the checkpoint among them, before the take', async () => {
    const events: string[] = [];
    orgs(events, {
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 40 },
    });
    checkpointsOf(events);

    expect(await exitOf(argv('--checkpoint-first'))).toBe(1);

    expect(events).toEqual(['scope']);
    expect(out.join('')).toContain('(68 of them for the checkpoint taken first)');
  });

  it('says with --dry-run the refusal a real run would meet, in the command’s words', async () => {
    const events: string[] = [];
    orgs(events);
    const refusal = { code: 'RUN_WRITING' as const, message: 'A SandForge run is writing to TGT.' };
    checkpointsOf(events, { estimate: { refusal } });

    await exitOf(argv('--checkpoint-first', '--dry-run'));

    expect(out.join('')).toContain(
      'a run would be refused before it writes (CHECKPOINT_REFUSED): The checkpoint before the ' +
        'run was refused: A SandForge run is writing to TGT. Fix what refuses it, or run without ' +
        '--checkpoint-first to write without one.',
    );

    out.length = 0;
    await exitOf(argv('--checkpoint-first', '--dry-run', '--json'));
    expect(JSON.parse(out.join('')).wouldBeRefused).toEqual([
      'The checkpoint before the run was refused: A SandForge run is writing to TGT. Fix what ' +
        'refuses it, or run without --checkpoint-first to write without one.',
    ]);
    expect(JSON.parse(out.join('')).wouldBeRefusedCodes).toEqual(['CHECKPOINT_REFUSED']);
  });

  it('names with --dry-run the code of a mute a real run would be refused, on its line and beside its words', async () => {
    orgs([]);
    vi.mocked(muteForRun).mockRejectedValue(
      new MuteRefusedError({ code: 'MUTE_NO_RIGHT', message: 'The user cannot assign.' }),
    );

    await exitOf(argv('--mute-automation', '--dry-run'));
    expect(out.join('')).toContain(
      'a real run would be refused (MUTE_NO_RIGHT): The user cannot assign.\n',
    );

    out.length = 0;
    await exitOf(argv('--mute-automation', '--dry-run', '--json'));
    const dry = JSON.parse(out.join('')) as {
      wouldBeRefused?: string[];
      wouldBeRefusedCodes?: string[];
    };
    expect(dry.wouldBeRefused).toEqual(['The user cannot assign.']);
    expect(dry.wouldBeRefusedCodes).toEqual(['MUTE_NO_RIGHT']);
  });

  it('refuses a real run its mute refuses for each reason of its gate too, under alsoRefused, as its dry run names them', async () => {
    // Refused for its mute, a run said that code alone, and a CI job that
    // answered it was refused again for its checkpoint.
    const events: string[] = [];
    orgs(events);
    const refusal = { code: 'RUN_WRITING' as const, message: 'A SandForge run is writing to TGT.' };
    checkpointsOf(events, { estimate: { refusal } });
    vi.mocked(muteForRun).mockRejectedValue(
      new MuteRefusedError({ code: 'MUTE_NO_RIGHT', message: 'The user cannot assign.' }),
    );

    expect(await exitOf(argv('--mute-automation', '--checkpoint-first', '--json'))).toBe(1);

    const real = JSON.parse(out.join('')) as {
      refused: { code: string };
      alsoRefused?: Array<{ code: string; message: string }>;
    };
    expect(real.refused.code).toBe('MUTE_NO_RIGHT');
    expect(real.alsoRefused).toEqual([
      {
        code: 'CHECKPOINT_REFUSED',
        message:
          'The checkpoint before the run was refused: A SandForge run is writing to TGT. Fix ' +
          'what refuses it, or run without --checkpoint-first to write without one. Nothing ' +
          'was written.',
      },
    ]);
    expect(events).not.toContain('take');
    expect(events).not.toContain('write');

    out.length = 0;
    await exitOf(argv('--mute-automation', '--checkpoint-first', '--dry-run', '--json'));
    expect(JSON.parse(out.join('')).wouldBeRefusedCodes).toEqual([
      'MUTE_NO_RIGHT',
      'CHECKPOINT_REFUSED',
    ]);
  });

  it('says with --dry-run that a scope it could not read would refuse a real run', async () => {
    orgs([]);
    checkpointsOf([], { scopeFails: 'the store is locked' });

    await exitOf(argv('--checkpoint-first', '--dry-run', '--json'));

    expect(JSON.parse(out.join('')).wouldBeRefused).toEqual([
      expect.stringContaining('the store is locked'),
    ]);
  });

  it('gives first with --dry-run what a real run is refused with first: an object the target takes none of, before its checkpoint', async () => {
    // The contacts go by an upsert on Name, which the target matches none on;
    // the accounts are written. Listed after the checkpoint, the code a
    // pipeline read first was not the one the run was refused with.
    orgs([]);
    const contacts = [{ Id: '003000000000001AAA', Name: 'One' }];
    // As the org's describe says it: Contact.Name is no key of an upsert.
    const contact = {
      ...DESCRIBED,
      name: 'Contact',
      fields: [
        field('Id', 'id', { createable: false, updateable: false, idLookup: true }),
        field('Name', 'string', { idLookup: false, externalId: false }),
      ],
    };
    const conns = vi.mocked(makeConn).getMockImplementation();
    vi.mocked(makeConn).mockImplementation((session) => {
      const conn = conns?.(session) as unknown as {
        query: (soql: string) => Promise<{ records: unknown[]; totalSize: number; done: true }>;
        sobject: (name: string) => Record<string, unknown>;
        describe: (name: string) => Promise<unknown>;
      };
      const query = conn.query.bind(conn);
      const sobject = conn.sobject.bind(conn);
      const describe = conn.describe.bind(conn);
      return {
        ...conn,
        query: async (soql: string) =>
          soql.includes('FROM Contact') && session.alias === 'SRC'
            ? /COUNT\(\)/.test(soql)
              ? { records: [], totalSize: contacts.length, done: true }
              : { records: contacts, totalSize: contacts.length, done: true }
            : query(soql),
        sobject: (name: string) =>
          name === 'Contact' ? { ...sobject(name), describe: async () => contact } : sobject(name),
        describe: async (name: string) => (name === 'Contact' ? contact : describe(name)),
      } as unknown as Connection;
    });
    const contactsByName = ['--object', 'Contact:Name', '--checkpoint-first'];
    checkpointsOf([], { scopeFails: 'the store is locked' });

    await exitOf(argv(...contactsByName, '--dry-run', '--json'));
    const dry = JSON.parse(out.join('')) as { wouldBeRefusedCodes?: string[] };
    out.length = 0;
    expect(await exitOf(argv(...contactsByName, '--json'))).toBe(1);
    const real = JSON.parse(out.join('')) as { refused: { code: string } };

    expect(real.refused.code).toBe('SYNC_TARGET_UNWRITABLE');
    expect(dry.wouldBeRefusedCodes).toEqual(['SYNC_TARGET_UNWRITABLE', 'CHECKPOINT_REFUSED']);
  });

  it('refuses the run before the take, the lease and any write when its scope is refused, exit 1, in the command’s words', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events, {
      estimate: {
        refusal: {
          code: 'RUN_WRITING',
          message: 'A SandForge run is writing to TGT. No record was read.',
        },
      },
    });
    muteOf(events);

    expect(await exitOf(argv('--mute-automation', '--checkpoint-first'))).toBe(1);

    expect(events).toEqual(['lease plan', 'scope']);
    expect(out.join('')).toContain(
      'refused (CHECKPOINT_REFUSED): The checkpoint before the run was refused: A SandForge run ' +
        'is writing to TGT. Fix what refuses it, or run without --checkpoint-first to write ' +
        'without one. Nothing was written.',
    );
  });

  it('refuses the run when its scope cannot be read, nothing taken and nothing written', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events, { scopeFails: 'the store is locked' });

    expect(await exitOf(argv('--checkpoint-first'))).toBe(1);

    expect(events).toEqual(['scope']);
    expect(out.join('')).toContain('the store is locked');
  });

  it('writes nothing and takes no lease when the take is refused, exit 1, and says why under --json', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events, {
      take: { taken: false, refusal: { code: 'DISK', message: 'Too little room.' } },
    });
    muteOf(events);

    expect(await exitOf(argv('--mute-automation', '--checkpoint-first', '--json'))).toBe(1);

    expect(events).toEqual(['lease plan', 'scope', 'take']);
    expect(JSON.parse(out.join('')).refused).toEqual({
      code: 'CHECKPOINT_REFUSED',
      message:
        'The checkpoint before the run was refused: Too little room. Fix what refuses it, leave ' +
        'an object out of it (--checkpoint-exclude-object <ApiName>), or run without ' +
        '--checkpoint-first to write without one. Nothing was written.',
    });
  });

  it('prints, refused, a summary --remove reads as a run that wrote nothing', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events, {
      take: { taken: false, refusal: { code: 'DISK', message: 'Too little room.' } },
    });

    expect(await exitOf(argv('--checkpoint-first', '--json'))).toBe(1);

    expect(readRunSummary(out.join(''))).toEqual({
      refusal:
        'is the summary of a run refused before its first write (CHECKPOINT_REFUSED), which ' +
        'wrote nothing to the target: there is nothing of it to remove.',
    });
  });

  it('writes nothing when the take fails, exit 1, and keeps no checkpoint', async () => {
    const events: string[] = [];
    orgs(events);
    const { port } = checkpointsOf(events);
    vi.mocked(port.take).mockRejectedValue(new Error('the disk went away'));

    expect(await exitOf(argv('--checkpoint-first'))).toBe(1);

    expect(events).toEqual(['scope']);
    expect(out.join('')).toContain('the disk went away');
    expect(port.settle).not.toHaveBeenCalled();
  });

  it('deletes the checkpoint of a run whose lease was refused after the take, before any write, exit 1', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events);
    muteOf(events, true);

    expect(await exitOf(argv('--mute-automation', '--checkpoint-first', '--json'))).toBe(1);

    expect(events).toEqual(['lease plan', 'scope', 'take', 'lease', 'settle false']);
    const printed = JSON.parse(out.join('')) as {
      refused: { message: string };
      checkpoint: unknown;
    };
    expect(printed.refused.message).toBe('The set was refused.');
    expect(printed.checkpoint).toEqual({ state: 'deleted', deleted: 'nothingWritten' });
    expect(err.join('')).toContain(BEFORE_RUN_DELETED_WORDS);
  });

  it('keeps the checkpoint of a run the target refused every record of: it sent them', async () => {
    const events: string[] = [];
    orgs(events, undefined, true);
    checkpointsOf(events);

    await exitOf(argv('--checkpoint-first', '--json'));

    expect(events.at(-1)).toBe('settle true');
    expect(JSON.parse(out.join('')).checkpoint).toEqual(TAKEN);
  });

  it('deletes the checkpoint of a run stopped after the take and before its first write', async () => {
    const events: string[] = [];
    orgs(events);
    const { port } = checkpointsOf(events);
    vi.mocked(port.take).mockImplementation(async () => {
      events.push('take');
      process.emit('SIGINT', 'SIGINT');
      return { taken: true as const, checkpoint: TAKEN };
    });

    expect(await exitOf(argv('--checkpoint-first', '--json'))).toBe(130);

    expect(events).toEqual(['scope', 'take', 'settle false']);
    expect(JSON.parse(out.join('')).checkpoint).toEqual({
      state: 'deleted',
      deleted: 'nothingWritten',
    });
  });

  it('stops at Ctrl-C during the take with nothing kept and nothing written, and exits 130', async () => {
    const events: string[] = [];
    orgs(events);
    const { port } = checkpointsOf(events, { take: { taken: false, stopped: true } });

    expect(await exitOf(argv('--checkpoint-first'))).toBe(130);

    expect(events).toEqual(['scope', 'take']);
    expect(out.join('')).toContain(CHECKPOINT_STOPPED_WORDS);
    expect(port.settle).not.toHaveBeenCalled();
  });

  it('reads the option on a run of a saved configuration too', () => {
    expect(
      parseArgs([
        'node',
        'sandforge-sync.ts',
        '--config-file',
        'config.json',
        '--store',
        'store',
        '--source',
        'SRC',
        '--target',
        'TGT',
        '--checkpoint-first',
      ]).checkpointFirst,
    ).toEqual({});
  });

  it('reads the option, its days and the objects it leaves out', () => {
    expect(parseArgs(argv()).checkpointFirst).toBeUndefined();
    expect(
      parseArgs(
        argv(
          '--checkpoint-first',
          '--checkpoint-keep-days',
          '30',
          '--checkpoint-exclude-object',
          'Task',
        ),
      ).checkpointFirst,
    ).toEqual({ keepDays: 30, excluded: ['Task'] });
  });

  it('refuses, exit 2, a flag of the option without its switch', () => {
    expect(() => parseArgs(argv('--checkpoint-keep-days', '3'))).toThrow(Exited);
    expect(err.join('')).toContain('--checkpoint-keep-days goes with --checkpoint-first');
  });

  it('refuses the option on a removal, exit 2: a removal takes back, it writes no run', () => {
    expect(() =>
      parseRemoveArgs([
        'node',
        'sandforge-sync.ts',
        '--remove',
        'summary.json',
        '--target',
        'TGT',
        '--checkpoint-first',
      ]),
    ).toThrow(Exited);
    expect(err.join('')).toContain('not "--checkpoint-first"');
  });

  it('says the option in its --help', () => {
    expect(() => parseArgs(['node', 'sandforge-sync.ts', '--help'])).toThrow(Exited);
    const help = out.join('');
    expect(help).toContain('--checkpoint-first     take a checkpoint of what the run writes');
    expect(help).toContain('--checkpoint-keep-days <n>');
    expect(help).toContain('--checkpoint-exclude-object <ApiName>');
    // Exit 1, as the refusals of a run that asks them exit.
    const exits = help.slice(help.indexOf('Exit codes')).replace(/\s+/g, ' ');
    expect(exits).toContain('API requests');
    expect(exits).toContain('(EMAILS_NOT_ACCEPTED)');
    expect(exits).toContain('(CHECKPOINT_REFUSED)');
  });
});

describe('a gate’s answer, as the command says it', () => {
  it('says a checkpoint refused in the command’s words, the take’s refusal kept', () => {
    const refusal = { code: 'DISK' as const, message: 'Too little room. No record was read.' };

    expect(
      inTheCommandsWords({ go: false, code: 'CHECKPOINT_REFUSED', message: 'panel', refusal }),
    ).toEqual({
      go: false,
      code: 'CHECKPOINT_REFUSED',
      refusal,
      message:
        'The checkpoint before the run was refused: Too little room. Fix what refuses it, leave ' +
        'an object out of it (--checkpoint-exclude-object <ApiName>), or run without ' +
        '--checkpoint-first to write without one. Nothing was written.',
    });
  });

  it('leaves a take that failed, which no refusal words, as the take said it', () => {
    const answer = { go: false as const, code: 'CHECKPOINT_REFUSED' as const, message: 'failed' };

    expect(inTheCommandsWords(answer)).toEqual(answer);
  });

  it('leaves every other answer as it is', () => {
    const go = { go: true as const, asked: false };
    const over = { go: false as const, code: 'SYNC_STORAGE_EXCEEDED' as const, message: 'full' };

    expect(inTheCommandsWords(go)).toBe(go);
    expect(inTheCommandsWords(over)).toBe(over);
  });
});
