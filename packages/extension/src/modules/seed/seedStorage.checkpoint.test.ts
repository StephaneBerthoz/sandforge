import { afterEach, describe, it, expect, vi } from 'vitest';
import { CRM_STARTER, type RunCheckpointEstimate } from '@sandforge/shared';

import {
  scopeBeforeRun,
  type BeforeRunDeps,
  type BeforeRunOrg,
  type BeforeRunRequest,
} from '../checkpoint/beforeRunCheckpoint.js';
import { scopeCheckpoint, takeCheckpoint, type TakeScope } from '../checkpoint/takeCheckpoint.js';
import { seedRequestsEstimate, seedStorageGate } from './seedStorage.js';

// The scope's reads of the org are the engine's own, tested on the memory
// org; here, what the gate makes of the estimate the port of the checkpoints
// hands it — the disk among it.
vi.mock('../checkpoint/takeCheckpoint.js', () => ({
  scopeCheckpoint: vi.fn(),
  takeCheckpoint: vi.fn(),
  CheckpointTakeStopped: class CheckpointTakeStopped extends Error {},
}));

afterEach(() => {
  vi.mocked(scopeCheckpoint).mockReset();
  vi.mocked(takeCheckpoint).mockReset();
});

/** An org that says it has room, and `remaining` of `max` daily API requests. */
function limits(remaining = 15_000, max = 15_000) {
  return {
    request: vi.fn(async () => ({
      DataStorageMB: { Max: 500, Remaining: 400 },
      DailyApiRequests: { Max: max, Remaining: remaining },
    })),
  };
}

/** What a checkpoint first would cost, as its scope estimates it at the gate. */
function estimateOf(
  apiRequests: number,
  refusal?: RunCheckpointEstimate['refusal'],
): RunCheckpointEstimate {
  return {
    state: 'planned',
    estimate: { records: 38, apiRequests, apiRequestsLeft: 14_000, seconds: 44, bytes: 2_200_000 },
    objects: ['Account', 'Contact'],
    added: [],
    notHeld: [],
    keepDays: 7,
    ...(refusal ? { refusal } : {}),
  };
}

/** The org, as the panel names it to the take. */
const ORG: BeforeRunOrg = {
  orgId: 'org-dev',
  orgName: 'DEV-SB',
  alias: 'DEV-SB',
  username: 'tester@example.com',
  instanceUrl: 'https://example.my.salesforce.com',
  registered: { orgType: 'Sandbox' },
};

/** A seed of the starter template, nothing still running that creates anything. */
const REQUEST: BeforeRunRequest = {
  module: 'seed',
  written: CRM_STARTER.objects.map((object) => object.objectApiName),
  running: { firing: [] },
  request: {},
  operationId: 'seed-run-1',
  tool: 'panel',
  keepDays: 7,
};

/** What the take's scope reads of the org: every object the seed writes, 19 records each, 2 MB in all. */
function scopeRead(): TakeScope {
  return {
    mode: 'picked',
    objects: REQUEST.written.map((objectApiName) => ({
      objectApiName,
      label: objectApiName,
      records: 19,
      undeletable: true,
      leftOutFields: [],
    })),
    leftOut: [],
    estimate: { records: 38, apiRequests: 68, apiRequestsLeft: 14_000, seconds: 44, bytes: 2e6 },
  };
}

describe('seedStorageGate, with a checkpoint taken first', () => {
  it('lets the seed through with its requests and the checkpoint’s exactly what the org has left, and refuses one more, naming both parts', async () => {
    const run = seedRequestsEstimate(CRM_STARTER);

    const fits = await seedStorageGate(
      limits(run + 68),
      CRM_STARTER,
      [],
      'my-dev-org',
      estimateOf(68),
    );
    expect(fits.refusal).toBeUndefined();
    expect(fits.api).toMatchObject({ estimate: run + 68, parts: { run, checkpoint: 68 } });

    const over = await seedStorageGate(
      limits(run + 67),
      CRM_STARTER,
      [],
      'my-dev-org',
      estimateOf(68),
    );
    expect(over.refusedFor).toBe('apiRequests');
    expect(over.refusal).toMatch(
      new RegExp(
        `^The run takes about ${run + 68} API requests \\(68 of them for the checkpoint taken first\\), and my-dev-org has ${run + 67} of its 15000 daily requests left`,
      ),
    );
  });

  it('refuses a seed whose checkpoint the disk of this machine has no room for, as the port of the checkpoints said, before the storage and the requests', async () => {
    vi.mocked(scopeCheckpoint).mockResolvedValue(scopeRead());
    const deps = {
      org: {},
      store: { root: '/store', delete: vi.fn() },
      handler: {},
      // Short of the 2 MB the take keeps and a tenth more.
      freeBytes: vi.fn(async () => 2e6),
    } as unknown as BeforeRunDeps;
    const estimate = await scopeBeforeRun(deps, ORG, REQUEST);
    expect(estimate.refusal?.code).toBe('DISK');

    const transport = limits(3);
    const gate = await seedStorageGate(transport, CRM_STARTER, [], 'my-dev-org', estimate);

    expect(gate.refusedFor).toBe('checkpoint');
    expect(gate.checkpointRefusal?.code).toBe('DISK');
    expect(gate.refusal).toBe(
      'The checkpoint before the run was refused: The checkpoint before the run takes about ' +
        '1.9 MB on this machine, and its disk has 1.9 MB free, less than that and a tenth ' +
        'more: make room, or leave objects out of the checkpoint. Nothing was written. Untick ' +
        'Checkpoint first to run without it, or fix what refuses it.',
    );
    // Nothing was taken, and nothing of the org read but its limits.
    expect(takeCheckpoint).not.toHaveBeenCalled();
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('refuses a seed whose checkpoint would hold none of the objects it writes, by the take’s code', async () => {
    const refusal = {
      code: 'NOTHING_HELD' as const,
      message:
        'The checkpoint before the run would hold none of the objects the run writes. No record was read.',
    };
    const gate = await seedStorageGate(
      limits(),
      CRM_STARTER,
      [],
      'my-dev-org',
      estimateOf(68, refusal),
    );
    expect(gate.refusedFor).toBe('checkpoint');
    expect(gate.checkpointRefusal).toEqual(refusal);
    expect(gate.refusal).toContain('Nothing was written.');
  });

  it('holds a seed that takes no checkpoint as before', async () => {
    const gate = await seedStorageGate(limits(), CRM_STARTER, [], 'my-dev-org');
    expect(gate.refusal).toBeUndefined();
    expect(gate.api).not.toHaveProperty('parts');
    expect(gate).not.toHaveProperty('checkpointRefusal');
  });
});
