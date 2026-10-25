import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envRewindResultSchema, type EnvState } from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { CommandRun, CommandRunner } from '../scriptRunner.js';
import type { EnvStepDeps } from './envApply.js';
import { readEnvFile, type EnvFileResolved } from './envFile.js';
import type { EnvTarget } from './envGuards.js';
import { acquireEnvLock } from './envLock.js';
import {
  rewindEnvironment,
  rewindQuestionOf,
  rewindRefusalOf,
  rewindResultLines,
  rewindTargetOf,
  type EnvRewindInput,
} from './envRewind.js';
import { openEnvStore, type EnvStore } from './envState.js';

/*
 * A reset and a destroy by rewind: what each refuses before the org is read,
 * what it asks, and what it does to the state and the checkpoints once the
 * checkpoint script ran, by what that script answered. The script is stood
 * in for here by its answers, in the shapes it prints; the command line's
 * tests run it whole, on the memory org.
 */

const ORG_ID = '00Dxx0000001gPLEAY';
const BEFORE = 'ck-20261025-085900-a1b2';
const AFTER = 'ck-20261025-090100-c3d4';
const TARGET: EnvTarget = {
  alias: 'pool-1',
  organizationId: ORG_ID,
  kind: 'scratch',
  username: 'u@example.com',
};

let dir: string;
let journalDir: string;
let store: EnvStore;
let resolved: EnvFileResolved;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-rewind-'));
  const project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  journalDir = join(dir, 'journal');
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if ('refusal' in opened) throw new Error(opened.refusal);
  store = opened.store;
  const read = readEnvFile(
    {
      version: 1,
      name: 'pool',
      checkpoint: { before: true, after: 'baseline' },
      resources: {
        accounts: {
          kind: 'seed',
          objects: [
            {
              object: 'Account',
              count: 2,
              fields: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'A' } }],
            },
          ],
        },
      },
    },
    project,
    {},
  );
  if ('refusals' in read) throw new Error(JSON.stringify(read.refusals));
  resolved = read.resolved;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The state of the environment, written to the store, with its checkpoints. */
async function written(
  checkpoints: EnvState['checkpoints'] = { before: BEFORE, after: AFTER },
  status: EnvState['resources'][string]['status'] = 'applied',
): Promise<EnvState> {
  const state: EnvState = {
    version: 1,
    env: 'pool',
    lineage: '7d3f2b4e-8a1c-4f5e-9b6d-2c8e0a1f3b5d',
    serial: 0,
    sandforgeVersion: '1.68.0',
    updatedAt: '2026-10-25T09:00:00.000Z',
    org: { organizationId: ORG_ID, kind: 'scratch', username: 'u@example.com', alias: 'pool-1' },
    file: { digest: 'a'.repeat(64) },
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    resources: {
      accounts: {
        kind: 'seed',
        fingerprint: 'b'.repeat(64),
        dependsOn: [],
        status,
        runs: [
          {
            n: 1,
            script: 'sandforge-seed',
            runId: 'env-pool-accounts-1-x',
            startedAt: '2026-10-25T09:00:00.000Z',
            endedAt: '2026-10-25T09:00:30.000Z',
            exitCode: 0,
            objects: [{ objectApiName: 'Account', created: 2, refused: 0 }],
          },
        ],
      },
    },
  };
  // Written afresh: a test that writes two states keeps the last.
  await store.remove(ORG_ID, 'pool');
  return store.write(state, { serial: 0, lineage: state.lineage });
}

/** A rewind's answer, in the shape `rewind --json` prints it. */
const rewound = (status: string, undo = true) => ({
  checkpoint: { id: AFTER, name: 'baseline', takenAt: '2026-10-25T09:01:00.000Z', org: 'pool-1' },
  rewindId: 'rw-20261025-090500-e5f6',
  status,
  deleted: { planned: 1, done: 1, left: 0 },
  givenBack: { planned: 2, done: 2, left: 0 },
  broughtBack: { planned: 1, done: 1, left: 0 },
  ...(undo ? { undo: { until: '2026-11-09T09:05:00.000Z', cannot: [] } } : {}),
  residual: status === 'partial' ? [{ object: 'Account', reason: 'refused', count: 1 }] : [],
});

/** A runner answering each command of the checkpoint script, and the lines it was given. */
function scripted(answers: Record<string, CommandRun>) {
  const lines: string[][] = [];
  const runner: CommandRunner = async (script, args) => {
    expect(script).toBe('sandforge-checkpoint');
    lines.push([...args]);
    const answer = answers[args[0] ?? ''];
    if (answer === undefined) throw new Error(`no answer for ${args[0] ?? ''}`);
    return answer;
  };
  return { runner, lines };
}

const answered = (code: number, answer: unknown): CommandRun => ({
  code,
  stdout: JSON.stringify(answer),
  stderr: '',
});

function depsOf(runner: CommandRunner, over: Partial<EnvStepDeps> = {}): EnvStepDeps {
  return {
    runner,
    store,
    locksDir: join(dir, 'locks'),
    journalDir,
    orgNow: async () => '2026-10-25T09:05:00.000Z',
    say: () => undefined,
    sandforgeVersion: '1.68.0',
    onStop: () => () => undefined,
    ...over,
  };
}

const input = (verb: 'reset' | 'destroy', state: EnvState | undefined): EnvRewindInput => ({
  verb,
  resolved,
  target: TARGET,
  state,
  acceptAutomation: false,
  acceptNoUndo: false,
});

describe('what a reset and a destroy by rewind refuse before the org is read', () => {
  it('rewinds a reset to the checkpoint after the last apply, a destroy to the one before the first', async () => {
    const state = await written();

    expect(rewindTargetOf('reset', state)).toEqual({ step: 'after', checkpoint: AFTER });
    expect(rewindTargetOf('destroy', state)).toEqual({ step: 'before', checkpoint: BEFORE });
    expect(rewindTargetOf('reset', await written({ before: BEFORE }))).toBeUndefined();
  });

  it('refuses no state, no checkpoint of the step, and a reset of an apply that did not end whole', async () => {
    expect(rewindRefusalOf(input('reset', undefined))?.message).toContain(
      'This machine keeps no state of pool on pool-1: reset rewinds the org to a checkpoint its state names.',
    );
    expect(rewindRefusalOf(input('destroy', await written({ after: AFTER })))).toMatchObject({
      code: 'NO_CHECKPOINT',
      exit: 1,
    });
    const partial = await written({ before: BEFORE, after: AFTER }, 'applying');
    expect(rewindRefusalOf(input('reset', partial))?.message).toContain(
      'accounts is applying: the last apply did not end whole',
    );
    // A destroy by rewind takes the org back to before the first apply, however the last ended.
    expect(rewindRefusalOf(input('destroy', partial))).toBeUndefined();
  });

  it('asks for the alias, naming what it takes back, who last changed it, and that a destroy is not undone', () => {
    const preview = {
      checkpoint: { id: BEFORE, name: 'pool before', takenAt: '2026-10-25T08:59:00.000Z' },
      toDelete: 3,
      toGiveBack: 1,
      toBringBack: 0,
      lastChangedBy: { Colleague: 1, Tester: 3 },
      differs: true,
    };

    expect(rewindQuestionOf(input('destroy', undefined), preview)).toBe(
      'Type pool-1 to rewind it to before pool was first applied: it deletes 3 record(s) created ' +
        'since, gives 1 their values back and brings 0 back from the recycle bin — whoever made ' +
        "these changes, last changed by Tester 3, Colleague 1; the environment's checkpoints are " +
        'then deleted, and this is not undone:',
    );
    expect(rewindQuestionOf(input('reset', undefined), { ...preview, lastChangedBy: {} })).toBe(
      "Type pool-1 to reset it to 'pool before', as pool was applied: it deletes 3 record(s) " +
        'created since, gives 1 their values back and brings 0 back from the recycle bin — ' +
        'whoever made these changes:',
    );
  });
});

describe('a rewind of the environment', () => {
  it('resets the org and leaves the state as it was: its runs are in the org again', async () => {
    const state = await written();
    const { runner, lines } = scripted({ rewind: answered(0, rewound('success')) });

    const outcome = await rewindEnvironment(depsOf(runner), input('reset', state));

    expect(outcome.exitCode).toBe(0);
    expect(envRewindResultSchema.parse(outcome.result)).toMatchObject({
      verb: 'reset',
      checkpoint: { step: 'after', id: AFTER },
      status: 'success',
      undo: { offered: true, until: '2026-11-09T09:05:00.000Z' },
      state: { serial: state.serial },
    });
    expect(lines.map((line) => line[0])).toEqual(['rewind']);
    expect(lines[0]).toEqual(expect.arrayContaining(['--checkpoint', AFTER, '--yes', '--json']));
    expect(await store.read(ORG_ID, 'pool')).toEqual(state);
  });

  it('destroys by rewind: every resource taken back in the state, its checkpoints deleted, no undo offered', async () => {
    const state = await written();
    const { runner, lines } = scripted({
      rewind: answered(0, {
        ...rewound('success'),
        checkpoint: { id: BEFORE, name: 'pool before' },
      }),
      delete: answered(0, { deleted: [AFTER, BEFORE], kept: [] }),
    });
    // The deletion answers with what it was asked to delete.
    const deleting: CommandRunner = async (script, args, signal) => {
      const run = await runner(script, args, signal);
      if (args[0] !== 'delete') return run;
      const at = args.indexOf('--checkpoint');
      return answered(0, { deleted: [args[at + 1]], kept: [] });
    };

    const outcome = await rewindEnvironment(depsOf(deleting), input('destroy', state));

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.undo).toEqual({
      offered: false,
      why: expect.stringContaining('the journal of this rewind among them'),
    });
    expect(outcome.result.deleted?.map((d) => [d.checkpoint, d.exitCode])).toEqual([
      [AFTER, 0],
      [BEFORE, 0],
    ]);
    expect(lines.map((line) => line[0])).toEqual(['rewind', 'delete', 'delete']);
    const after = await store.read(ORG_ID, 'pool');
    expect(after?.resources['accounts']?.status).toBe('destroyed');
    expect(after?.resources['accounts']?.runs.every((run) => run.takenBack === true)).toBe(true);
    expect(after?.checkpoints).toBeUndefined();
    expect(rewindResultLines(outcome.result)).toEqual(
      expect.arrayContaining([
        `  checkpoint ${AFTER} deleted`,
        expect.stringMatching(/^no undo: /),
        `destroy --rewind: success; state serial ${outcome.result.state.serial}`,
      ]),
    );
  });

  it('keeps the state and its checkpoints when the rewind leaves records that differ, and offers its undo', async () => {
    const state = await written();
    const { runner, lines } = scripted({ rewind: answered(3, rewound('partial')) });

    const outcome = await rewindEnvironment(depsOf(runner), input('destroy', state));

    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.status).toBe('partial');
    expect(outcome.result.undo.offered).toBe(true);
    expect(lines.map((line) => line[0])).toEqual(['rewind']);
    expect(await store.read(ORG_ID, 'pool')).toEqual(state);
    expect(rewindResultLines(outcome.result)).toContain(
      `  rewind to ${BEFORE}: exit 3, partial  1 deleted, 2 given back, 1 brought back, 1 still differ`,
    );
  });

  it('says a rewind that would make records again with new Ids is never asked, and how to make it', async () => {
    const state = await written();
    const { runner } = scripted({
      rewind: answered(1, {
        refusal: { code: 'RECREATE', message: '1 Account record(s) deleted since are gone.' },
      }),
    });

    const outcome = await rewindEnvironment(depsOf(runner), input('reset', state));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.refusal).toBe(
      '1 Account record(s) deleted since are gone. reset never makes records again with new Ids, ' +
        'which the state would no longer name: rewind with sandforge-checkpoint itself, then ' +
        'apply again.',
    );
    expect(outcome.result.undo.offered).toBe(false);
  });

  it('refuses, rewinding nothing, while another apply of the org holds its lock, or once the state moved', async () => {
    const state = await written();
    const { runner, lines } = scripted({ rewind: answered(0, rewound('success')) });
    const held = acquireEnvLock(join(dir, 'locks'), ORG_ID, { operation: 'apply', env: 'pool' });
    if ('busy' in held) throw new Error('busy');

    const locked = await rewindEnvironment(depsOf(runner), input('reset', state));
    held.lock.release();
    await store.update(state, (s) => s);
    const moved = await rewindEnvironment(depsOf(runner), input('reset', state));

    expect(locked.exitCode).toBe(1);
    expect(locked.result.refusal).toContain('an apply of pool');
    expect(moved.exitCode).toBe(1);
    expect(moved.result.refusal).toContain('changed since it was read');
    expect(lines).toEqual([]);
  });

  it('ends with the stop’s code when stopped, its journal left for the next run to take up', async () => {
    const state = await written();
    let stop: ((signal: 'SIGTERM') => void) | undefined;
    const runner: CommandRunner = async () => {
      stop?.('SIGTERM');
      return { code: 143, stdout: JSON.stringify(rewound('cancelled')), stderr: '' };
    };

    const outcome = await rewindEnvironment(
      depsOf(runner, {
        onStop: (listen) => {
          stop = listen as (signal: 'SIGTERM') => void;
          return () => undefined;
        },
      }),
      input('reset', state),
    );

    expect(outcome.exitCode).toBe(143);
    expect(outcome.result.status).toBe('cancelled');
  });
});
