import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgCheckpoint } from '@sandforge/shared';

import {
  scopeBeforeRun,
  takeBeforeRun,
  type BeforeRunDeps,
  type BeforeRunOrg,
  type BeforeRunRequest,
} from './beforeRunCheckpoint.js';
import {
  CheckpointTakeStopped,
  scopeCheckpoint,
  takeCheckpoint,
  type TakeScope,
} from './takeCheckpoint.js';

// The take itself is the engine's own, tested on the memory org; here, what
// a take before a run asks of it, and what it makes of its answers.
vi.mock('./takeCheckpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./takeCheckpoint.js')>();
  return { ...actual, scopeCheckpoint: vi.fn(), takeCheckpoint: vi.fn() };
});

afterEach(() => {
  vi.mocked(scopeCheckpoint).mockReset();
  vi.mocked(takeCheckpoint).mockReset();
});

/** The org, as a command line names it to the take. */
const ORG: BeforeRunOrg = {
  orgId: 'org-dev',
  orgName: 'DEV-SB',
  alias: 'DEV-SB',
  username: 'tester@example.com',
  instanceUrl: 'https://example.my.salesforce.com',
  registered: { orgType: 'Sandbox' },
};

/** A Seed run from the command line, writing Contacts, a flow that still runs adding a Task to each. */
const REQUEST: BeforeRunRequest = {
  module: 'seed',
  written: ['Contact'],
  running: {
    firing: [
      {
        objectApiName: 'Contact',
        kind: 'flow',
        name: 'Welcome task',
        write: 'insert',
        flow: {
          apiName: 'Welcome_Task',
          label: 'Welcome task',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
          creates: ['Task'],
        },
      },
    ],
  },
  request: { excluded: ['Attachment'] },
  operationId: 'seed-run-1',
  tool: 'cli',
  keepDays: 7,
};

const ESTIMATE = { records: 38, apiRequests: 68, apiRequestsLeft: 14_000, seconds: 44, bytes: 2e6 };

/** What a take before a run is given: a store whose disk has `free` bytes, deletions counted. */
function depsOf(free: number | undefined = 1e9) {
  const store = { root: '/store', delete: vi.fn(async () => ({ outcome: 'deleted' as const })) };
  const deps = {
    org: {},
    store,
    handler: {},
    freeBytes: vi.fn(async () => free),
  } as unknown as BeforeRunDeps;
  return { deps, store };
}

/** A scope the take answers, holding `held`. */
function scopeOf(held: string[], extra: Partial<TakeScope> = {}): TakeScope {
  return {
    mode: 'picked',
    objects: held.map((objectApiName) => ({
      objectApiName,
      label: objectApiName,
      records: 19,
      undeletable: true,
      leftOutFields: [],
    })),
    leftOut: [{ objectApiName: 'Attachment', reason: 'Left out as asked.' }],
    estimate: ESTIMATE,
    ...extra,
  };
}

/** A checkpoint the take kept, holding `held`. */
function keptOf(held: string[]): OrgCheckpoint {
  return {
    checkpointId: 'ck-20261022-140512-a1b2',
    name: 'Before Seed run 2026-10-22 14:05 UTC',
    takenAt: '2026-10-22T14:05:40.000Z',
    expiresAt: '2026-10-29T14:05:10.000Z',
    bytes: 4_096,
    scope: { mode: 'picked', leftOut: [] },
    objects: held.map((objectApiName) => ({ objectApiName, records: 2 })),
  } as unknown as OrgCheckpoint;
}

describe('scopeBeforeRun', () => {
  it('asks the take’s scope for the objects the run writes and those added, the unproven left out, then checks the disk', async () => {
    const { deps } = depsOf();
    vi.mocked(scopeCheckpoint).mockResolvedValue(scopeOf(['Contact', 'Task']));

    const estimate = await scopeBeforeRun(deps, ORG, REQUEST);

    expect(scopeCheckpoint).toHaveBeenCalledWith(deps, {
      ...ORG,
      mode: 'picked',
      objects: ['Contact', 'Task'],
      excluded: ['Attachment'],
      nameWithDate: 'Before Seed run {date}',
      keepDays: 7,
      unprovenLeftOut: true,
      beforeRun: { module: 'seed', operationId: 'seed-run-1', tool: 'cli' },
    });
    expect(estimate).toMatchObject({
      state: 'planned',
      objects: ['Contact', 'Task'],
      keepDays: 7,
      notHeld: [
        {
          objectApiName: 'Attachment',
          reason: 'Left out as asked. A rewind leaves its records as they are.',
        },
      ],
    });
    expect(estimate.refusal).toBeUndefined();
    expect(deps.freeBytes).toHaveBeenCalledWith('/store');
  });

  it('refuses one the disk has no room for, and does not read the disk past another refusal', async () => {
    const short = depsOf(ESTIMATE.bytes);
    vi.mocked(scopeCheckpoint).mockResolvedValue(scopeOf(['Contact']));
    expect((await scopeBeforeRun(short.deps, ORG, REQUEST)).refusal?.code).toBe('DISK');

    const refused = depsOf(ESTIMATE.bytes);
    vi.mocked(scopeCheckpoint).mockResolvedValue(
      scopeOf(['Contact'], { refusal: { code: 'API_BUDGET', message: 'The day is spent.' } }),
    );
    expect((await scopeBeforeRun(refused.deps, ORG, REQUEST)).refusal?.code).toBe('API_BUDGET');
    expect(refused.deps.freeBytes).not.toHaveBeenCalled();
  });
});

describe('takeBeforeRun', () => {
  it('takes it as its scope said, and answers with the checkpoint as the run’s result names it', async () => {
    const { deps, store } = depsOf();
    vi.mocked(takeCheckpoint).mockResolvedValue({
      taken: true,
      checkpoint: keptOf(['Contact', 'Task']),
      notChecked: [],
      estimate: ESTIMATE,
    });

    const outcome = await takeBeforeRun(deps, ORG, REQUEST, { estimate: ESTIMATE });

    expect(vi.mocked(takeCheckpoint).mock.calls[0][1]).toMatchObject({
      objects: ['Contact', 'Task'],
      unprovenLeftOut: true,
      beforeRun: { module: 'seed', operationId: 'seed-run-1', tool: 'cli' },
    });
    expect(outcome).toMatchObject({
      taken: true,
      checkpoint: { state: 'taken', objects: ['Contact', 'Task'], records: 4, requests: 68 },
    });
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('refuses one the disk has no room for before the take is asked anything', async () => {
    const { deps } = depsOf(ESTIMATE.bytes);

    const outcome = await takeBeforeRun(deps, ORG, REQUEST, { estimate: ESTIMATE });

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'DISK' } });
    expect(takeCheckpoint).not.toHaveBeenCalled();
  });

  it('answers the take’s refusal, a stop while it read, and its failure as they came', async () => {
    const { deps } = depsOf();
    const lock = { code: 'RUN_WRITING' as const, message: 'A checkpoint is being taken.' };
    vi.mocked(takeCheckpoint).mockResolvedValueOnce({ taken: false, refusal: lock });
    expect(await takeBeforeRun(deps, ORG, REQUEST)).toEqual({ taken: false, refusal: lock });

    vi.mocked(takeCheckpoint).mockRejectedValueOnce(new CheckpointTakeStopped());
    expect(await takeBeforeRun(deps, ORG, REQUEST)).toEqual({ taken: false, stopped: true });

    vi.mocked(takeCheckpoint).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    await expect(takeBeforeRun(deps, ORG, REQUEST)).rejects.toThrow('ENOSPC');
  });

  it('deletes again, and refuses, one that holds none of the objects the run writes', async () => {
    const { deps, store } = depsOf();
    vi.mocked(takeCheckpoint).mockResolvedValue({
      taken: true,
      checkpoint: keptOf(['Task']),
      notChecked: [],
      estimate: ESTIMATE,
    });

    const outcome = await takeBeforeRun(deps, ORG, REQUEST);

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'NOTHING_HELD' } });
    expect(store.delete).toHaveBeenCalledWith('ck-20261022-140512-a1b2');
  });
});
