import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import type { EnvState } from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseArgs as parseCheckpointArgs } from '../sandforge-checkpoint.js';
import type { CommandRun, CommandRunner } from '../scriptRunner.js';
import {
  CHECKPOINT_SCRIPT,
  changedByWords,
  checkpointDeleteLine,
  checkpointEstimateLine,
  checkpointKeepDays,
  checkpointNameOf,
  checkpointPlanLines,
  checkpointPreviewLine,
  checkpointRefusalOf,
  checkpointRequestsOf,
  checkpointRewindLine,
  checkpointStepsOf,
  checkpointTakeLine,
  checkpointWarningsOf,
  checkpointsOfState,
  deleteEnvCheckpoint,
  driftOf,
  envCheckpointStoreOf,
  estimateReadOf,
  planCheckpointsOf,
  readCheckpointTake,
  rewindPreviewLines,
  rewindPreviewOf,
  rewindRanOf,
  rewindUndoOf,
  takeEnvCheckpoint,
  undoLine,
  withCheckpoint,
} from './envCheckpoints.js';
import { StepAnswerError } from './kinds/common.js';

/*
 * The checkpoints of an environment: the lines it gives the checkpoint
 * script, held to the script's own parser; what it reads of the script's
 * `--json` answers, in the shapes the script prints them; and the steps the
 * plan lists, the words it says them in.
 */

const STORE = resolve('/journal/checkpoints');
const CK = 'ck-20261025-090000-a1b2';
const OLD = 'ck-20261024-090000-c3d4';

/** A run of the checkpoint script, as a runner hands one back. */
const ran = (code: number, answer?: unknown, stderr = ''): CommandRun => ({
  code,
  stdout: answer === undefined ? '' : `${JSON.stringify(answer, null, 2)}\n`,
  stderr,
});

/** A state of `resources` with its checkpoints. */
function stateOf(
  checkpoints?: EnvState['checkpoints'],
  status: EnvState['resources'][string]['status'] = 'applied',
): EnvState {
  return {
    version: 1,
    env: 'pool',
    lineage: '7d3f2b4e-8a1c-4f5e-9b6d-2c8e0a1f3b5d',
    serial: 4,
    sandforgeVersion: '1.68.0',
    updatedAt: '2026-10-25T09:00:00.000Z',
    org: { organizationId: '00Dxx0000001gPLEAY', kind: 'scratch', username: 'u@example.com' },
    file: { digest: 'a'.repeat(64) },
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    resources: {
      accounts: {
        kind: 'seed',
        fingerprint: 'b'.repeat(64),
        dependsOn: [],
        status,
        runs: [],
      },
    },
  };
}

describe('where the checkpoints are kept, and for how long', () => {
  it('keeps them in checkpoints/ of the journal directory, a scratch org’s as long as its state', () => {
    expect(envCheckpointStoreOf('/journal')).toBe(join('/journal', 'checkpoints'));
    expect(checkpointKeepDays('scratch')).toBe(30);
    expect(checkpointKeepDays('developer')).toBe(0);
    expect(checkpointKeepDays('sandbox')).toBe(0);
  });

  it('names the checkpoint before by the environment, the one after by the file', () => {
    const file = { name: 'pool', checkpoint: { before: true, after: 'baseline' } };

    expect(checkpointNameOf(file, 'before')).toBe('pool before');
    expect(checkpointNameOf(file, 'after')).toBe('baseline');
    expect(checkpointNameOf({ name: 'pool', checkpoint: { after: false } }, 'after')).toBe(
      undefined,
    );
    expect(checkpointNameOf({ name: 'pool' }, 'before')).toBe(undefined);
  });
});

describe('the lines of the checkpoint script', () => {
  const argv = (line: string[]) => ['node', 'sandforge-checkpoint.ts', ...line];
  const base = { org: 'pool-1', store: STORE };

  it('gives an estimate and a take lines the checkpoint script reads, the file’s fields not compared among them', () => {
    expect(
      parseCheckpointArgs(
        argv(checkpointEstimateLine({ ...base, ignoreFields: ['Case.Last_Touched__c'] })),
      ),
    ).toMatchObject({
      command: 'take',
      org: 'pool-1',
      storeRoot: STORE,
      estimate: true,
      json: true,
    });
    expect(
      parseCheckpointArgs(
        argv(
          checkpointTakeLine({
            ...base,
            name: 'pool before',
            keepDays: 30,
            ignoreFields: ['Case.Last_Touched__c'],
          }),
        ),
      ),
    ).toMatchObject({
      command: 'take',
      estimate: false,
      take: {
        name: 'pool before',
        mode: 'everything',
        keepDays: 30,
        ignoredFields: ['Case.Last_Touched__c'],
      },
    });
  });

  it('gives a preview, a rewind and its dry run, and a deletion lines it reads, the checkpoint named by its id', () => {
    expect(
      parseCheckpointArgs(argv(checkpointPreviewLine({ ...base, checkpoint: CK }))),
    ).toMatchObject({
      command: 'preview',
      checkpoint: CK,
      failOnChange: false,
    });
    const rewind = (dryRun: boolean, accept: boolean) =>
      parseCheckpointArgs(
        argv(
          checkpointRewindLine({
            ...base,
            checkpoint: CK,
            dryRun,
            acceptAutomation: accept,
            acceptNoUndo: accept,
            acceptUnseen: accept,
          }),
        ),
      );
    expect(rewind(false, true)).toMatchObject({
      command: 'rewind',
      checkpoint: CK,
      dryRun: false,
      yes: true,
      acceptAutomation: true,
      acceptNoUndo: true,
      acceptRecreate: false,
      acceptUnseen: true,
    });
    expect(rewind(true, false)).toMatchObject({
      dryRun: true,
      yes: false,
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptUnseen: false,
    });
    expect(
      parseCheckpointArgs(argv(checkpointDeleteLine({ ...base, checkpoint: CK }))),
    ).toMatchObject({ command: 'delete', checkpoint: CK, all: false, yes: true });
  });

  it('refuses a value that reads as a flag, and a checkpoint named by anything but its id', () => {
    expect(() => checkpointEstimateLine({ org: '--all', store: STORE })).toThrow('reads as a flag');
    expect(() => checkpointPreviewLine({ ...base, checkpoint: 'latest' })).toThrow();
  });
});

describe('the steps a plan lists', () => {
  const file = { name: 'pool', checkpoint: { before: true, after: 'baseline' } };

  it('takes the one before ahead of the first write of an environment no apply wrote, and the one after when an apply writes or none is kept', () => {
    expect(checkpointStepsOf(file, undefined, true)).toEqual([
      { step: 'before', name: 'pool before' },
      { step: 'after', name: 'baseline' },
    ]);
    // Nothing to write: no take before, and the one after only when the state names none.
    expect(checkpointStepsOf(file, undefined, false)).toEqual([
      { step: 'after', name: 'baseline' },
    ]);
    const kept = stateOf({ before: OLD, after: CK });
    expect(checkpointStepsOf(file, kept, false)).toEqual([]);
    expect(checkpointStepsOf(file, kept, true)).toEqual([{ step: 'after', name: 'baseline' }]);
    // A destroy took everything back and deleted them: the next apply starts over.
    expect(checkpointStepsOf(file, stateOf(undefined, 'destroyed'), true)).toEqual([
      { step: 'before', name: 'pool before' },
      { step: 'after', name: 'baseline' },
    ]);
  });

  it('takes no checkpoint before of an environment an earlier apply wrote without one, and warns of it', () => {
    const written = stateOf({ after: CK });

    expect(checkpointStepsOf(file, written, true)).toEqual([{ step: 'after', name: 'baseline' }]);
    expect(checkpointWarningsOf(file, written)).toEqual([
      expect.stringContaining('it is not taken now, since a rewind to it would keep those records'),
    ]);
    expect(checkpointWarningsOf(file, undefined)).toEqual([]);
    expect(checkpointWarningsOf(file, stateOf({ before: OLD }))).toEqual([]);
  });

  it('reads the checkpoint script’s estimate, its refusal, and an answer that does not read', () => {
    const estimate = {
      records: 120,
      apiRequests: 31,
      apiRequestsLeft: 14_000,
      seconds: 4.5,
      bytes: 4_096,
    };

    expect(
      estimateReadOf(ran(0, { mode: 'everything', objects: [], leftOut: [], estimate })),
    ).toEqual({
      estimate: { records: 120, apiRequests: 31, seconds: 4.5, bytes: 4_096 },
    });
    const refusal = { code: 'PERMISSIONS', message: 'Modify All Data is missing.' };
    expect(estimateReadOf(ran(1, { mode: 'everything', refusal }))).toEqual({ refusal });
    expect(estimateReadOf(ran(1, undefined, 'it could not reach the org\n'))).toEqual({
      unread: 'exit 1: it could not reach the org',
    });
  });

  it('lists each take with the estimate, refuses the apply for a refusal, and counts the requests of both', () => {
    const steps = checkpointStepsOf(file, undefined, true);
    const estimate = { records: 120, apiRequests: 31, seconds: 4.5, bytes: 4_096 };
    const listed = planCheckpointsOf(steps, { estimate });

    expect(listed).toEqual([
      { step: 'before', name: 'pool before', estimate },
      { step: 'after', name: 'baseline', estimate },
    ]);
    expect(checkpointRequestsOf(listed)).toEqual({ estimate: 62, notCounted: [] });
    expect(checkpointRefusalOf(listed)).toBeUndefined();

    const refused = planCheckpointsOf(steps, {
      refusal: { code: 'TOO_MANY_RECORDS', message: 'More than 500,000 records.' },
    });
    expect(checkpointRefusalOf(refused)).toBe(
      "The checkpoint the file asks before the first write, 'pool before', would be refused: " +
        "More than 500,000 records. The checkpoint the file asks once applied, 'baseline', would " +
        'be refused: More than 500,000 records. Take checkpoint.before or checkpoint.after out of ' +
        'the file, or fix what refuses it.',
    );
    expect(checkpointRequestsOf(planCheckpointsOf(steps, undefined)).notCounted).toEqual([
      'the checkpoint before the first write, not estimated',
      'the checkpoint once applied, not estimated',
    ]);
  });
});

describe('the whole org against the checkpoint after the last apply', () => {
  const preview = (differs: boolean) => ({
    checkpoint: { id: CK, name: 'baseline', takenAt: '2026-10-25T09:00:00.000Z', org: 'pool-1' },
    toDelete: differs ? 1 : 0,
    toGiveBack: differs ? 2 : 0,
    toBringBack: 0,
    toRecreate: 0,
    differs,
    diff: {
      objects: differs
        ? [{ objectApiName: 'Account', lastChangedBy: { '005xx000001gPLEAY': 3 }, touched: 0 }]
        : [],
      userNames: { '005xx000001gPLEAY': 'Colleague' },
      unread: [],
    },
    estimate: { records: 2, apiRequests: 5, apiRequestsLeft: 14_000, seconds: 1, bytes: 0 },
  });

  it('reads its preview: whether the org differs, and what a rewind to it would do', () => {
    expect(driftOf(CK, ran(0, preview(true)))).toEqual({
      checkpoint: CK,
      differs: true,
      toDelete: 1,
      toGiveBack: 2,
      toBringBack: 0,
    });
    expect(driftOf(CK, ran(0, preview(false)))).toMatchObject({ differs: false });
  });

  it('never takes an org it could not compare for one that does not differ', () => {
    expect(driftOf(CK, ran(1, { refusal: { code: 'OTHER_ORG', message: 'another org' } }))).toEqual(
      { checkpoint: CK, differs: false, unread: 'another org' },
    );
    expect(driftOf(CK, ran(1, undefined, 'no answer\n'))).toEqual({
      checkpoint: CK,
      differs: false,
      unread: 'exit 1: no answer',
    });
  });

  it('says the takes and the drift in lines', () => {
    expect(
      checkpointPlanLines({
        checkpoints: [
          {
            step: 'after',
            name: 'baseline',
            refusal: { code: 'PERMISSIONS', message: 'Modify All Data is missing.' },
            unread: 'exit 1',
          },
        ],
        drift: { checkpoint: CK, differs: true, toDelete: 1, toGiveBack: 2, toBringBack: 0 },
      }),
    ).toEqual([
      "checkpoint once applied: 'baseline', not estimated (exit 1)",
      '           refused: Modify All Data is missing.',
      `the whole org against the checkpoint after the last apply (${CK}): differs, 1 to delete · 2 to give back · 0 to bring back`,
    ]);
  });
});

describe('a take and a deletion, through the checkpoint script', () => {
  const org = { alias: 'pool-1', kind: 'scratch' as const };
  const deps = (answer: CommandRun) => {
    const lines: string[][] = [];
    const runner: CommandRunner = async (script, args) => {
      expect(script).toBe(CHECKPOINT_SCRIPT);
      lines.push([...args]);
      return answer;
    };
    return { deps: { runner, journalDir: '/journal', say: () => undefined }, lines };
  };
  const signal = new AbortController().signal;

  it('takes one under its name, kept as long as the org’s kind says, and gives its id', async () => {
    const answer = {
      checkpoint: { checkpointId: CK, name: 'pool before', takenAt: '2026-10-25T09:00:00.000Z' },
      requests: { total: 9 },
    };
    const { deps: d, lines } = deps(ran(0, answer));

    const taken = await takeEnvCheckpoint(d, { org, step: 'before', name: 'pool before' }, signal);

    expect(taken).toEqual({
      result: { step: 'before', checkpoint: CK, exitCode: 0, answer },
      checkpoint: CK,
    });
    expect(lines[0]).toEqual(
      expect.arrayContaining(['take', '--name', 'pool before', '--keep-days', '30']),
    );
    // What it answers is kept as it printed it, every key of it.
    expect(readCheckpointTake(JSON.stringify(answer))).not.toHaveProperty('requests');
  });

  it('gives no id for a take refused or one that answered nothing, and says why', async () => {
    const refused = await takeEnvCheckpoint(
      deps(ran(1, { refusal: { code: 'RUN_WRITING', message: 'A run writes to it.' } })).deps,
      { org, step: 'after', name: 'baseline' },
      signal,
    );
    const silent = await takeEnvCheckpoint(
      deps(ran(0, undefined, 'it stopped\n')).deps,
      { org, step: 'after', name: 'baseline' },
      signal,
    );

    expect(refused).toEqual({
      result: {
        step: 'after',
        exitCode: 1,
        refusal: 'RUN_WRITING: A run writes to it.',
        answer: { refusal: { code: 'RUN_WRITING', message: 'A run writes to it.' } },
      },
    });
    // A 0 with no checkpoint is no take.
    expect(silent.result).toEqual({ step: 'after', exitCode: 1, refusal: 'exit 0: it stopped' });
  });

  it('deletes one, takes one no longer kept for deleted, and says one a run keeps', async () => {
    const deleted = await deleteEnvCheckpoint(
      deps(ran(0, { deleted: [CK], kept: [] })).deps,
      { org, checkpoint: CK, why: 'taken back' },
      signal,
    );
    const gone = await deleteEnvCheckpoint(
      deps(ran(1, { refusal: { code: 'NOT_FOUND', message: 'No checkpoint is kept.' } })).deps,
      { org, checkpoint: CK, why: 'taken back' },
      signal,
    );
    const kept = await deleteEnvCheckpoint(
      deps(ran(1, { deleted: [], kept: [CK] })).deps,
      { org, checkpoint: CK, why: 'taken back' },
      signal,
    );

    expect(deleted).toEqual({ step: 'delete', checkpoint: CK, exitCode: 0 });
    expect(gone).toEqual({ step: 'delete', checkpoint: CK, exitCode: 0 });
    expect(kept).toEqual({
      step: 'delete',
      checkpoint: CK,
      exitCode: 1,
      refusal: 'kept: a take, a rewind or an undo of the org is running',
    });
  });

  it('names a state’s checkpoints, the one after first, and writes one in or out of it', () => {
    const state = stateOf({ before: OLD, after: CK });

    expect(checkpointsOfState(state)).toEqual([
      { step: 'after', checkpoint: CK },
      { step: 'before', checkpoint: OLD },
    ]);
    expect(withCheckpoint(state, 'after', undefined).checkpoints).toEqual({ before: OLD });
    expect(
      withCheckpoint(withCheckpoint(state, 'after', undefined), 'before', undefined),
    ).not.toHaveProperty('checkpoints');
    expect(withCheckpoint(stateOf(), 'before', CK).checkpoints).toEqual({ before: CK });
  });
});

describe('a rewind, as the checkpoint script answers it', () => {
  const previewAnswer = {
    checkpoint: { id: CK, name: 'baseline', takenAt: '2026-10-25T09:00:00.000Z', org: 'pool-1' },
    toDelete: 1,
    toGiveBack: 2,
    toBringBack: 1,
    toRecreate: 0,
    differs: true,
    diff: {
      objects: [
        { objectApiName: 'Account', lastChangedBy: { '005xx000001gPLEAY': 2 }, touched: 0 },
        { objectApiName: 'Contact', lastChangedBy: { '005xx000002gPLEAY': 1 }, touched: 0 },
      ],
      userNames: { '005xx000001gPLEAY': 'Colleague' },
      unread: [],
    },
  };

  it('reads its preview: what it does, and who last changed it, by name where the org gives one', () => {
    const preview = rewindPreviewOf(ran(0, previewAnswer));

    expect(preview).toEqual({
      checkpoint: { id: CK, name: 'baseline', takenAt: '2026-10-25T09:00:00.000Z' },
      toDelete: 1,
      toGiveBack: 2,
      toBringBack: 1,
      lastChangedBy: { Colleague: 2, '005xx000002gPLEAY': 1 },
      differs: true,
    });
    if ('refusal' in preview && !('differs' in preview)) throw new Error('refused');
    expect(changedByWords(preview.lastChangedBy)).toBe('Colleague 2, 005xx000002gPLEAY 1');
    expect(rewindPreviewLines('reset', 'pool-1', preview)).toEqual([
      `reset pool-1 to the checkpoint taken after the last apply, 'baseline' (${CK}), taken 2026-10-25T09:00:00.000Z:`,
      '  1 to delete · 2 to give back · 1 to bring back',
      '  last changed by: Colleague 2, 005xx000002gPLEAY 1',
    ]);
    expect(
      rewindPreviewOf(ran(1, { refusal: { code: 'OTHER_ORG', message: 'another org' } })),
    ).toEqual({
      refusal: 'another org',
    });
  });

  it('reads how it ended, from its answer, or from its exit code when it gave none', () => {
    const answer = {
      checkpoint: { id: CK, name: 'baseline' },
      rewindId: 'rw-20261025-090500-e5f6',
      status: 'success',
      deleted: { planned: 1, done: 1, left: 0 },
      givenBack: { planned: 2, done: 2, left: 0 },
      broughtBack: { planned: 1, done: 1, left: 0 },
      undo: { until: '2026-11-09T09:05:00.000Z', cannot: [] },
      residual: [],
      verify: { differences: 0 },
    };

    expect(rewindRanOf(ran(0, answer))).toEqual({
      exitCode: 0,
      status: 'success',
      answer,
      done: { deleted: 1, givenBack: 2, broughtBack: 1, differing: 0 },
      undoUntil: '2026-11-09T09:05:00.000Z',
    });
    expect(rewindRanOf(ran(1, { refusal: { code: 'AUTOMATION', message: 'flows run' } }))).toEqual({
      exitCode: 1,
      status: 'failure',
      answer: { refusal: { code: 'AUTOMATION', message: 'flows run' } },
      refusal: { code: 'AUTOMATION', message: 'flows run' },
    });
    expect(rewindRanOf(ran(130, undefined, 'interrupted\n'))).toMatchObject({
      exitCode: 130,
      status: 'cancelled',
      refusal: { code: 'UNREAD', message: 'exit 130: interrupted' },
    });
  });

  it('offers the undo the checkpoint script offers, in its line, and none for a destroy whose checkpoints are deleted', () => {
    const until = '2026-11-09T09:05:00.000Z';
    const input = {
      verb: 'reset' as const,
      alias: 'pool-1',
      checkpoint: CK,
      journalDir: '/journal',
      deleted: false,
    };
    const success = { exitCode: 0, status: 'success' as const, undoUntil: until };

    const offered = rewindUndoOf(input, success);
    expect(offered).toEqual({
      offered: true,
      until,
      line: `sandforge-checkpoint undo --org pool-1 --checkpoint ${CK} --store ${join('/journal', 'checkpoints')}`,
    });
    expect(undoLine(offered)).toBe(
      `undo it until ${until}, sooner if the recycle bin fills: ${offered.offered ? offered.line : ''}`,
    );
    expect(rewindUndoOf({ ...input, verb: 'destroy', deleted: true }, success)).toEqual({
      offered: false,
      why: expect.stringContaining('the environment’s checkpoints are deleted with it'),
    });
    expect(
      rewindUndoOf(input, { exitCode: 1, status: 'failure', refusal: { code: 'X', message: 'y' } }),
    ).toEqual({ offered: false, why: expect.stringContaining('offers no undo') });
  });

  it('refuses an answer that does not read as the checkpoint script’s, naming it', () => {
    expect(() => readCheckpointTake('{"checkpoint":{}}')).toThrow(StepAnswerError);
    expect(() => readCheckpointTake('not json')).toThrow(
      /sandforge-checkpoint did not answer a take/,
    );
  });
});
