/**
 * The checkpoint a run of `sandforge-seed` takes of what it writes before its
 * first write (`--checkpoint-first`), through the real orchestrator over a
 * fake org: when it is taken, what a dry run says of it, what it does to a
 * fit, and what becomes of it, each step of the run counted in the order it
 * was made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type {
  ForgeTargetAutomation,
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
    username: `${alias}@example.invalid`,
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
  })),
  makeConn: vi.fn(),
}));

/** Every step a run makes, in the order it makes it. */
const steps: string[] = [];
/** What the target runs on the objects read, as the tests set it. */
let automationOf: (objects: readonly string[]) => ForgeTargetAutomation;

vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async (_target: string, objects: readonly string[]) => {
      steps.push('automation read');
      return automationOf(objects);
    },
  })),
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
import { main, parseArgs, parseRemoveArgs } from './sandforge-seed.js';
import {
  BEFORE_RUN_DELETED_WORDS,
  writePathOrderDefects,
  type BeforeRunTake,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { CHECKPOINT_STOPPED_WORDS } from '../src/modules/forge/ForgeRunGate.js';
import { MuteRefusedError, muteForRun } from '../src/modules/forge/AutomationMuteLease.js';

/** What the checkpoint of the seed would hold and cost, as its scope says. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 30, apiRequests: 68, apiRequestsLeft: 14_000, seconds: 12, bytes: 60_000 },
  objects: ['Account', 'Contact'],
  added: [],
  notHeld: [],
  keepDays: 7,
};
/** The checkpoint the take keeps. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-110000-c3d4',
  name: 'Before Seed run 2026-11-01 11:00 UTC',
  takenAt: '2026-11-01T11:00:04.000Z',
  expiresAt: '2026-11-08T11:00:00.000Z',
  objects: ['Account', 'Contact'],
  records: 30,
  bytes: 60_000,
  requests: 66,
  added: [],
  notHeld: [],
};
const REFUSAL = {
  code: 'RUN_WRITING' as const,
  message: 'A SandForge run is writing to TGT. No record was read.',
};
/** The refusal above in the command's words. */
const REFUSED_WORDS =
  'The checkpoint before the run was refused: A SandForge run is writing to TGT. Fix what ' +
  'refuses it, or run without --checkpoint-first to write without one. Nothing was written.';

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

/** A target that runs nothing on what is read. */
const quiet = (objects: readonly string[]): ForgeTargetAutomation => ({
  objectsRead: [...objects],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 1,
});

/** A target whose account flow creates a Task under each account created, which nothing keeps quiet. */
const creating = (objects: readonly string[]): ForgeTargetAutomation => ({
  ...quiet(objects),
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
          permissions: [],
          creates: ['Task'],
        },
      ],
      triggers: [],
    },
  ],
});

/**
 * A sandbox of `maxMB` of data storage, all of it left, with `requests`
 * daily API requests left, that takes every record it is sent through REST,
 * or refuses each when `refuse` says, and puts each step down in `steps`.
 */
function fakeOrg(maxMB = 200, requests = 15_000, refuse = false): void {
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  vi.mocked(makeConn).mockReturnValue({
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (sent: unknown[]) => {
        steps.push(`write ${name}`);
        return sent.map(() =>
          refuse
            ? { success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'No.' }] }
            : { success: true, id: `001${String(made++).padStart(12, '0')}AAA` },
        );
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
        DailyApiRequests: { Max: 15_000, Remaining: requests },
        SingleEmail: { Max: 15, Remaining: 15 },
      };
    },
  } as unknown as Connection);
}

/** The checkpoint the run asks for, each call in `steps`: its scope answers `estimate`, its take `take`. */
function checkpointsOf(
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
      steps.push('scope');
      if (options.scopeFails !== undefined) throw new Error(options.scopeFails);
      return { ...ESTIMATE, ...options.estimate };
    }),
    take: vi.fn(async () => {
      steps.push('take');
      return options.take ?? { taken: true as const, checkpoint: TAKEN };
    }),
    settle: vi.fn(async (taken: RunCheckpointTaken, wrote: boolean) => {
      steps.push(`settle ${String(wrote)}`);
      return wrote ? taken : { state: 'deleted' as const, deleted: 'nothingWritten' as const };
    }),
  };
  vi.mocked(commandCheckpoints).mockReturnValue(port);
  return { port, asked };
}

/** A mute whose lease holds one set, each acquire and release in `steps`; refused when `refused` says. */
function muteOf(refused = false): void {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Bypass_Flow'],
    silenced: [],
    stillRan: [],
  };
  vi.mocked(muteForRun).mockImplementation((async (_org: unknown, read: ForgeTargetAutomation) => {
    steps.push('lease plan');
    return {
      automation: read,
      muted,
      plan: { assign: [] },
      prepared: {
        acquire: async () => {
          steps.push('lease');
          if (refused) {
            throw new MuteRefusedError({ code: 'MUTE_FAILED', message: 'The set was refused.' });
          }
          return {
            outcome: muted,
            release: async () => {
              steps.push('release');
              return { ...muted, released: true };
            },
          };
        },
      },
    };
  }) as never);
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

/** Thrown where the command would exit: a test reads the code. */
class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

describe('sandforge-seed --checkpoint-first', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    steps.length = 0;
    automationOf = quiet;
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
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as never);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
    vi.mocked(commandCheckpoints).mockReset();
  });

  const writes = (): string[] => steps.filter((step) => step.startsWith('write '));

  it('scopes it after the mute is planned, takes it after its gates and before the lease and the first write, and keeps it once the seed wrote', async () => {
    fakeOrg();
    checkpointsOf();
    muteOf();

    await main(argv(2, '--mute-automation', '--checkpoint-first', '--json'));
    steps.push('result');

    const written = writes();
    expect(written).toEqual(['write Account', 'write Contact']);
    expect(steps).toEqual([
      'automation read',
      'lease plan',
      'scope',
      'limits read',
      'take',
      'lease',
      ...written,
      'release',
      'settle true',
      'result',
    ]);
    const asStep = (step: string): WritePathStep[] => {
      if (step.startsWith('write ')) return ['write'];
      const named: Record<string, WritePathStep> = {
        'automation read': 'reads',
        'limits read': 'reads',
        'lease plan': 'leasePlan',
        scope: 'stillRunning',
        take: 'checkpointTake',
        lease: 'leaseAcquire',
        release: 'leaseRelease',
        result: 'result',
      };
      return named[step] ? [named[step]] : [];
    };
    expect(writePathOrderDefects(steps.flatMap(asStep))).toEqual([]);
    expect(JSON.parse(stdout.join('')).checkpoint).toEqual(TAKEN);
    expect(stderr.join('')).toContain(
      `checkpoint before the run: ${TAKEN.checkpointId} '${TAKEN.name}', 2 object(s), 30 ` +
        'record(s), kept until 2026-11-08',
    );
    expect(stderr.join('')).toContain(
      `  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ${TAKEN.checkpointId} ` +
        '--mute-automation',
    );
    const asked = vi.mocked(commandCheckpoints).mock.calls[0][0];
    expect(asked).toMatchObject({
      module: 'seed',
      request: {},
      org: { id: '00D000000000002AAA', orgType: 'Sandbox' },
      own: { runId: asked.operationId },
    });
  });

  it('prints a line, without --json, on what it holds and how to rewind to it, the mute left out when there is none', async () => {
    fakeOrg();
    checkpointsOf();

    await main(argv(2, '--checkpoint-first'));

    const out = stdout.join('');
    expect(out).toContain(
      `  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ${TAKEN.checkpointId}\n`,
    );
    expect(out.indexOf('rewind to it:')).toBeLessThan(out.indexOf('Account: 2 written'));
  });

  it('scopes it from the objects the seed writes and what still runs as it creates them', async () => {
    fakeOrg();
    automationOf = creating;
    const { asked } = checkpointsOf();

    await main(argv(2, '--checkpoint-first', '--dry-run'));

    expect(asked).toHaveLength(1);
    expect(asked[0].written).toEqual(['Account', 'Contact']);
    expect(asked[0].running.firing.map((entry) => [entry.name, entry.flow?.creates])).toEqual([
      ['Account follow-up', ['Task']],
    ]);
  });

  it('takes its days and the objects it leaves out to the checkpoint', async () => {
    fakeOrg();
    checkpointsOf();

    await main(
      argv(
        2,
        '--checkpoint-first',
        '--checkpoint-keep-days',
        '30',
        '--checkpoint-exclude-object',
        'Task',
        '--dry-run',
      ),
    );

    expect(vi.mocked(commandCheckpoints).mock.calls[0][0].request).toEqual({
      keepDays: 30,
      excluded: ['Task'],
    });
  });

  it('says with --dry-run what it would hold and cost, gives it under checkpoint, counts its requests, and takes nothing', async () => {
    fakeOrg();
    const { port } = checkpointsOf();

    await main(argv(2, '--checkpoint-first', '--dry-run', '--json'));

    expect(port.take).not.toHaveBeenCalled();
    expect(port.settle).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    const printed = JSON.parse(stdout.join('')) as {
      checkpoint: RunCheckpointEstimate;
      apiRequests: { estimate: number; parts: { run: number; checkpoint: number } };
    };
    expect(printed.checkpoint).toEqual(ESTIMATE);
    expect(printed.apiRequests.parts.checkpoint).toBe(68);
    expect(printed.apiRequests.estimate).toBe(printed.apiRequests.parts.run + 68);
    expect(stderr.join('')).toContain(
      '  Checkpoint first: about 30 records of 2 objects, 68 API requests, 12 s, 0.1 MB on this ' +
        "machine, unencrypted, and none of the org's storage, kept 7 days.",
    );
    expect(stderr.join('')).not.toContain('checkpoint before the run:');
  });

  it("refuses a seed past the target's daily API requests once the checkpoint's are counted, before the take", async () => {
    fakeOrg(200, 40);
    const { port } = checkpointsOf();

    await expect(main(argv(2, '--checkpoint-first'))).rejects.toThrow(
      /\(68 of them for the checkpoint taken first\), and TGT has 40 of its 15000 daily requests left/,
    );
    expect(port.take).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);

    // Without it, the seed's own requests fit.
    steps.length = 0;
    await main(argv(2, '--json'));
    expect(writes()).toEqual(['write Account', 'write Contact']);
  });

  it('refuses the seed before the take, the lease and any write when its scope is refused, in the command’s words', async () => {
    fakeOrg();
    checkpointsOf({ estimate: { refusal: REFUSAL } });
    muteOf();

    await expect(main(argv(2, '--mute-automation', '--checkpoint-first'))).rejects.toThrow(
      REFUSED_WORDS,
    );

    expect(steps).not.toContain('take');
    expect(steps).not.toContain('lease');
    expect(writes()).toEqual([]);
  });

  it('refuses the seed when its scope cannot be read, nothing taken and nothing written', async () => {
    fakeOrg();
    const { port } = checkpointsOf({ scopeFails: 'the store is locked' });

    await expect(main(argv(2, '--checkpoint-first'))).rejects.toThrow(/the store is locked/);

    expect(port.take).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('says with --dry-run a scope it could not read, as the refusal a real run would meet', async () => {
    fakeOrg();
    checkpointsOf({ scopeFails: 'the store is locked' });

    await main(argv(2, '--checkpoint-first', '--dry-run', '--json'));

    expect(JSON.parse(stdout.join('')).wouldBeRefused).toEqual([
      expect.stringContaining('the store is locked'),
    ]);
    expect(stderr.join('')).toMatch(/a real run would be refused: .*the store is locked/);
  });

  it('says with --dry-run the refusal a real run would meet, and neither fits nor proposes a fit: no smaller seed answers it', async () => {
    fakeOrg(5);
    checkpointsOf({ estimate: { refusal: REFUSAL } });

    await main(argv(2_000, '--checkpoint-first', '--fit', 'share', '--dry-run', '--json'));

    const printed = JSON.parse(stdout.join('')) as { fit?: unknown; wouldBeRefused: string[] };
    expect(printed.fit).toBeUndefined();
    expect(printed.wouldBeRefused).toEqual([REFUSED_WORDS]);
    expect(stderr.join('')).toContain(`  a real run would be refused: ${REFUSED_WORDS}\n`);
    expect(stderr.join('')).not.toContain('fit:');
    // The gate is not met again: nothing was fitted.
    expect(steps.filter((step) => step === 'limits read')).toHaveLength(1);

    // Nor unasked: the counts --fit share would seed are not said for it.
    stdout.length = 0;
    stderr.length = 0;
    await main(argv(2_000, '--checkpoint-first', '--dry-run', '--json'));
    expect((JSON.parse(stdout.join('')) as { fit?: unknown }).fit).toBeUndefined();
    expect(stderr.join('')).not.toContain('--fit share would seed');
  });

  it('skips --fit as well for a scope it could not read', async () => {
    fakeOrg(5);
    checkpointsOf({ scopeFails: 'the store is locked' });

    await main(argv(2_000, '--checkpoint-first', '--fit', 'share', '--dry-run', '--json'));

    expect((JSON.parse(stdout.join('')) as { fit?: unknown }).fit).toBeUndefined();
  });

  it('fits a seed past the storage with its checkpoint asked, and takes it before the fitted seed writes', async () => {
    fakeOrg(1);
    checkpointsOf();

    await main(argv(2_000, '--checkpoint-first', '--fit', 'share', '--json'));

    const taken = steps.indexOf('take');
    expect(taken).toBeGreaterThan(steps.lastIndexOf('limits read'));
    expect(taken).toBeLessThan(steps.indexOf('write Account'));
    expect(JSON.parse(stdout.join('')).fit).toMatchObject({ applied: true });
    expect(steps.filter((step) => step === 'scope')).toHaveLength(1);
  });

  it('counts the checkpoint in the gate a fit is met by again', async () => {
    fakeOrg(1);
    checkpointsOf();

    await main(argv(2_000, '--checkpoint-first', '--fit', 'share', '--dry-run', '--json'));

    expect(steps.filter((step) => step === 'limits read')).toHaveLength(2);
    expect(
      (JSON.parse(stdout.join('')) as { apiRequests: { parts: { checkpoint: number } } })
        .apiRequests.parts.checkpoint,
    ).toBe(68);
  });

  it('writes nothing and takes no lease when the take is refused, in the command’s words', async () => {
    fakeOrg();
    checkpointsOf({
      take: { taken: false, refusal: { code: 'DISK', message: 'Too little room.' } },
    });
    muteOf();

    await expect(main(argv(2, '--mute-automation', '--checkpoint-first'))).rejects.toThrow(
      'The checkpoint before the run was refused: Too little room. Fix what refuses it, leave an ' +
        'object out of it (--checkpoint-exclude-object <ApiName>), or run without ' +
        '--checkpoint-first to write without one. Nothing was written.',
    );

    expect(steps).toContain('take');
    expect(steps).not.toContain('lease');
    expect(writes()).toEqual([]);
  });

  it('writes nothing when the take fails', async () => {
    fakeOrg();
    const { port } = checkpointsOf();
    vi.mocked(port.take).mockRejectedValue(new Error('the disk went away'));

    await expect(main(argv(2, '--checkpoint-first'))).rejects.toThrow(/the disk went away/);

    expect(writes()).toEqual([]);
    expect(port.settle).not.toHaveBeenCalled();
  });

  it('deletes the checkpoint of a seed whose lease was refused after the take, before any write', async () => {
    fakeOrg();
    checkpointsOf();
    muteOf(true);

    await expect(main(argv(2, '--mute-automation', '--checkpoint-first'))).rejects.toThrow(
      'The set was refused.',
    );

    expect(steps.slice(-3)).toEqual(['take', 'lease', 'settle false']);
    expect(stdout.join('')).toContain(BEFORE_RUN_DELETED_WORDS);
  });

  it('keeps the checkpoint of a seed the org refused every record of: it sent them', async () => {
    fakeOrg(200, 15_000, true);
    checkpointsOf();

    await main(argv(2, '--checkpoint-first', '--json'));

    expect(steps.at(-1)).toBe('settle true');
    expect(JSON.parse(stdout.join('')).checkpoint).toEqual(TAKEN);
  });

  it('deletes the checkpoint of a seed stopped after the take and before its first write', async () => {
    fakeOrg();
    const { port } = checkpointsOf();
    vi.mocked(port.take).mockImplementation(async () => {
      steps.push('take');
      process.emit('SIGINT', 'SIGINT');
      return { taken: true as const, checkpoint: TAKEN };
    });

    await main(argv(2, '--checkpoint-first', '--json'));

    expect(writes()).toEqual([]);
    expect(steps.at(-1)).toBe('settle false');
    expect(JSON.parse(stdout.join('')).checkpoint).toEqual({
      state: 'deleted',
      deleted: 'nothingWritten',
    });
    expect(process.exitCode).toBe(130);
  });

  it('stops at Ctrl-C during the take with nothing kept and nothing written, and exits 130', async () => {
    fakeOrg();
    const { port } = checkpointsOf({ take: { taken: false, stopped: true } });
    muteOf();

    await main(argv(2, '--mute-automation', '--checkpoint-first'));

    expect(steps).toContain('take');
    expect(steps).not.toContain('lease');
    expect(writes()).toEqual([]);
    expect(stderr.join('')).toContain(CHECKPOINT_STOPPED_WORDS);
    expect(process.exitCode).toBe(130);
    expect(port.settle).not.toHaveBeenCalled();
  });

  it('reads the option, its days and the objects it leaves out', () => {
    expect(parseArgs(argv(2)).checkpointFirst).toBeUndefined();
    expect(
      parseArgs(
        argv(
          2,
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
    expect(() => parseArgs(argv(2, '--checkpoint-exclude-object', 'Task'))).toThrow(Exited);
    expect(stderr.join('')).toContain('--checkpoint-exclude-object goes with --checkpoint-first');
  });

  it('refuses the option on a removal, exit 2: a removal takes back, it writes no run', () => {
    expect(() =>
      parseRemoveArgs([
        'node',
        'sandforge-seed.ts',
        '--remove',
        'summary.json',
        '--target',
        'TGT',
        '--checkpoint-first',
      ]),
    ).toThrow(Exited);
    expect(stderr.join('')).toContain('--checkpoint-first');
  });

  it('says the option in its --help', () => {
    expect(() => parseArgs(['node', 'sandforge-seed.ts', '--help'])).toThrow(Exited);
    const help = stdout.join('');
    expect(help).toContain('--checkpoint-first     take a checkpoint of what the run writes');
    expect(help).toContain('--checkpoint-keep-days <n>');
    expect(help).toContain('--checkpoint-exclude-object <ApiName>');
  });
});
