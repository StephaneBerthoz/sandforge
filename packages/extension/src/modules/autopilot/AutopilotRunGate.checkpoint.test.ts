import { describe, it, expect, vi } from 'vitest';
import type { ApiName, RunCheckpointEstimate, RunCheckpointTaken } from '@sandforge/shared';

import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import {
  writePathOrderDefects,
  type BeforeRunTake,
  type WritePathStep,
} from '../checkpoint/beforeRunCheckpoint.js';
import type { DataStorage } from '../forge/ForgeRunGate.js';
import {
  autopilotApiCheck,
  autopilotWritePlan,
  gateAutopilotWrite,
  type AutopilotCheckpointFirst,
} from './AutopilotRunGate.js';

/** A plan of the given objects, one wave each. */
function planOf(...objects: string[]) {
  return {
    waves: objects.map((name, order) => ({ order, objects: [name as ApiName], dependsOn: [] })),
  };
}

// 400 accounts and 40 contacts: two REST calls and one.
const plan = autopilotWritePlan(
  planOf('Account', 'Contact'),
  new Map([
    ['Account', 400],
    ['Contact', 40],
  ]),
);

/** A target with room, and `remaining` of `max` requests left today. */
function storageOf(remaining: number, max = 15_000): DataStorage {
  return { maxMB: 500, remainingMB: 400, dailyApiRequests: { max, remaining } };
}

/** What a checkpoint first would cost, as its scope estimates it at the gate. */
function estimateOf(
  apiRequests: number,
  refusal?: RunCheckpointEstimate['refusal'],
): RunCheckpointEstimate {
  return {
    state: 'planned',
    estimate: { records: 520, apiRequests, apiRequestsLeft: 14_000, seconds: 30, bytes: 900_000 },
    objects: ['Account', 'Contact', 'Task'],
    added: [
      {
        objectApiName: 'Task',
        reason: "The target's flow 'Welcome task' creates Task records as Contact records go in.",
      },
    ],
    notHeld: [],
    keepDays: 7,
    ...(refusal ? { refusal } : {}),
  };
}

/** The checkpoint a take kept, as the run names it. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101540-a1b2',
  name: 'Before Autopilot run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Account', 'Contact', 'Task'],
  records: 520,
  bytes: 880_000,
  requests: 12,
  added: [],
  notHeld: [],
};

/** A checkpoint first estimated at `estimate`, whose take answers `took`. */
function firstOf(
  estimate: RunCheckpointEstimate,
  took: () => Promise<BeforeRunTake> = async () => ({ taken: true, checkpoint: TAKEN }),
) {
  const take = vi.fn(async (_planned: RunCheckpointEstimate) => took());
  return { estimate, take } satisfies AutopilotCheckpointFirst;
}

/** The gate's input, a plan that fits, answered `answer`. */
function inputOf(
  storage: DataStorage,
  checkpointFirst: AutopilotCheckpointFirst | undefined,
  answer: 'confirmed' | 'declined' = 'confirmed',
) {
  const confirm = vi.fn(async (_question: WriteConfirmation) => answer);
  return {
    confirm,
    input: {
      plan,
      storage,
      readApiBudget: vi.fn(async () => ({ max: 15_000, remaining: 14_000 })),
      confirmAboveRecords: 2_000,
      org: 'DEV-SB',
      orgTier: 'development' as const,
      confirm,
      ...(checkpointFirst ? { checkpointFirst } : {}),
    },
  };
}

describe('autopilotApiCheck, with a checkpoint taken first', () => {
  it('counts the checkpoint’s requests beside the plan’s', async () => {
    const readApiBudget = vi.fn();
    expect(await autopilotApiCheck(plan, storageOf(14_000), readApiBudget, estimateOf(9))).toEqual({
      verdict: 'fits',
      estimate: 12,
      max: 15_000,
      remaining: 14_000,
      parts: { run: 3, checkpoint: 9 },
    });
    expect(await autopilotApiCheck(plan, storageOf(14_000), readApiBudget)).toEqual({
      verdict: 'fits',
      estimate: 3,
      max: 15_000,
      remaining: 14_000,
    });
  });
});

describe('gateAutopilotWrite, with a checkpoint taken first', () => {
  it('lets the plan through with its requests and the checkpoint’s exactly what the target has left, and refuses one more before anything is taken, naming both parts', async () => {
    // 3 for the plan, 68 for the checkpoint: 71.
    const fits = inputOf(storageOf(71, 500), firstOf(estimateOf(68)));
    expect(await gateAutopilotWrite(fits.input)).toMatchObject({ go: true, checkpoint: TAKEN });

    const first = firstOf(estimateOf(68));
    const over = inputOf(storageOf(70, 500), first);
    const gate = await gateAutopilotWrite(over.input);
    expect(gate).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
    expect(gate.go ? '' : gate.message).toMatch(
      /^The run takes about 71 API requests \(68 of them for the checkpoint taken first\), and DEV-SB has 70 of its 500 daily requests left/,
    );
    expect(first.take).not.toHaveBeenCalled();
    expect(over.confirm).not.toHaveBeenCalled();
  });

  it('judges "near" on the sum, and the question says the parts', async () => {
    // 1 550 left of 15 000: the plan's 3 leave 1 547; with the checkpoint's 90, 1 457.
    const { input, confirm } = inputOf(storageOf(1_550), firstOf(estimateOf(90)));
    await gateAutopilotWrite(input);
    expect(confirm.mock.calls[0][0].apiRequests).toEqual({
      estimate: 93,
      remaining: 1_550,
      max: 15_000,
      parts: { run: 3, checkpoint: 90 },
    });
  });

  it('asks before a small plan that fits, saying the checkpoint, then takes it', async () => {
    const quiet = inputOf(storageOf(14_000), undefined);
    expect(await gateAutopilotWrite(quiet.input)).toMatchObject({ go: true, asked: false });
    expect(quiet.confirm).not.toHaveBeenCalled();

    const first = firstOf(estimateOf(9));
    const { input, confirm } = inputOf(storageOf(14_000), first);
    expect(await gateAutopilotWrite(input)).toEqual({
      go: true,
      check: expect.objectContaining({ verdict: 'fits' }),
      asked: true,
      checkpoint: TAKEN,
    });
    expect(confirm.mock.calls[0][0].checkpoint).toEqual(estimateOf(9));
    expect(first.take).toHaveBeenCalledWith(estimateOf(9));
  });

  it('refuses a plan whose checkpoint its scope refused, before its question and its storage, taking nothing', async () => {
    const refusal = {
      code: 'DISK' as const,
      message: 'This machine has no room. No record was read.',
    };
    const first = firstOf(estimateOf(9, refusal));
    const { input, confirm } = inputOf(
      { maxMB: 5, remainingMB: 0, dailyApiRequests: { max: 15_000, remaining: 14_000 } },
      first,
    );
    expect(await gateAutopilotWrite(input)).toMatchObject({
      go: false,
      code: 'CHECKPOINT_REFUSED',
      message:
        'The checkpoint before the run was refused: This machine has no room. Nothing was ' +
        'written. Untick Checkpoint first to run without it, or fix what refuses it.',
      refusal,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(first.take).not.toHaveBeenCalled();
  });

  it('takes nothing for a plan declined at its question, and stops one whose take is refused or stopped', async () => {
    const declined = firstOf(estimateOf(9));
    expect(
      await gateAutopilotWrite(inputOf(storageOf(14_000), declined, 'declined').input),
    ).toMatchObject({ go: false, code: 'WRITE_DECLINED' });
    expect(declined.take).not.toHaveBeenCalled();

    const refusal = { code: 'RUN_WRITING' as const, message: 'A Sync run is writing to DEV-SB.' };
    expect(
      await gateAutopilotWrite(
        inputOf(
          storageOf(14_000),
          firstOf(estimateOf(9), async () => ({ taken: false, refusal })),
        ).input,
      ),
    ).toMatchObject({ go: false, code: 'CHECKPOINT_REFUSED', refusal });
    expect(
      await gateAutopilotWrite(
        inputOf(
          storageOf(14_000),
          firstOf(estimateOf(9), async () => ({ taken: false, stopped: true })),
        ).input,
      ),
    ).toMatchObject({ go: false, code: 'RUN_CANCELLED' });
  });

  it('asks, then takes the checkpoint, and leaves the lease to its caller once the plan may write', async () => {
    /** The run as its handler makes it: the gate, then the lease and the writes on a plan let through. */
    const run = async (took?: () => Promise<BeforeRunTake>) => {
      const events: WritePathStep[] = ['reads', 'leasePlan', 'stillRunning'];
      let assigned = 0;
      const first = firstOf(estimateOf(9), async () => {
        events.push('checkpointTake');
        return took ? took() : { taken: true, checkpoint: TAKEN };
      });
      const { input } = inputOf(storageOf(14_000), first);
      const gate = await gateAutopilotWrite({
        ...input,
        confirm: async () => {
          events.push('question');
          return 'confirmed';
        },
      });
      if (gate.go) {
        events.push('leaseAcquire');
        assigned++;
        events.push('write', 'leaseRelease');
      }
      events.push('result');
      return { events, assigned };
    };

    const ran = await run();
    expect(ran.events).toEqual([
      'reads',
      'leasePlan',
      'stillRunning',
      'question',
      'checkpointTake',
      'leaseAcquire',
      'write',
      'leaseRelease',
      'result',
    ]);
    expect(writePathOrderDefects(ran.events)).toEqual([]);

    const refused = await run(async () => ({
      taken: false,
      refusal: { code: 'RUN_WRITING', message: 'A Sync run is writing to DEV-SB.' },
    }));
    expect(refused.assigned).toBe(0);
    expect(refused.events).not.toContain('write');
  });
});
