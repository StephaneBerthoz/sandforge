import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});
// What the target runs, as the reader Forge's clone command reads it with
// would answer it: given by each test.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: () => ({ read: readAutomation }),
}));
// The checkpoint the run takes first, and the mute's lease, as the run asks
// them: each tested on its own, here in the order the run calls them.
vi.mock('./beforeRunCheckpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beforeRunCheckpoint.js')>();
  return { ...actual, commandCheckpoints: vi.fn(actual.commandCheckpoints) };
});
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import type {
  ForgeTargetAutomation,
  MutedAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { main, parseArgs } from './sandforge-autopilot';
import {
  commandCheckpoints,
  type CommandCheckpointAsk,
  type CommandCheckpoints,
} from './beforeRunCheckpoint.js';
import {
  BEFORE_RUN_DELETED_WORDS,
  writePathOrderDefects,
  type BeforeRunTake,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { CHECKPOINT_STOPPED_WORDS } from '../src/modules/forge/ForgeRunGate.js';
import { MuteRefusedError, muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { countingConnection, largeOrg } from '../src/test/largeOrg';

/** What the checkpoint of the plan would hold and cost, as its scope says. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 30, apiRequests: 68, apiRequestsLeft: 14_000, seconds: 12, bytes: 60_000 },
  objects: ['Lead'],
  added: [],
  notHeld: [],
  keepDays: 7,
};
/** The checkpoint the take keeps. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-110000-c3d4',
  name: 'Before Autopilot run 2026-11-01 11:00 UTC',
  takenAt: '2026-11-01T11:00:04.000Z',
  expiresAt: '2026-11-08T11:00:00.000Z',
  objects: ['Lead'],
  records: 30,
  bytes: 60_000,
  requests: 66,
  added: [],
  notHeld: [],
};

/** What the target runs on the objects a plan writes. */
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

/** A flow of the target that creates a task for each lead it inserts. */
const LEAD_TASK = automationOf([
  {
    objectApiName: 'Lead',
    flows: [
      {
        apiName: 'Lead_Task',
        label: 'Lead task',
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
const argv = (...rest: string[]) => [
  'node',
  'sandforge-autopilot.ts',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--object',
  'Lead',
  ...rest,
];

/**
 * A source and a target over the same large org, a sandbox with room to
 * spare unless `limits` says; each write to the target in `events`, and
 * refused when `refuse` says.
 */
function orgs(events: string[], limits?: Record<string, unknown>, refuse = false) {
  const org = largeOrg();
  const source = countingConnection(org);
  const target = countingConnection(org);
  const conn = {
    ...target.conn,
    query: async (soql: string) =>
      soql.includes('FROM Organization')
        ? { records: [{ Id: '00D000000000001AAA', IsSandbox: true }], totalSize: 1, done: true }
        : target.conn.query(soql),
    request: vi.fn(
      async (): Promise<Record<string, unknown>> =>
        limits ?? {
          DataStorageMB: { Max: 200, Remaining: 150 },
          DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
        },
    ),
    sobject: (name: string) => ({
      ...target.conn.sobject(name),
      create: vi.fn(async (records: unknown[]) => {
        events.push(`write ${name}`);
        return records.map((_, i) =>
          refuse
            ? { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }] }
            : { id: `new-${i}`, success: true, errors: [] },
        );
      }),
    }),
  };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: `${alias}@example.invalid`,
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
  }));
  vi.mocked(makeConn).mockImplementation(
    (session) => (session.alias === 'SRC' ? source.conn : conn) as never,
  );
}

/** The checkpoint the run asks for, each call in `events`: its scope answers `estimate`, its take `take`. */
function checkpointsOf(
  events: string[],
  options: { estimate?: Partial<RunCheckpointEstimate>; take?: BeforeRunTake } = {},
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
function muteOf(events: string[], refused = false) {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Bypass_Flow'],
    silenced: [],
    stillRan: [],
  };
  vi.mocked(muteForRun).mockResolvedValue({
    automation: LEAD_TASK,
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
  } as never);
}

describe('sandforge-autopilot --checkpoint-first', () => {
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
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(automationOf([]));
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
  });

  it('takes it once the gate let the run through, before the lease and the first write, and keeps it once the run wrote', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events);
    muteOf(events);

    await main(argv('--mute-automation', '--checkpoint-first', '--json'));

    const writes = events.filter((event) => event.startsWith('write'));
    expect(writes.length).toBeGreaterThan(0);
    expect(events).toEqual(['scope', 'take', 'lease', ...writes, 'release', 'settle true']);
    // The flags stand for the question a command line is never asked.
    const steps = events.map((event): WritePathStep => {
      if (event === 'scope') return 'stillRunning';
      if (event === 'take') return 'checkpointTake';
      if (event === 'lease') return 'leaseAcquire';
      if (event === 'release') return 'leaseRelease';
      if (event.startsWith('write')) return 'write';
      return 'result';
    });
    expect(writePathOrderDefects(['reads', 'leasePlan', 'question', ...steps])).toEqual([]);
    expect(JSON.parse(out.join('')).checkpoint).toEqual(TAKEN);
    expect(err.join('')).toContain(
      '  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ' +
        'ck-20261101-110000-c3d4 --mute-automation',
    );
    expect(vi.mocked(commandCheckpoints).mock.calls[0][0]).toMatchObject({
      module: 'autopilot',
      request: {},
      org: { id: '00D000000000001AAA', orgType: 'Sandbox' },
    });
  });

  it('scopes it from the objects the plan writes and what still runs as it inserts them', async () => {
    const events: string[] = [];
    orgs(events);
    readAutomation.mockResolvedValue(LEAD_TASK);
    const { asked } = checkpointsOf(events);

    await main(argv('--checkpoint-first', '--plan-only'));

    expect(asked).toHaveLength(1);
    expect(asked[0].written).toEqual(['Lead']);
    expect(asked[0].running.firing.map((entry) => [entry.name, entry.flow?.creates])).toEqual([
      ['Lead task', ['Task']],
    ]);
  });

  it('says with --plan-only what it would hold and cost, gives it under checkpoint, counts its requests, and takes nothing', async () => {
    const events: string[] = [];
    orgs(events);
    const { port } = checkpointsOf(events);

    await main(argv('--checkpoint-first', '--plan-only', '--json'));

    expect(events).toEqual(['scope']);
    expect(port.take).not.toHaveBeenCalled();
    const printed = JSON.parse(out.join('')) as {
      checkpoint: RunCheckpointEstimate;
      writeGate: { apiRequests: { estimate: number; parts?: { checkpoint?: number } } };
    };
    expect(printed.checkpoint).toEqual(ESTIMATE);
    expect(printed.writeGate.apiRequests.parts?.checkpoint).toBe(68);
    expect(err.join('')).toContain(
      '  Checkpoint first: about 30 records of 1 object, 68 API requests, 12 s, 0.1 MB on this ' +
        "machine, unencrypted, and none of the org's storage, kept 7 days.",
    );
  });

  it('prices with --plan-only the lease of the mute in a part of its own, said before the mute it plans', async () => {
    const events: string[] = [];
    orgs(events);
    muteOf(events);
    const planned = vi.mocked(muteForRun).getMockImplementation();
    vi.mocked(muteForRun).mockImplementation(async (...args) => ({
      ...(await planned!(...args)),
      plan: {
        assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Bypass_Flow'] }],
        silenced: [],
        stillRuns: [],
      },
    }));

    await main(argv('--mute-automation', '--plan-only', '--json'));

    const printed = JSON.parse(out.join('')) as {
      writeGate: { apiRequests: { parts?: { mute?: number } } };
    };
    // Who the run writes as, three reads, the set assigned and taken back.
    expect(printed.writeGate.apiRequests.parts?.mute).toBe(2 + 3 + 2);
    expect(events).not.toContain('lease');
    const said = err.join('');
    expect(said.indexOf('API requests')).toBeGreaterThan(-1);
    expect(said.indexOf('mute:')).toBeGreaterThan(said.indexOf('API requests'));
  });

  it("says with --plan-only that a real run would be refused past the target's daily API requests, the checkpoint's part named", async () => {
    const limits = {
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 40 },
    };
    orgs([], limits);
    checkpointsOf([]);

    await main(argv('--checkpoint-first', '--plan-only'));

    expect(out.join('')).toContain(
      'a real run would be refused (API_BUDGET_EXCEEDED): The run takes about 70 API requests ' +
        '(68 of them for the checkpoint taken first, 1 to read back the record types the ' +
        'target gave), and TGT has 40 of its 15000 daily requests left',
    );

    // Without it, the plan's own requests fit.
    out.length = 0;
    orgs([], limits);
    await main(argv('--plan-only'));
    expect(out.join('')).not.toContain('a real run would be refused');
  });

  it('refuses the run before the take, the lease and any write when its scope is refused, in the command’s words', async () => {
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

    await expect(main(argv('--mute-automation', '--checkpoint-first'))).rejects.toThrow(
      'The checkpoint before the run was refused: A SandForge run is writing to TGT. Fix what ' +
        'refuses it, or run without --checkpoint-first to write without one. Nothing was written.',
    );
    expect(events).toEqual(['scope']);
  });

  it('writes nothing and takes no lease when the take is refused', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events, {
      take: { taken: false, refusal: { code: 'DISK', message: 'Too little room.' } },
    });
    muteOf(events);

    await expect(main(argv('--mute-automation', '--checkpoint-first'))).rejects.toThrow(
      /^refused \(CHECKPOINT_REFUSED\): The checkpoint before the run was refused: Too little room\. .*Nothing was written\.$/,
    );
    expect(events).toEqual(['scope', 'take']);
  });

  it('deletes the checkpoint of a run whose lease was refused after the take, before any write', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events);
    muteOf(events, true);

    await expect(main(argv('--mute-automation', '--checkpoint-first'))).rejects.toThrow(
      /^refused \(MUTE_FAILED\): The set was refused\.$/,
    );
    expect(events).toEqual(['scope', 'take', 'lease', 'settle false']);
    expect(out.join('')).toContain(BEFORE_RUN_DELETED_WORDS);
  });

  it.each([
    [
      'the take',
      {
        take: {
          taken: false as const,
          refusal: { code: 'DISK' as const, message: 'Too little room.' },
        },
      },
      false,
      'CHECKPOINT_REFUSED',
    ],
    ['the lease', {}, true, 'MUTE_FAILED'],
  ])(
    'answers --json with the code of a run refused at %s, past the gate and before its first write',
    async (_step, checkpoint, leaseRefused, code) => {
      // A CI job reading `.refused.code` got an empty stdout: the gate's
      // refusals carried their code, these a sentence on stderr alone.
      const events: string[] = [];
      orgs(events);
      checkpointsOf(events, checkpoint);
      muteOf(events, leaseRefused);

      await expect(main(argv('--mute-automation', '--checkpoint-first', '--json'))).rejects.toThrow(
        new RegExp(`^refused \\(${code}\\): `),
      );

      expect(JSON.parse(out.join(''))).toMatchObject({
        tool: 'sandforge-autopilot',
        source: 'SRC',
        target: 'TGT',
        dryRun: false,
        refused: { code },
      });
      expect(events.some((event) => event.startsWith('write'))).toBe(false);
    },
  );

  it('deletes the checkpoint of a run the target refused every record of', async () => {
    const events: string[] = [];
    orgs(events, undefined, true);
    checkpointsOf(events);

    await main(argv('--checkpoint-first', '--json'));

    expect(events.at(-1)).toBe('settle false');
    expect(JSON.parse(out.join('')).checkpoint).toEqual({
      state: 'deleted',
      deleted: 'nothingWritten',
    });
  });

  it('stops at Ctrl-C during the take with nothing kept and nothing written, and exits 130', async () => {
    const events: string[] = [];
    orgs(events);
    checkpointsOf(events, { take: { taken: false, stopped: true } });

    await main(argv('--checkpoint-first'));

    expect(events).toEqual(['scope', 'take']);
    expect(err.join('')).toContain(CHECKPOINT_STOPPED_WORDS);
    expect(process.exitCode).toBe(130);
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
});
