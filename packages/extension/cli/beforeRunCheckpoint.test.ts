import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { RunCheckpointEstimate, RunCheckpointTaken } from '@sandforge/shared';

// The engine is tested on its own: here, what the command line asks of it
// and what it says of its answers.
vi.mock('../src/modules/checkpoint/beforeRunCheckpoint.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/checkpoint/beforeRunCheckpoint.js')>();
  return {
    ...actual,
    scopeBeforeRun: vi.fn(),
    takeBeforeRun: vi.fn(),
    settleBeforeRun: vi.fn(),
  };
});
vi.mock('../src/modules/checkpoint/takeCheckpoint.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/checkpoint/takeCheckpoint.js')>()),
  takeOrgOf: vi.fn(() => ({ fake: 'take org' })),
}));

import {
  BEFORE_RUN_DELETED_WORDS,
  scopeBeforeRun,
  settleBeforeRun,
  takeBeforeRun,
  type BeforeRunDeps,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { CHECKPOINT_STOPPED_WORDS } from '../src/modules/forge/ForgeRunGate.js';
import type { SyncRunKept } from '../src/modules/sync/SyncRunCreations.js';
import {
  checkpointEstimateLines,
  checkpointFirstArgs,
  checkpointFirstHelp,
  checkpointOrgOf,
  checkpointRefusedWords,
  checkpointSettledLines,
  checkpointStopWords,
  checkpointTakenLines,
  commandCheckpoints,
  commandRunWriting,
  settleCommandCheckpoint,
} from './beforeRunCheckpoint.js';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** The target's Organization Id, as its own record answers. */
const ORG = '00D000000000002AAA';

/** What a dry run of a clone said its checkpoint would hold and cost. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 38,
    apiRequests: 68,
    apiRequestsLeft: 14_000,
    seconds: 44,
    bytes: 2_200_000,
  },
  objects: ['Account', 'Contact', 'Task'],
  added: [{ objectApiName: 'Task', reason: "The target's flow 'Welcome' creates Task records." }],
  notHeld: [
    {
      objectApiName: 'FeedItem',
      reason: 'Chatter posts. A rewind leaves its records as they are.',
    },
  ],
  keepDays: 7,
};

/** The checkpoint a run took first. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261030-214000-a1b2',
  name: 'Before Forge run 2026-10-30 21:40 UTC',
  takenAt: '2026-10-30T21:40:12.000Z',
  expiresAt: '2026-11-06T21:40:00.000Z',
  objects: ['Account', 'Contact', 'Task'],
  records: 1_074,
  bytes: 90_000,
  requests: 66,
  added: [],
  notHeld: [
    {
      objectApiName: 'FeedItem',
      reason: 'Chatter posts. A rewind leaves its records as they are.',
    },
  ],
};

describe('checkpointFirstArgs', () => {
  let stderr: string;

  beforeEach(() => {
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The exit a line is refused with, and what it said. */
  function refused(args: string[], refusedWith?: Parameters<typeof checkpointFirstArgs>[1]) {
    try {
      checkpointFirstArgs(args, refusedWith);
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return { code: err.code, said: stderr };
      throw err;
    }
    return { code: undefined, said: stderr };
  }

  it('asks for no checkpoint without the switch, and for one kept by default with it', () => {
    expect(checkpointFirstArgs(['--dry-run'])).toBeUndefined();
    expect(checkpointFirstArgs(['--checkpoint-first'])).toEqual({});
  });

  it('reads the days it is kept, 0 to 3650, and each object left out once, whatever its case', () => {
    expect(
      checkpointFirstArgs([
        '--checkpoint-first',
        '--checkpoint-keep-days',
        '0',
        '--checkpoint-exclude-object',
        'Task',
        '--checkpoint-exclude-object',
        'task',
        '--checkpoint-exclude-object',
        'Event',
      ]),
    ).toEqual({ keepDays: 0, excluded: ['Task', 'Event'] });
    expect(checkpointFirstArgs(['--checkpoint-first', '--checkpoint-keep-days', '3650'])).toEqual({
      keepDays: 3650,
    });
  });

  it('refuses a number of days that is none or out of bounds, and one given twice, exit 2', () => {
    for (const days of ['abc', '3651', '-1', '1.5']) {
      stderr = '';
      expect(refused(['--checkpoint-first', '--checkpoint-keep-days', days])).toEqual({
        code: 2,
        said: `--checkpoint-keep-days takes a whole number of days from 0 to 3650, not "${days}".\n`,
      });
    }
    stderr = '';
    expect(
      refused(['--checkpoint-first', '--checkpoint-keep-days', '3', '--checkpoint-keep-days', '4'])
        .code,
    ).toBe(2);
  });

  it('refuses an object left out that is no API name, exit 2', () => {
    expect(refused(['--checkpoint-first', '--checkpoint-exclude-object', 'Task;DROP'])).toEqual({
      code: 2,
      said: '--checkpoint-exclude-object takes an object\'s API name, not "Task;DROP".\n',
    });
  });

  it('refuses its days or an object left out without the switch, which they would set nothing for', () => {
    expect(refused(['--checkpoint-keep-days', '3'])).toEqual({
      code: 2,
      said:
        '--checkpoint-keep-days goes with --checkpoint-first, which takes the checkpoint they ' +
        'set. Run with --help.\n',
    });
    stderr = '';
    expect(
      refused(['--checkpoint-keep-days', '3', '--checkpoint-exclude-object', 'Task']).said,
    ).toMatch(/^--checkpoint-keep-days and --checkpoint-exclude-object go with --checkpoint-first/);
  });

  it('refuses the switch beside a flag it does not go with, saying why', () => {
    expect(
      refused(
        ['--checkpoint-first', '--rehearse'],
        [{ flag: '--rehearse', why: 'a rehearsal keeps nothing.' }],
      ),
    ).toEqual({
      code: 2,
      said: '--checkpoint-first does not go with --rehearse: a rehearsal keeps nothing.\n',
    });
    expect(
      checkpointFirstArgs(
        ['--rehearse'],
        [{ flag: '--rehearse', why: 'a rehearsal keeps nothing.' }],
      ),
    ).toBeUndefined();
  });
});

describe('commandRunWriting', () => {
  /** This process, as a run's file names its writer. */
  const SELF = { pid: 4242, startedAt: '2026-11-01T08:00:00.000Z' };

  /** A run's file with no end, writing to the org, by `writer`. */
  function run(
    runId: string,
    writer: { pid: number; hostStartedAt: string } | undefined,
    more: Partial<SyncRunKept> = {},
  ): SyncRunKept {
    return {
      runId,
      configId: 'c',
      configName: 'c',
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      targetOrganizationId: ORG.slice(0, 15),
      startedAt: '2026-11-01T09:00:00.000Z',
      created: [],
      ...(writer ? { writer } : {}),
      ...more,
    } as SyncRunKept;
  }

  /** The take's check, over these runs' files; a process alive unless `alive` says. */
  function writing(runs: SyncRunKept[], extra: Partial<Parameters<typeof commandRunWriting>[0]>) {
    return commandRunWriting({
      orgName: 'TGT',
      alias: 'TGT',
      runs: [{ list: async () => runs }],
      self: SELF,
      ...extra,
    });
  }

  const WORDS =
    'A SandForge run is writing to TGT: start this run once it has ended. No record was read.';
  const OTHER = { pid: 7, hostStartedAt: '2026-11-01T07:00:00.000Z' };
  const HERE = { pid: SELF.pid, hostStartedAt: SELF.startedAt };

  it('refuses the take while another live process writes a run to the org, named by its Organization Id', async () => {
    const check = writing([run('sync-1', OTHER)], { elsewhere: () => true });
    expect(await check(ORG)).toBe(WORDS);
  });

  it('refuses it for a run a command line named the org by its alias', async () => {
    const byAlias = run('sync-1', OTHER, { targetOrganizationId: undefined });
    expect(await writing([byAlias], { elsewhere: () => true })(ORG)).toBe(WORDS);
  });

  it('lets the run’s own file through, written by this process, and only it', async () => {
    const own = { own: { runId: 'sync-1' } };
    expect(await writing([run('sync-1', HERE)], own)(ORG)).toBeUndefined();
    // Another run of this process, or the same id written by another process.
    expect(await writing([run('sync-2', HERE)], own)(ORG)).toBe(WORDS);
    expect(await writing([run('sync-1', OTHER)], { ...own, elsewhere: () => true })(ORG)).toBe(
      WORDS,
    );
  });

  it('lets through a run that ended, one to another org, and one whose process is gone', async () => {
    expect(
      await writing([run('sync-1', OTHER, { end: { status: 'success' } as SyncRunKept['end'] })], {
        elsewhere: () => true,
      })(ORG),
    ).toBeUndefined();
    expect(
      await writing(
        [run('sync-1', OTHER, { targetOrganizationId: '00D000000000009', targetOrgId: 'OTHER' })],
        { elsewhere: () => true },
      )(ORG),
    ).toBeUndefined();
    expect(await writing([run('sync-1', OTHER)], { elsewhere: () => false })(ORG)).toBeUndefined();
  });

  it('refuses it while an environment of the org is applied on this machine', async () => {
    const check = writing([], {
      envLock: (organizationId) =>
        organizationId === ORG ? 'an apply of dev to TGT is under way on this machine' : undefined,
    });
    expect(await check(ORG)).toBe(
      'an apply of dev to TGT is under way on this machine: start this run once it has ended. ' +
        'No record was read.',
    );
  });
});

describe('commandCheckpoints', () => {
  let journalDir: string;
  let said: string[];

  beforeEach(() => {
    journalDir = mkdtempSync(join(tmpdir(), 'sandforge-before-run-cli-'));
    said = [];
    vi.mocked(scopeBeforeRun).mockReset().mockResolvedValue(ESTIMATE);
    vi.mocked(takeBeforeRun).mockReset().mockResolvedValue({ taken: true, checkpoint: TAKEN });
    vi.mocked(settleBeforeRun).mockReset();
  });

  afterEach(() => {
    rmSync(journalDir, { recursive: true, force: true });
  });

  /** The checkpoint of a clone into a Developer Edition, kept `keepDays`. */
  function port(keepDays?: number) {
    const conn = { version: '66.0' } as unknown as Connection;
    return commandCheckpoints({
      module: 'forge',
      operationId: 'sandforge-clone-1',
      request: { ...(keepDays !== undefined ? { keepDays } : {}), excluded: ['Event'] },
      session: {
        alias: 'TGT',
        username: 'someone@example.invalid',
        instanceUrl: 'https://tgt.example.invalid',
        accessToken: 'token',
      },
      org: { id: ORG, orgType: 'Developer', edition: 'Developer Edition' },
      connect: () => conn,
      journalDir,
      locksDir: join(journalDir, 'locks'),
      say: (line) => said.push(line),
    });
  }

  const ASK = {
    written: ['Account', 'Contact'],
    running: { firing: [] },
  };

  it('scopes it as the command takes it: the org by its Organization Id and alias, the run, seven days unless asked, from the command line', async () => {
    expect(await port().scope(ASK)).toBe(ESTIMATE);

    const [deps, org, request] = vi.mocked(scopeBeforeRun).mock.calls[0];
    expect(org).toEqual({
      orgId: ORG,
      orgName: 'TGT',
      alias: 'TGT',
      username: 'someone@example.invalid',
      instanceUrl: 'https://tgt.example.invalid',
      registered: { orgType: 'Developer', metadata: { edition: 'Developer Edition' } },
    });
    expect(request).toEqual({
      module: 'forge',
      written: ['Account', 'Contact'],
      running: { firing: [] },
      request: { excluded: ['Event'] },
      operationId: 'sandforge-clone-1',
      tool: 'cli',
      keepDays: 7,
    });
    // The store everyone lists, under the command's journals.
    expect(deps.store.root).toBe(join(journalDir, 'checkpoints'));
    expect(deps.org).toEqual({ fake: 'take org' });
    // The take's own snapshot reaches this org alone, through these credentials.
    const handler = deps.handler as unknown as {
      orgManager: { getOrg(id: string): unknown };
      orgRegistry: { getCredentials(id: string): Promise<unknown> };
    };
    expect(handler.orgManager.getOrg(ORG)).toMatchObject({ id: ORG, alias: 'TGT' });
    expect(handler.orgManager.getOrg('another')).toBeUndefined();
    expect(await handler.orgRegistry.getCredentials(ORG)).toEqual({
      accessToken: 'token',
      instanceUrl: 'https://tgt.example.invalid',
    });
    expect(await deps.runWriting?.(ORG)).toBeUndefined();
  });

  it('keeps it the days the line asks', async () => {
    await port(0).scope(ASK);
    expect(vi.mocked(scopeBeforeRun).mock.calls[0][2].keepDays).toBe(0);
  });

  it('takes it with the run’s Stop and what its scope said, saying its progress each tenth of the way', async () => {
    const stop = new AbortController();
    vi.mocked(takeBeforeRun).mockImplementation(async (deps: BeforeRunDeps) => {
      for (const percentage of [0, 4, 12, 18, 55, 100]) {
        deps.onProgress?.({ percentage, step: '' } as never);
      }
      return { taken: true, checkpoint: TAKEN };
    });

    expect(await port().take(ASK, ESTIMATE, { signal: stop.signal })).toEqual({
      taken: true,
      checkpoint: TAKEN,
    });

    const [deps, , request, planned] = vi.mocked(takeBeforeRun).mock.calls[0];
    expect(deps.signal).toBe(stop.signal);
    expect(request.tool).toBe('cli');
    expect(planned).toBe(ESTIMATE);
    expect(said).toEqual([
      '  Taking the checkpoint first (0%)',
      '  Taking the checkpoint first (12%)',
      '  Taking the checkpoint first (55%)',
      '  Taking the checkpoint first (100%)',
    ]);
  });

  it('settles it in the same store, saying why one the run wrote nothing after is kept', async () => {
    vi.mocked(settleBeforeRun).mockResolvedValue({
      info: TAKEN,
      notDeleted: 'The checkpoint is kept, though the run wrote nothing: a rewind is writing.',
    });

    expect(await port().settle(TAKEN, false)).toBe(TAKEN);

    const [store, taken, wrote] = vi.mocked(settleBeforeRun).mock.calls[0];
    expect((store as unknown as { root: string }).root).toBe(join(journalDir, 'checkpoints'));
    expect([taken, wrote]).toEqual([TAKEN, false]);
    expect(said).toEqual([
      'warning: The checkpoint is kept, though the run wrote nothing: a rewind is writing.',
    ]);
  });

  it('cannot scope it where the store cannot be kept, and says why', async () => {
    writeFileSync(join(journalDir, 'checkpoints'), 'a file');

    await expect(port().scope(ASK)).rejects.toThrow(
      `the checkpoints cannot be kept in ${join(journalDir, 'checkpoints')}: it is a file, not a folder`,
    );
    expect(scopeBeforeRun).not.toHaveBeenCalled();
  });
});

describe('what the command says of its checkpoint', () => {
  it('says the estimate as the question would, indented under the write gate', () => {
    expect(checkpointEstimateLines(ESTIMATE)).toEqual([
      '  Checkpoint first: about 38 records of 3 objects, 68 API requests, 44 s, 2.1 MB on this ' +
        "machine, unencrypted, and none of the org's storage, kept 7 days.",
      "  Added: Task — The target's flow 'Welcome' creates Task records.",
      '  Not in the checkpoint: FeedItem — Chatter posts. A rewind leaves its records as they are.',
      '  What an Apex trigger, or automation that could not be read, creates as the run writes ' +
        'is not known: a rewind leaves those records as they are.',
    ]);
  });

  it('words a refusal for the command line, its flag where the panel names its box, the take’s last words left out', () => {
    const said = checkpointRefusedWords({
      code: 'RUN_WRITING',
      message:
        'A SandForge run is writing to TGT: start this run once it has ended. No record was read.',
    });
    expect(said).toBe(
      'The checkpoint before the run was refused: A SandForge run is writing to TGT: start this ' +
        'run once it has ended. Fix what refuses it, or run without --checkpoint-first to write ' +
        'without one.',
    );
    expect(said).not.toContain('Untick');
  });

  it('points at an object to leave out where fewer would pass: the take’s limit, the day’s requests, the disk', () => {
    for (const code of ['TOO_MANY_RECORDS', 'API_BUDGET', 'DISK'] as const) {
      expect(checkpointRefusedWords({ code, message: 'Past it.' })).toContain(
        'leave an object out of it (--checkpoint-exclude-object <ApiName>), ',
      );
    }
    expect(checkpointRefusedWords({ code: 'NOTHING_HELD', message: 'None.' })).not.toContain(
      '--checkpoint-exclude-object',
    );
  });

  it('says why a run stopped for its checkpoint, closing on nothing written', () => {
    expect(
      checkpointStopWords({
        code: 'CHECKPOINT_REFUSED',
        message: 'panel words',
        refusal: { code: 'DISK', message: 'Too little room. No record was read.' },
      }),
    ).toBe(
      'The checkpoint before the run was refused: Too little room. Fix what refuses it, leave an ' +
        'object out of it (--checkpoint-exclude-object <ApiName>), or run without ' +
        '--checkpoint-first to write without one. Nothing was written.',
    );
    expect(
      checkpointStopWords({
        code: 'CHECKPOINT_REFUSED',
        message: 'The checkpoint before the run could not be taken: boom. Nothing was written.',
      }),
    ).toBe('The checkpoint before the run could not be taken: boom. Nothing was written.');
    expect(checkpointStopWords({ code: 'RUN_CANCELLED', message: 'x' })).toBe(
      CHECKPOINT_STOPPED_WORDS,
    );
  });

  it('names the checkpoint taken, until when it is kept, the command that rewinds to it, muting as the run muted, and what it does not hold', () => {
    expect(checkpointTakenLines(TAKEN, 'TGT', false)).toEqual([
      "checkpoint before the run: ck-20261030-214000-a1b2 'Before Forge run 2026-10-30 21:40 UTC', " +
        '3 object(s), 1074 record(s), kept until 2026-11-06',
      '  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ck-20261030-214000-a1b2',
      '  not in the checkpoint: FeedItem — Chatter posts. A rewind leaves its records as they are.',
    ]);
    const kept = checkpointTakenLines({ ...TAKEN, expiresAt: null, notHeld: [] }, 'TGT', true);
    expect(kept[0]).toMatch(/, kept until it is deleted$/);
    expect(kept[1]).toBe(
      '  rewind to it: sandforge-checkpoint rewind --org TGT --checkpoint ' +
        'ck-20261030-214000-a1b2 --mute-automation',
    );
  });

  it('says last that the checkpoint was deleted when the run wrote nothing, and nothing when kept', () => {
    expect(checkpointSettledLines({ state: 'deleted', deleted: 'nothingWritten' })).toEqual([
      BEFORE_RUN_DELETED_WORDS,
    ]);
    expect(checkpointSettledLines(TAKEN)).toEqual([]);
  });

  it('lists the three options in the column of a command’s help, with its simulation', () => {
    const help = checkpointFirstHelp({
      run: 'the load',
      simulation: '--dry-run',
      step: 'with load: ',
    });
    expect(help).toMatch(
      /^ {2}--checkpoint-first {5}with load: take a checkpoint of what the load/,
    );
    expect(help).toContain('  --checkpoint-keep-days <n>');
    expect(help).toContain('  --checkpoint-exclude-object <ApiName>');
    expect(help).toContain('with --dry-run, says what it would hold and');
    // A command's own word on the option, under it and before the next.
    const noted = checkpointFirstHelp({
      run: 'the run',
      simulation: '--plan-only',
      note: ['No removal.'],
    });
    expect(noted).toContain(
      '(default: off)\n                         No removal.\n  --checkpoint-keep-days',
    );
  });

  it('types the org as the panel registers one: a scratch org, a sandbox, a Developer Edition, else production', () => {
    expect(checkpointOrgOf({ scratch: true }, { id: ORG, sandbox: true })).toEqual({
      id: ORG,
      orgType: 'Scratch',
    });
    expect(checkpointOrgOf({}, { id: ORG, sandbox: true }).orgType).toBe('Sandbox');
    expect(checkpointOrgOf({}, { id: ORG, sandbox: false, edition: 'Developer Edition' })).toEqual({
      id: ORG,
      orgType: 'Developer',
      edition: 'Developer Edition',
    });
    expect(
      checkpointOrgOf({}, { id: ORG, sandbox: false, edition: 'Enterprise Edition' }).orgType,
    ).toBe('Production');
  });
});

describe('settleCommandCheckpoint', () => {
  const lines = (): { said: string[]; say: (line: string) => void } => {
    const said: string[] = [];
    return { said, say: (line) => said.push(line) };
  };

  it('keeps the checkpoint of a run that wrote, without a word', async () => {
    const settle = vi.fn(async () => TAKEN);
    const { said, say } = lines();

    await expect(settleCommandCheckpoint({ settle }, TAKEN, true, 'TGT', say)).resolves.toBe(TAKEN);

    expect(settle).toHaveBeenCalledWith(TAKEN, true);
    expect(said).toEqual([]);
  });

  it('deletes the checkpoint of a run that wrote nothing, and says so', async () => {
    const deleted = { state: 'deleted' as const, deleted: 'nothingWritten' as const };
    const { said, say } = lines();

    await expect(
      settleCommandCheckpoint({ settle: async () => deleted }, TAKEN, false, 'TGT', say),
    ).resolves.toBe(deleted);

    expect(said).toEqual([BEFORE_RUN_DELETED_WORDS]);
  });

  it('keeps a checkpoint the store would not delete, and says how to, never failing the run', async () => {
    const { said, say } = lines();

    await expect(
      settleCommandCheckpoint(
        {
          settle: async () => {
            throw new Error('the folder is locked');
          },
        },
        TAKEN,
        false,
        'TGT',
        say,
      ),
    ).resolves.toBe(TAKEN);

    expect(said).toEqual([
      `warning: the checkpoint '${TAKEN.name}' taken before the run, which wrote nothing, could ` +
        'not be deleted (the folder is locked): delete it with sandforge-checkpoint delete --org ' +
        `TGT --checkpoint ${TAKEN.checkpointId}`,
    ]);
  });
});
