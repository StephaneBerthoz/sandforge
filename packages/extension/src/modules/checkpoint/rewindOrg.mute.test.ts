import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  firedOnRemovalStepsOf,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type MutedAutomation,
} from '@sandforge/shared';
import {
  memoryPermissionOrg,
  type MemoryPermissionOrgSetup,
} from '../../test/memoryPermissionOrg.js';
import {
  automationOf,
  changedSince,
  removeTaken,
  request,
  resultOf,
  rewound,
  taken,
  type Taken,
} from '../../test/rewindTestOrg.js';
import {
  muteJournalFileOf,
  mutedOfError,
  muteForRun,
  muteOrgOf,
} from '../forge/AutomationMuteLease.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { heldWhile, muteOfSteps, type MuteOfWrites } from './rewindOrg.js';
import { undoCheckpoint } from './undoCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** An org whose case flow runs before a delete, unless its user holds `Case_Bypass`. */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Case'],
  objects: [
    {
      objectApiName: 'Case',
      flows: [
        {
          apiName: 'Case_Guard',
          label: 'Case guard',
          timing: 'beforeDelete',
          startsOn: 'delete',
          condition: 'read',
          permissions: [{ name: 'Case_Bypass', bypass: true, held: false }],
        },
      ],
      triggers: [{ name: 'CaseTrigger', events: ['afterUndelete'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  bypassGrants: [
    { permission: 'Case_Bypass', permissionSets: [{ name: 'PS_Case', label: 'Case', grants: 1 }] },
  ],
  requests: 2,
};

/** A rewind that brings cases back and deletes others. */
const STEPS: ForgeRemovalSteps = { bringBack: ['Case'], delete: ['Case'] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewind-mute-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function muteOf(setup: MemoryPermissionOrgSetup = {}): {
  mute: MuteOfWrites;
  org: ReturnType<typeof memoryPermissionOrg>;
} {
  const org = memoryPermissionOrg({
    sets: [{ id: '0PSxx0000000001AAA', name: 'PS_Case' }],
    ...setup,
  });
  return {
    org,
    mute: (automation, writes) =>
      muteForRun(async () => muteOrgOf(org.connection), automation, {
        dir,
        renewEveryMs: 0,
        writes,
      }),
  };
}

describe('muteOfSteps', () => {
  it('hands the gate the read with the bypass held: only the trigger after an undelete still runs', async () => {
    const { mute } = muteOf();
    const planned = await muteOfSteps(mute, AUTOMATION, STEPS);
    if ('refusal' in planned) throw new Error(planned.refusal.message);
    expect(firedOnRemovalStepsOf(AUTOMATION, STEPS).map((f) => f.name)).toEqual([
      'CaseTrigger',
      'Case guard',
    ]);
    expect(firedOnRemovalStepsOf(planned.automation!, STEPS).map((f) => f.name)).toEqual([
      'CaseTrigger',
    ]);
    expect(planned.mute?.muted.stillRan).toEqual([
      { objectApiName: 'Case', kind: 'trigger', name: 'CaseTrigger', why: 'noBypass' },
    ]);
  });

  it('refuses the rewind, said as its own refusal, when the mute is refused, with what runs as its plan would leave it for the gates after it', async () => {
    // As the command line's dry run judges them: what the plan's sets keep
    // quiet is not counted, what still runs is.
    const { mute, org } = muteOf({ sandbox: false, edition: 'Enterprise Edition' });
    const planned = await muteOfSteps(mute, AUTOMATION, STEPS);
    expect(planned).toMatchObject({
      refusal: { code: 'MUTE', message: expect.stringContaining('production org') },
      plan: { assign: [expect.objectContaining({ permissionSet: 'PS_Case' })] },
    });
    if (!('refusal' in planned)) throw new Error('the mute was not refused');
    expect(firedOnRemovalStepsOf(planned.automation, STEPS).map((f) => f.name)).toEqual([
      'CaseTrigger',
    ]);
    expect(org.writes).toEqual([]);
  });

  it('leaves the read as it is when no mute was asked', async () => {
    expect(await muteOfSteps(undefined, AUTOMATION, STEPS)).toEqual({ automation: AUTOMATION });
  });
});

describe('heldWhile', () => {
  it('holds the lease from before the first write to the end, and gives it back after a throw too', async () => {
    const { mute, org } = muteOf();
    const planned = await muteOfSteps(mute, AUTOMATION, STEPS);
    if ('refusal' in planned) throw new Error(planned.refusal.message);
    let muted: MutedAutomation | undefined;
    const error = await heldWhile(
      planned.mute,
      'rewind-1',
      async () => {
        expect(org.assignments()).toHaveLength(1);
        throw new Error('stopped');
      },
      (ended) => {
        muted = ended;
      },
    ).catch((err: unknown) => err);
    expect((error as Error).message).toBe('stopped');
    expect(org.assignments()).toEqual([]);
    expect(muted).toMatchObject({ state: 'muted', assigned: ['PS_Case'], released: true });
  });

  it('throws on with what was muted when the act throws, an assignment the org would not take back said with its reason', async () => {
    // As an expired session refuses the read again after the first pass, and
    // then the delete of the assignment.
    const { mute, org } = muteOf({
      refuseDeleting: { '0Paxx0000000001AAA': 'INVALID_SESSION_ID' },
    });
    const planned = await muteOfSteps(mute, AUTOMATION, STEPS);
    if ('refusal' in planned) throw new Error(planned.refusal.message);

    const error = await heldWhile(
      planned.mute,
      'rewind-1',
      async () => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      },
      () => undefined,
    ).catch((err: unknown) => err);

    expect((error as Error).message).toBe('INVALID_SESSION_ID: Session expired or invalid');
    expect(mutedOfError(error)).toMatchObject({
      state: 'muted',
      assigned: ['PS_Case'],
      released: false,
      reason: expect.stringContaining('INVALID_SESSION_ID') as unknown,
    });
    expect(org.assignments()).toHaveLength(1);
  });

  it('hands the act the lease as read back, to check against its plan before it writes, and gives it back whatever the act then does', async () => {
    const { mute, org } = muteOf();
    const planned = await muteOfSteps(mute, AUTOMATION, STEPS);
    if ('refusal' in planned) throw new Error(planned.refusal.message);

    const answer = await heldWhile(
      planned.mute,
      'rewind-1',
      async (held) => held?.outcome.assigned,
      () => undefined,
    );

    expect(answer).toEqual(['PS_Case']);
    expect(org.assignments()).toEqual([]);
  });

  it('writes with nothing held when nothing can be muted, and says so', async () => {
    const { mute, org } = muteOf();
    const planned = await muteOfSteps(mute, { ...AUTOMATION, bypassGrants: [] }, STEPS);
    if ('refusal' in planned) throw new Error(planned.refusal.message);
    let muted: MutedAutomation | undefined;
    expect(
      await heldWhile(
        planned.mute,
        'rewind-1',
        async () => 'done',
        (ended) => {
          muted = ended;
        },
      ),
    ).toBe('done');
    expect(muted?.state).toBe('nothing');
    expect(org.writes).toEqual([]);
  });
});

/** An account flow that runs as an account is updated, kept quiet by the set the org grants its bypass in; it sends nothing. */
const ACCOUNT_GUARD: Partial<ForgeTargetAutomation> = {
  objectsRead: ['Account'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_guard',
          label: 'Account guard',
          timing: 'beforeSave',
          startsOn: 'update',
          condition: 'read',
          permissions: [{ name: 'Skip_Account', bypass: true, held: false }],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Skip_Account',
      permissionSets: [{ name: 'PS_Account', label: 'Account', grants: 1 }],
    },
  ],
};

/** The set the org grants the account flow's bypass in. */
const PS_ACCOUNT = '0PSxx0000000003AAA';

/**
 * A mute planned as a rewind's is, of an org holding {@link PS_ACCOUNT}, its
 * journal in the test's folder; with `left`, a lease another run left there
 * past its end, holding the set assigned, which the take releases first.
 */
function accountMute(left = false): MuteOfWrites {
  const org = memoryPermissionOrg({ sets: [{ id: PS_ACCOUNT, name: 'PS_Account' }] });
  if (left) {
    const assignment = org.assign(PS_ACCOUNT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      muteJournalFileOf(dir, org.organizationId, org.userId),
      JSON.stringify({
        version: 1,
        organizationId: org.organizationId,
        userId: org.userId,
        leases: [
          {
            runId: 'killed',
            host: 'this-machine',
            pid: 300,
            hostStartedAt: '2026-10-30T08:00:00.000Z',
            acquiredAt: '2026-10-30T08:01:00.000Z',
            endsAt: '2026-10-30T08:30:00.000Z',
            needs: [PS_ACCOUNT],
            assigning: [],
            created: [{ id: assignment, permissionSetId: PS_ACCOUNT, permissionSet: 'PS_Account' }],
          },
        ],
      }),
    );
  }
  return (automation, writes) =>
    muteForRun(async () => muteOrgOf(org.connection), automation, {
      dir,
      renewEveryMs: 0,
      writes,
    });
}

/** A checkpoint, and what a colleague did since, which the preview read. */
async function changedAndPreviewed(): Promise<{ t: Taken; previewId: string }> {
  const t = await taken();
  changedSince(t.org);
  const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
  if (!preview.previewed) throw new Error(preview.refusal.message);
  return { t, previewId: preview.diff.previewId };
}

/** What a refusal for the day's requests names its mute's lease by, of `DEV-ED`. */
const LEASE_PART = "to assign and take back the permission sets that mute DEV-ED's automation";

describe("the lease of a checkpoint act's mute, among the requests the day has left", () => {
  afterEach(() => {
    removeTaken();
  });

  it('refuses a rewind whose lease takes it past what the day has left, the lease named', async () => {
    // Its lease assigns one set: seven requests, two of them writes, that
    // the rewind's gate held it to nowhere.
    const priced = await changedAndPreviewed();
    priced.t.org.limits = { Max: 15_000, Remaining: 1 };
    const unmuted = await rewound(priced.t, priced.previewId, {
      deps: { readAutomation: automationOf(ACCOUNT_GUARD) },
      request: { acceptAutomation: true },
    });
    const alone = /takes about (\d+) API requests/.exec(
      unmuted.rewound ? '' : unmuted.refusal.message,
    );
    if (!alone) throw new Error('the rewind was not refused for the day');
    removeTaken();

    const { t, previewId } = await changedAndPreviewed();
    t.org.limits = { Max: 15_000, Remaining: Number(alone[1]) + 6 };
    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: automationOf(ACCOUNT_GUARD), mute: accountMute() },
      request: { acceptAutomation: true },
    });

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringContaining(
          `takes about ${Number(alone[1]) + 7} API requests (7 of them ${LEASE_PART})`,
        ) as unknown,
      },
    });
  });

  it('lets a rewind whose lease fits go, its mute held while it writes', async () => {
    const { t, previewId } = await changedAndPreviewed();
    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: automationOf(ACCOUNT_GUARD), mute: accountMute() },
      request: { acceptAutomation: true },
    });

    expect(resultOf(outcome)).toMatchObject({
      status: 'success',
      mutedAutomation: { state: 'muted', assigned: ['PS_Account'], released: true },
    });
  });

  it('refuses an undo whose lease takes it past what the day has left, the lease named', async () => {
    const { t, previewId } = await changedAndPreviewed();
    const rewind = resultOf(await rewound(t, previewId));
    const read = await t.store.read(t.checkpoint.checkpointId);
    if (!read?.checkpoint) throw new Error('the checkpoint is gone');
    t.org.limits = { Max: 15_000, Remaining: 8 };

    const outcome = await undoCheckpoint(
      {
        org: t.org,
        undelete: (ids) => t.org.undelete(ids),
        store: t.store,
        readAutomation: automationOf(ACCOUNT_GUARD),
        mute: accountMute(),
      },
      {
        ...request(t),
        checkpoint: read.checkpoint,
        rewindId: rewind.rewindId,
        acceptAutomation: true,
      },
    );

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringMatching(
          new RegExp(`^This undo takes about \\d+ API requests \\(7 of them ${LEASE_PART}\\)`),
        ) as unknown,
      },
    });
  });

  it("prices a preview's rewind with its lease and the leases other runs left, which its take releases first", async () => {
    // One lease left past its end, holding its set assigned: the take deletes
    // the assignment first, an eighth request.
    const { t } = await changedAndPreviewed();
    const ask = (muteAutomation: boolean) =>
      previewCheckpoint(
        {
          org: t.org,
          store: t.store,
          readAutomation: automationOf(ACCOUNT_GUARD),
          mute: accountMute(true),
        },
        { ...request(t), muteAutomation },
      );
    const unmuted = await ask(false);
    const muted = await ask(true);
    if (!unmuted.previewed || !muted.previewed) throw new Error('not previewed');

    expect(muted.estimate.apiRequests - unmuted.estimate.apiRequests).toBe(8);

    t.org.limits = { Max: 15_000, Remaining: muted.estimate.apiRequests - 1 };
    const refused = await ask(true);
    expect(refused).toMatchObject({
      previewed: true,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringContaining(`(8 of them ${LEASE_PART})`) as unknown,
      },
    });
  });
});
