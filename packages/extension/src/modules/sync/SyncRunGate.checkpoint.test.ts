import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type {
  ForgeTargetAutomation,
  ForgeTargetFlow,
  RunCheckpointEstimate,
  RunCheckpointTaken,
  StillRunning,
} from '@sandforge/shared';

import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import {
  writePathOrderDefects,
  type BeforeRunTake,
  type WritePathStep,
} from '../checkpoint/beforeRunCheckpoint.js';
import { muteForRun, muteOrgOf } from '../forge/AutomationMuteLease.js';
import {
  gateSyncWrite,
  measureSyncWrite,
  mutingSyncWriteGate,
  syncRunWrites,
  syncWriteGate,
  syncWritesOf,
  takeSyncCheckpoint,
  type SyncCheckpointFirst,
  type SyncCountedWrite,
  type SyncWriteMeasures,
} from './SyncRunGate.js';

/** A flow of the target that creates `creates` as `object` records go in, kept quiet by `bypass` when given. */
function flowOf(label: string, creates: string[], bypass?: string): ForgeTargetFlow {
  return {
    apiName: label.replace(/ /g, '_'),
    label,
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: bypass ? [{ name: bypass, bypass: true, held: false }] : [],
    creates,
  };
}

/**
 * The target's automation: a contact gets a welcome task, which a holder of
 * `Contact_Bypass` (in `PS_Bypass`) keeps quiet, and a contact's asset no
 * bypass keeps quiet; an account gets an entitlement as it goes in.
 */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        flowOf('Welcome task', ['Task'], 'Contact_Bypass'),
        flowOf('Contact asset', ['Asset']),
      ],
      triggers: [],
    },
    {
      objectApiName: 'Account',
      flows: [flowOf('Account entitlement', ['Entitlement'])],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Contact_Bypass',
      permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

/** What the gate reads of a target with room and no email to send. */
function measures(overrides: Partial<SyncWriteMeasures> = {}): SyncWriteMeasures {
  return {
    readStorage: async () => ({
      maxMB: 500,
      remainingMB: 400,
      dailyApiRequests: { max: 15_000, remaining: 14_000 },
    }),
    readApiBudget: async () => ({ max: 15_000, remaining: 14_000 }),
    readAutomation: async () => AUTOMATION,
    readLimits: async () => ({}),
    // An org that delivers none of the emails of its automation: no question.
    readDeliverability: async () => ({ reading: { level: 'withheld' }, requests: 2 }),
    emails: { target: 'DEV-SB', accepted: false },
    confirmAboveRecords: 2_000,
    ...overrides,
  };
}

/**
 * What the run reads of the target from its gate on, beside its writes, in
 * its own part: who it writes as (2), the limits (3), the read of its
 * automation, which says it sent 4, and before the call that updates the
 * five accounts what it writes over, read once, again without the stamps
 * should the target refuse them, and whether its user reads encrypted fields
 * in clear (3).
 */
const GATE_READS = 2 + 3 + AUTOMATION.requests + 3;

/**
 * Of the contacts and the accounts, the rows the target refused sent again,
 * as the gate counts them: a call a pass, two passes, each call of the
 * accounts' update read first.
 */
const SENT_AGAIN = 2 + 2 * 2;

/** 200 contacts inserted, 5 accounts updated: one REST call each. */
const WRITE: SyncCountedWrite = {
  objects: [
    { objectApiName: 'Contact', operation: 'insert', rows: 200 },
    { objectApiName: 'Account', operation: 'update', rows: 5 },
  ],
  alreadyCopied: 0,
};

/** What a checkpoint first would cost, as its scope estimates it at the gate. */
function estimateOf(
  apiRequests: number,
  refusal?: RunCheckpointEstimate['refusal'],
): RunCheckpointEstimate {
  return {
    state: 'planned',
    estimate: { records: 38, apiRequests, apiRequestsLeft: 14_000, seconds: 44, bytes: 2_200_000 },
    objects: ['Contact', 'Account', 'Asset'],
    added: [
      {
        objectApiName: 'Asset',
        reason: "The target's flow 'Contact asset' creates Asset records as Contact records go in.",
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
  name: 'Before Sync run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Contact', 'Account', 'Asset'],
  records: 38,
  bytes: 2_100_000,
  requests: 66,
  added: [],
  notHeld: [],
};

/** A checkpoint first whose scope answers `estimate` and whose take answers `took`. */
function checkpointFirstOf(
  estimate: RunCheckpointEstimate,
  took: () => Promise<BeforeRunTake> = async () => ({ taken: true, checkpoint: TAKEN }),
) {
  return {
    scope: vi.fn(
      async (_written: readonly string[], _running: Pick<StillRunning<unknown>, 'firing'>) =>
        estimate,
    ),
    take: vi.fn(async (_planned: RunCheckpointEstimate) => took()),
  } satisfies SyncCheckpointFirst;
}

/** A question answered `answer`, every question kept. */
function confirmer(answer: 'confirmed' | 'declined' = 'confirmed') {
  return vi.fn(async (_question: WriteConfirmation) => answer);
}

describe('syncWritesOf', () => {
  it('fires what runs on the writes each operation makes: an upsert both, an update no insert', () => {
    const writes = syncWritesOf({
      objects: [
        { objectApiName: 'Contact', operation: 'upsert', rows: 1 },
        { objectApiName: 'Account', operation: 'update', rows: 1 },
        { objectApiName: 'Case', operation: 'delete', rows: 1 },
      ],
    });
    expect([writes('Contact', 'insert'), writes('Contact', 'update')]).toEqual([true, true]);
    expect([writes('Account', 'insert'), writes('Account', 'update')]).toEqual([false, true]);
    expect([writes('Case', 'delete'), writes('Case', 'insert')]).toEqual([true, false]);
    expect(writes('Lead', 'insert')).toBe(false);
  });
});

describe('measureSyncWrite, with a checkpoint taken first', () => {
  it('scopes it on every object the run writes, in the run’s order, and what still runs as it writes them, reading the automation once', async () => {
    const readAutomation = vi.fn(async () => AUTOMATION);
    const first = checkpointFirstOf(estimateOf(68));

    const measured = await measureSyncWrite(
      WRITE,
      measures({ readAutomation, checkpointFirst: first }),
    );

    const [written, running] = first.scope.mock.calls[0];
    expect(written).toEqual(['Contact', 'Account']);
    // Nothing is muted: both contact flows fire on the insert; the account's
    // fires on an insert the run never makes of it.
    expect(running.firing.map(({ name, write }) => `${name}/${write}`)).toEqual([
      'Welcome task/insert',
      'Contact asset/insert',
    ]);
    expect(readAutomation).toHaveBeenCalledTimes(1);
    expect(measured.checkpoint).toEqual(estimateOf(68));
    expect(first.take).not.toHaveBeenCalled();
  });

  it('scopes nothing for a run that writes nothing, and nothing when not asked', async () => {
    const first = checkpointFirstOf(estimateOf(68));
    const none = await measureSyncWrite(
      { objects: [{ objectApiName: 'Contact', operation: 'insert', rows: 0 }], alreadyCopied: 0 },
      measures({ checkpointFirst: first }),
    );
    expect(first.scope).not.toHaveBeenCalled();
    expect(none.checkpoint).toBeUndefined();

    const plain = await measureSyncWrite(WRITE, measures());
    expect(plain.checkpoint).toBeUndefined();
    expect(plain.api).toEqual({
      verdict: 'fits',
      estimate: 2 + SENT_AGAIN + GATE_READS,
      max: 15_000,
      remaining: 14_000,
    });
  });

  it('holds what the automation creates out of the scope when it could not be read, and asks', async () => {
    const first = checkpointFirstOf(estimateOf(68));
    const measured = await measureSyncWrite(
      WRITE,
      measures({
        readAutomation: async () => Promise.reject(new Error('INSUFFICIENT_ACCESS')),
        checkpointFirst: first,
      }),
    );
    expect(first.scope.mock.calls[0][1]).toEqual({ firing: [] });
    expect(measured.check.verdict).toBe('asks');
  });

  it('counts the read-backs of the record types given beside the run’s requests', async () => {
    const measured = await measureSyncWrite({ ...WRITE, readBack: 2 }, measures());
    expect(measured.api).toMatchObject({
      estimate: 4 + SENT_AGAIN + GATE_READS,
      parts: { run: 2 + SENT_AGAIN + GATE_READS, readBack: 2 },
    });
  });

  it('refuses a run the read-backs take past what the target has left, naming them', async () => {
    // The run's 20 fit in the 21 left; with its 2 read-backs, 22 do not.
    const measured = await measureSyncWrite(
      { ...WRITE, readBack: 2 },
      measures({
        readStorage: async () => ({
          maxMB: 500,
          remainingMB: 400,
          dailyApiRequests: { max: 500, remaining: 3 + SENT_AGAIN + GATE_READS },
        }),
      }),
    );
    const answer = await gateSyncWrite(measured, {
      policy: 'refuse',
      org: 'DEV-SB',
      orgTier: 'development',
    });
    expect(answer).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
    expect(answer.go ? '' : answer.message).toMatch(
      /^The run takes about 22 API requests \(2 of them to read back the record types the target gave\), and DEV-SB has 21 of its 500 daily requests left/,
    );
  });
});

describe('gateSyncWrite, with a checkpoint taken first', () => {
  it('lets the run through with its requests and the checkpoint’s exactly what the target has left, and refuses one more before anything is taken, naming both parts', async () => {
    for (const policy of ['ask', 'unattended', 'refuse'] as const) {
      // 2 for the run's writes, 6 for what it sends again and 12 for its
      // reads, 68 for the checkpoint: 88.
      const at = async (remaining: number) => {
        const first = checkpointFirstOf(estimateOf(68));
        const confirm = confirmer();
        const gate = syncWriteGate(
          measures({
            readStorage: async () => ({
              maxMB: 500,
              remainingMB: 400,
              dailyApiRequests: { max: 500, remaining },
            }),
            checkpointFirst: first,
          }),
          { policy, org: 'DEV-SB', orgTier: 'development', confirm },
        );
        return { held: await gate.hold(WRITE), first, confirm };
      };

      const fits = await at(70 + SENT_AGAIN + GATE_READS);
      expect(fits.held.answer, policy).toMatchObject({ go: true, checkpoint: TAKEN });

      const over = await at(69 + SENT_AGAIN + GATE_READS);
      expect(over.held.answer, policy).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
      expect(over.held.answer.go ? '' : over.held.answer.message).toMatch(
        /^The run takes about 88 API requests \(68 of them for the checkpoint taken first\), and DEV-SB has 87 of its 500 daily requests left/,
      );
      expect(over.first.take).not.toHaveBeenCalled();
      expect(over.confirm).not.toHaveBeenCalled();
    }
  });

  it('judges "near" on the sum, and the question says the parts', async () => {
    // 1 550 left of 15 000: the run's 20 leave 1 530; with the checkpoint's 90, 1 440.
    const confirm = confirmer();
    const budget = {
      readStorage: async () => ({
        maxMB: 500,
        remainingMB: 400,
        dailyApiRequests: { max: 15_000, remaining: 1_550 },
      }),
    };
    expect((await measureSyncWrite(WRITE, measures(budget))).api.verdict).toBe('fits');

    const measured = await measureSyncWrite(
      WRITE,
      measures({ ...budget, checkpointFirst: checkpointFirstOf(estimateOf(90)) }),
    );
    await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'DEV-SB',
      orgTier: 'development',
      confirm,
    });

    expect(confirm.mock.calls[0][0].apiRequests).toEqual({
      estimate: 92 + SENT_AGAIN + GATE_READS,
      remaining: 1_550,
      max: 15_000,
      parts: { run: 2 + SENT_AGAIN + GATE_READS, checkpoint: 90 },
    });
  });

  it('asks the user who started the run, saying the checkpoint in the question, though nothing else asks', async () => {
    const confirm = confirmer();
    const first = checkpointFirstOf(estimateOf(68));
    const gate = syncWriteGate(measures({ checkpointFirst: first }), {
      policy: 'ask',
      org: 'DEV-SB',
      orgTier: 'development',
      confirm,
    });

    expect(await gate.measure(WRITE)).toMatchObject({ verdict: 'asks' });
    const held = await gate.hold(WRITE);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].checkpoint).toEqual(estimateOf(68));
    expect(held.answer).toEqual({ go: true, asked: true, checkpoint: TAKEN });
    expect(first.take).toHaveBeenCalledWith(estimateOf(68));
  });

  it('refuses a run whose checkpoint its scope refused, before its question, whoever answers for it, taking nothing', async () => {
    const refusal = {
      code: 'NOTHING_HELD' as const,
      message:
        'The checkpoint before the run would hold none of the objects the run writes. No record was read.',
    };
    for (const policy of ['ask', 'unattended', 'refuse'] as const) {
      const confirm = confirmer();
      const first = checkpointFirstOf(estimateOf(68, refusal));
      const held = await syncWriteGate(measures({ checkpointFirst: first }), {
        policy,
        org: 'DEV-SB',
        orgTier: 'development',
        confirm,
      }).hold(WRITE);

      expect(held.check.verdict, policy).toBe('refused');
      expect(held.answer, policy).toEqual({
        go: false,
        code: 'CHECKPOINT_REFUSED',
        message:
          'The checkpoint before the run was refused: The checkpoint before the run would hold ' +
          'none of the objects the run writes. Nothing was written. Untick Checkpoint first to ' +
          'run without it, or fix what refuses it.',
        refusal,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(first.take).not.toHaveBeenCalled();
    }
  });

  it('refuses a run whose checkpoint could not be scoped, saying why', async () => {
    const first = checkpointFirstOf(estimateOf(68));
    first.scope.mockRejectedValueOnce(new Error('the global describe timed out'));
    const held = await syncWriteGate(measures({ checkpointFirst: first }), {
      policy: 'refuse',
      org: 'DEV-SB',
      orgTier: 'development',
    }).hold(WRITE);

    expect(held.answer).toEqual({
      go: false,
      code: 'CHECKPOINT_REFUSED',
      message:
        'The checkpoint before the run could not be taken: the global describe timed out. ' +
        'Nothing was written.',
    });
    expect(first.take).not.toHaveBeenCalled();
  });

  it('takes nothing for a run declined at its question', async () => {
    const first = checkpointFirstOf(estimateOf(68));
    const held = await syncWriteGate(measures({ checkpointFirst: first }), {
      policy: 'ask',
      org: 'DEV-SB',
      orgTier: 'development',
      confirm: confirmer('declined'),
    }).hold(WRITE);

    expect(held.answer).toMatchObject({ go: false, code: 'SYNC_WRITE_DECLINED' });
    expect(first.take).not.toHaveBeenCalled();
  });

  it('stops the run for a take refused, failed or stopped, nothing written', async () => {
    const refusal = { code: 'RUN_WRITING' as const, message: 'A Forge run is writing to DEV-SB.' };
    const measured = { checkpoint: estimateOf(68) };
    const go = { go: true as const, asked: true };

    expect(
      await takeSyncCheckpoint(measured, go, {
        take: async () => ({ taken: false, refusal }),
      }),
    ).toMatchObject({ go: false, code: 'CHECKPOINT_REFUSED', refusal });
    expect(
      await takeSyncCheckpoint(measured, go, {
        take: async () => Promise.reject(new Error('ECONNRESET')),
      }),
    ).toMatchObject({ go: false, code: 'CHECKPOINT_REFUSED' });
    expect(
      await takeSyncCheckpoint(measured, go, {
        take: async () => ({ taken: false, stopped: true }),
      }),
    ).toMatchObject({ go: false, code: 'RUN_CANCELLED' });
    // Nothing asked first, nothing taken.
    expect(await takeSyncCheckpoint({}, go, { take: vi.fn() })).toBe(go);
  });
});

describe('the write path of a Sync run that mutes and takes a checkpoint first', () => {
  const SET = '0PSxx0000000001AAA';

  /** A muting gate on the memory org, every step it makes put down in `events` as it makes it. */
  function runOf(
    took: () => Promise<BeforeRunTake> = async () => ({ taken: true, checkpoint: TAKEN }),
    setup: Parameters<typeof memoryPermissionOrg>[0] = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-checkpoint-'));
    const events: WritePathStep[] = [];
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'PS_Bypass' }],
      ...setup,
      beforeWrite: (write) => {
        if (write.kind === 'insert') events.push('leaseAcquire');
      },
    });
    /** The assignments the org held as the take began. */
    const heldAtTake: number[] = [];
    const first = checkpointFirstOf(estimateOf(68), () => {
      events.push('checkpointTake');
      heldAtTake.push(org.assignments().length);
      return took();
    });
    const scope = first.scope;
    const checkpointFirst: SyncCheckpointFirst = {
      scope: async (written, running) => {
        events.push('stillRunning');
        return scope(written, running);
      },
      take: first.take,
    };
    const confirm = vi.fn(async (_question: WriteConfirmation) => {
      events.push('question');
      return 'confirmed' as const;
    });
    const muting = mutingSyncWriteGate(
      (read) =>
        syncWriteGate(measures({ readAutomation: read, checkpointFirst }), {
          policy: 'ask',
          org: 'DEV-SB',
          orgTier: 'development',
          confirm,
        }),
      async () => {
        events.push('reads');
        return AUTOMATION;
      },
      (read) => {
        events.push('leasePlan');
        return muteForRun(async () => muteOrgOf(org.connection), read, {
          dir,
          renewEveryMs: 0,
          writes: syncRunWrites,
        });
      },
      'run-1',
      { target: 'DEV-SB' },
    );
    return {
      muting,
      org,
      events,
      heldAtTake,
      first,
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('plans the lease, scopes the checkpoint on what still runs, asks, takes it, then takes the lease before the first write', async () => {
    const run = runOf();
    const held = await run.muting.gate.hold(WRITE);
    expect(held.answer).toEqual({ go: true, asked: true, checkpoint: TAKEN });
    // The run writes, then gives its lease back.
    run.events.push('write');
    await run.muting.release();
    run.events.push('leaseRelease', 'result');

    expect(run.events).toEqual([
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
    expect(writePathOrderDefects(run.events)).toEqual([]);
    expect(run.heldAtTake).toEqual([0]);
    // What the mute keeps quiet creates nothing the checkpoint holds; what
    // still runs does.
    const [, running] = run.first.scope.mock.calls[0];
    expect(running.firing.map(({ name }) => name)).toEqual(['Contact asset']);
    expect(run.first.take).toHaveBeenCalledTimes(1);
    run.done();
  });

  it('assigns nothing and writes nothing when the take is refused', async () => {
    const run = runOf(async () => ({
      taken: false,
      refusal: { code: 'RUN_WRITING', message: 'A Forge run is writing to DEV-SB.' },
    }));
    const held = await run.muting.gate.hold(WRITE);

    expect(held.answer).toMatchObject({ go: false, code: 'CHECKPOINT_REFUSED' });
    expect(run.org.writes).toEqual([]);
    expect(run.org.assignments()).toEqual([]);
    expect(run.events).not.toContain('leaseAcquire');
    run.done();
  });

  it('hands over the lease it took, for the run to give back right after its last write, and gives it back once', async () => {
    const run = runOf();
    expect(run.muting.lease()).toBeUndefined();
    await run.muting.gate.hold(WRITE);

    const lease = run.muting.lease();
    expect(lease?.assigned).toBe(1);
    expect(run.org.assignments().map((a) => a.permissionSetId)).toEqual([SET]);

    await lease?.giveBack();
    expect(run.org.assignments()).toEqual([]);
    // Given back after the last write, the end of the run gives back nothing more.
    const deletes = run.org.writes.filter((write) => write.kind === 'delete').length;
    expect(await run.muting.release()).toMatchObject({ state: 'muted', released: true });
    expect(run.org.writes.filter((write) => write.kind === 'delete')).toHaveLength(deletes);
    run.done();
  });

  it('names the checkpoint taken first when the lease is then refused, for the run to delete as it wrote nothing', async () => {
    const run = runOf(undefined, { refuseAssigning: { [SET]: 'INSUFFICIENT_ACCESS' } });
    const held = await run.muting.gate.hold(WRITE);

    expect(held.answer.go).toBe(false);
    expect(held.answer.checkpoint).toEqual(TAKEN);
    expect(run.org.assignments()).toEqual([]);
    run.done();
  });
});
