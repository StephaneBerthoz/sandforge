import { describe, expect, it } from 'vitest';
import { recoveryProgressOf, recoveryStatusSchema, type RecoveryStepId } from '@sandforge/shared';

import { recoveryStatusOf, type RecoveryFacts } from './recoveryStatus.js';

/*
 * Where a sandbox stands after its refresh, each step deduced from what
 * SandForge keeps — the runs, the checkpoints and their replays, the
 * inventories, the notes — and never ticked by hand: only a skip, and a mark
 * done on the two checks a person makes by eye.
 */

const BEFORE = '00Dxx00000AbCdE';
const AFTER = '00Dxx00000FgHiJ';

/** A Full sandbox refreshed this morning, nothing done since. */
function facts(over: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    orgId: 'entry-uat',
    alias: 'UAT',
    tier: 'development',
    kind: 'sandbox',
    sandboxType: 'Full',
    myDomainHost: 'acme--uat.sandbox.my.salesforce.com',
    organizationId: AFTER,
    refresh: {
      detectedAt: '2026-11-18T08:12:00.000Z',
      evidence: 'connection',
      previousOrganizationId: BEFORE,
      organizationId: AFTER,
      cachesForgotten: true,
    },
    acks: { steps: {} },
    checkpointsNow: [],
    ...over,
  };
}

function statusOfStep(over: Partial<RecoveryFacts>, id: RecoveryStepId) {
  return recoveryStatusOf(facts(over)).steps.find((step) => step.id === id);
}

describe('recoveryStatusOf', () => {
  it('lists the ten steps in their order and what to keep for the next refresh, as the contract reads them', () => {
    const status = recoveryStatusOf(facts());
    expect(recoveryStatusSchema.safeParse(status).success).toBe(true);
    expect(status.steps.map((step) => step.id)).toEqual([
      'refresh',
      'users',
      'masking',
      'replay',
      'frozen',
      'testersCheckpoint',
      'deliverability',
      'scheduledJobs',
      'endpoints',
      'handoff',
    ]);
    expect(status.steps[0]).toEqual({
      id: 'refresh',
      status: 'done',
      reason: 'refreshDetected',
      at: '2026-11-18T08:12:00.000Z',
    });
    expect(status.beforeNextRefresh.map((item) => [item.id, item.status])).toEqual([
      ['beforeRefreshCheckpoint', 'todo'],
      ['jobsInventory', 'todo'],
      ['testersList', 'todo'],
      ['automation', 'todo'],
    ]);
  });

  it('counts n of N as the launcher does, the steps that do not apply left out of N', () => {
    const status = recoveryStatusOf(facts());
    // replay, frozen and the jobs have nothing before them: not applicable.
    expect(status).toMatchObject({ done: 1, total: 7 });
    expect(recoveryProgressOf(status.steps)).toEqual({ done: 1, total: 7 });
  });

  it('says no refresh was noticed, and still deduces the steps on the org the sandbox is', () => {
    const status = recoveryStatusOf(
      facts({
        refresh: undefined,
        lastUsersRun: { run: 2, at: '2026-11-17T10:00:00.000Z', status: 'success' },
      }),
    );
    expect(status.steps[0]).toEqual({
      id: 'refresh',
      status: 'notApplicable',
      reason: 'noRefreshDetected',
    });
    expect(status.steps[1]).toMatchObject({ id: 'users', status: 'done' });
    expect(status.refresh).toBeUndefined();
    expect(recoveryStatusSchema.safeParse(status).success).toBe(true);
  });

  it('takes the users done once a run on the org the sandbox is now ended a success', () => {
    expect(
      statusOfStep(
        { lastUsersRun: { run: 1, at: '2026-11-18T09:00:00.000Z', status: 'success' } },
        'users',
      ),
    ).toEqual({
      id: 'users',
      status: 'done',
      reason: 'ranAfterRefresh',
      at: '2026-11-18T09:00:00.000Z',
    });
    // A run that ended partial left users to set up.
    expect(
      statusOfStep(
        { lastUsersRun: { run: 1, at: '2026-11-18T09:00:00.000Z', status: 'partial' } },
        'users',
      ),
    ).toMatchObject({ status: 'todo', reason: 'toDo' });
  });

  it('takes the users as not applicable when the list read found nobody to bring back', () => {
    expect(statusOfStep({ usersToBringBack: 0 }, 'users')).toMatchObject({
      status: 'notApplicable',
      reason: 'noUserToBringBack',
    });
    expect(statusOfStep({ usersToBringBack: 3 }, 'users')).toMatchObject({ status: 'todo' });
  });

  it('takes masking as not applicable where nothing of production was copied', () => {
    for (const over of [
      { sandboxType: 'Developer' as const },
      { sandboxType: 'DeveloperPro' as const },
      { kind: 'scratch' as const, sandboxType: undefined },
    ]) {
      expect(statusOfStep(over, 'masking')).toMatchObject({
        status: 'notApplicable',
        reason: 'nothingCopied',
      });
    }
    // A sandbox whose type was never read may hold production's data.
    expect(statusOfStep({ sandboxType: undefined }, 'masking')).toMatchObject({ status: 'todo' });
    expect(statusOfStep({ maskedAt: '2026-11-18T09:30:00.000Z' }, 'masking')).toEqual({
      id: 'masking',
      status: 'done',
      reason: 'ranAfterRefresh',
      at: '2026-11-18T09:30:00.000Z',
    });
  });

  it('replays the checkpoint of before, done once a replay of it wrote into the org now', () => {
    const checkpointBefore = {
      checkpointId: 'ck-20261117-180000-a1b2',
      name: 'Before refresh',
      takenAt: '2026-11-17T18:00:00.000Z',
    };
    expect(statusOfStep({ checkpointBefore }, 'replay')).toMatchObject({ status: 'todo' });
    expect(
      statusOfStep({ checkpointBefore, replayedAt: '2026-11-18T10:00:00.000Z' }, 'replay'),
    ).toMatchObject({ status: 'done', reason: 'ranAfterRefresh' });
    expect(statusOfStep({}, 'replay')).toMatchObject({
      status: 'notApplicable',
      reason: 'noCheckpointBefore',
    });
  });

  it('lets a sandbox marked Staging replay: the replay is confirmed by typing its name, never refused', () => {
    const status = recoveryStatusOf(
      facts({
        tier: 'staging',
        checkpointBefore: {
          checkpointId: 'ck-20261117-180000-a1b2',
          name: 'Before refresh',
          takenAt: '2026-11-17T18:00:00.000Z',
        },
      }),
    );
    expect(status.tier).toBe('staging');
    expect(status.steps.find((step) => step.id === 'replay')).toMatchObject({ status: 'todo' });
  });

  it('loads the frozen dataset kept on this machine, not applicable without one', () => {
    const frozenManifest = { frozenAt: '2026-11-01T10:00:00.000Z', objects: 4, records: 120 };
    expect(statusOfStep({}, 'frozen')).toMatchObject({ reason: 'noManifest' });
    expect(statusOfStep({ frozenManifest }, 'frozen')).toMatchObject({ status: 'todo' });
    expect(
      statusOfStep({ frozenManifest, frozenLoadedAt: '2026-11-18T11:00:00.000Z' }, 'frozen'),
    ).toMatchObject({ status: 'done', at: '2026-11-18T11:00:00.000Z' });
  });

  it("takes the testers' start from the first checkpoint of the org the sandbox is now", () => {
    expect(
      statusOfStep(
        {
          checkpointsNow: [
            { takenAt: '2026-11-18T15:00:00.000Z', keptUntilDeleted: false },
            { takenAt: '2026-11-18T12:00:00.000Z', keptUntilDeleted: true },
          ],
        },
        'testersCheckpoint',
      ),
    ).toEqual({
      id: 'testersCheckpoint',
      status: 'done',
      reason: 'ranAfterRefresh',
      at: '2026-11-18T12:00:00.000Z',
    });
  });

  it('marks done by hand only the two checks made by eye, and skips any step but the refresh', () => {
    const status = recoveryStatusOf(
      facts({
        acks: {
          steps: { deliverability: 'done', endpoints: 'skipped', users: 'skipped' },
        },
      }),
    );
    const byId = new Map(status.steps.map((step) => [step.id, step]));
    expect(byId.get('deliverability')).toMatchObject({ status: 'done', reason: 'markedDone' });
    expect(byId.get('endpoints')).toMatchObject({ status: 'skipped', reason: 'skipped' });
    expect(byId.get('users')).toMatchObject({ status: 'skipped', reason: 'skipped' });
    expect(recoveryStatusSchema.safeParse(status).success).toBe(true);
  });

  it('takes a step done by what ran over a skip, and a step without object over a skip', () => {
    expect(
      statusOfStep(
        {
          acks: { steps: { users: 'skipped' } },
          lastUsersRun: { run: 1, at: '2026-11-18T09:00:00.000Z', status: 'success' },
        },
        'users',
      ),
    ).toMatchObject({ status: 'done' });
    expect(statusOfStep({ acks: { steps: { replay: 'skipped' } } }, 'replay')).toMatchObject({
      status: 'notApplicable',
    });
  });

  it('compares the jobs with the inventory of before, done once the jobs read since are kept', () => {
    const inventoryBefore = {
      savedAt: '2026-11-17T18:05:00.000Z',
      organizationId: `${BEFORE}AAA`,
      jobs: 6,
    };
    expect(statusOfStep({}, 'scheduledJobs')).toMatchObject({ reason: 'noInventoryBefore' });
    expect(statusOfStep({ inventoryBefore }, 'scheduledJobs')).toMatchObject({ status: 'todo' });
    const status = recoveryStatusOf(
      facts({ inventoryBefore, inventoryNowAt: '2026-11-18T13:00:00.000Z' }),
    );
    expect(status.steps.find((step) => step.id === 'scheduledJobs')).toMatchObject({
      status: 'done',
      at: '2026-11-18T13:00:00.000Z',
    });
    expect(status.beforeNextRefresh[1]).toMatchObject({ id: 'jobsInventory', status: 'done' });
    expect(status.inventoryBefore).toEqual(inventoryBefore);
  });

  it('takes the handoff done once a note of the org the sandbox is now was written', () => {
    expect(statusOfStep({ handoffAt: '2026-11-18T16:00:00.000Z' }, 'handoff')).toMatchObject({
      status: 'done',
      reason: 'ranAfterRefresh',
    });
  });

  it('says a note is kept, which Open opens again, skipped or not', () => {
    expect(recoveryStatusOf(facts()).handoffNote).toBeUndefined();
    const kept = recoveryStatusOf(
      facts({
        handoffAt: '2026-11-18T16:00:00.000Z',
        acks: { steps: { handoff: 'skipped' } },
      }),
    );
    expect(kept.handoffNote).toEqual({ writtenAt: '2026-11-18T16:00:00.000Z' });
  });

  it('offers Masking the objects of the last masking, while the step applies', () => {
    const maskObjects = { objects: ['Contact', 'Lead'], from: 'org' as const };
    expect(recoveryStatusOf(facts({ maskObjects })).maskObjects).toEqual(maskObjects);
    expect(recoveryStatusOf(facts()).maskObjects).toBeUndefined();
    // A Developer sandbox copied nothing to mask.
    expect(
      recoveryStatusOf(facts({ maskObjects, sandboxType: 'Developer' })).maskObjects,
    ).toBeUndefined();
  });

  it('says when the recovery was finished, until it is resumed', () => {
    expect(recoveryStatusOf(facts()).finishedAt).toBeUndefined();
    const finished = recoveryStatusOf(
      facts({ acks: { steps: {}, finishedAt: '2026-11-18T17:00:00.000Z' } }),
    );
    expect(finished.finishedAt).toBe('2026-11-18T17:00:00.000Z');
    expect(recoveryStatusSchema.safeParse(finished).success).toBe(true);
  });

  it('keeps for the next refresh a checkpoint kept until deleted, the list, the inventory and a pipeline', () => {
    const status = recoveryStatusOf(
      facts({
        checkpointsNow: [{ takenAt: '2026-11-18T17:00:00.000Z', keptUntilDeleted: true }],
        inventoryNowAt: '2026-11-18T13:00:00.000Z',
        testersSavedAt: '2026-11-18T09:00:00.000Z',
        refreshPipeline: true,
      }),
    );
    expect(status.beforeNextRefresh).toEqual([
      {
        id: 'beforeRefreshCheckpoint',
        status: 'done',
        reason: 'ready',
        at: '2026-11-18T17:00:00.000Z',
      },
      { id: 'jobsInventory', status: 'done', reason: 'ready', at: '2026-11-18T13:00:00.000Z' },
      { id: 'testersList', status: 'done', reason: 'ready', at: '2026-11-18T09:00:00.000Z' },
      { id: 'automation', status: 'done', reason: 'ready' },
    ]);
  });

  it('keeps nothing for the next refresh with a newest checkpoint that expires', () => {
    const status = recoveryStatusOf(
      facts({
        checkpointsNow: [
          { takenAt: '2026-11-18T17:00:00.000Z', keptUntilDeleted: false },
          { takenAt: '2026-11-18T12:00:00.000Z', keptUntilDeleted: true },
        ],
      }),
    );
    // The next recovery replays the newest: it may be gone by then.
    expect(status.beforeNextRefresh[0]).toMatchObject({ status: 'todo', reason: 'toDo' });
  });

  it('names the facts the page shows beside the steps', () => {
    const status = recoveryStatusOf(
      facts({
        frozenManifest: {
          frozenAt: '2026-11-01T10:00:00.000Z',
          sourceAlias: 'DEV',
          objects: 4,
          records: 120,
        },
        lastUsersRun: { run: 3, at: '2026-11-18T09:00:00.000Z', status: 'partial' },
      }),
    );
    expect(status).toMatchObject({
      orgId: 'entry-uat',
      alias: 'UAT',
      tier: 'development',
      sandboxType: 'Full',
      myDomainHost: 'acme--uat.sandbox.my.salesforce.com',
      organizationId: AFTER,
      frozenManifest: { sourceAlias: 'DEV', objects: 4, records: 120 },
      lastUsersRun: { run: 3, status: 'partial' },
    });
    expect(recoveryStatusSchema.safeParse(status).success).toBe(true);
  });
});
