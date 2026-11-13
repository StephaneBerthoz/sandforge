import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { mutedOfError, muteForRun, muteOrgOf } from '../forge/AutomationMuteLease.js';
import { heldWhile, muteOfSteps, type MuteOfWrites } from './rewindOrg.js';

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
