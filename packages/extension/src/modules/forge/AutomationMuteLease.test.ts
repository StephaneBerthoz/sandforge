import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditMutedOf,
  firedOnInsert,
  type ForgeTargetAutomation,
  type ForgeTargetFlow,
} from '@sandforge/shared';
import {
  memoryPermissionOrg,
  type MemoryPermissionOrgSetup,
} from '../../test/memoryPermissionOrg.js';
import {
  defaultMuteLeasesDir,
  dryRunMuteOf,
  isMuteRefusedError,
  muteForRun,
  muteJournalFileOf,
  muteLeaseRequests,
  muteLines,
  muteOrgOf,
  mutePartOf,
  mutedOfError,
  planMute,
  prepareMute,
  whileMuted,
  type MuteLeaseOptions,
  type MuteOrg,
  type MutePrepared,
  type MuteRefusedError,
} from './AutomationMuteLease.js';
import { linkedLockKind, type LockFileHead } from '../checkpoint/linkedLock.js';

const SET_FLOW = '0PSxx0000000001AAA';
const SET_VR = '0PSxx0000000002AAA';
const OTHER_USER = '005xx0000000009AAA';

/** A flow of Account its condition keeps quiet for a holder of `permission`. */
function bypassed(permission: string, label: string): ForgeTargetFlow {
  return {
    apiName: label.replace(/ /g, '_'),
    label,
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [{ name: permission, bypass: true, held: false }],
    messages: [{ kind: 'email', name: 'Welcome', limit: 'SingleEmail' }],
  };
}

/** The read of a target whose Account flows two bypasses keep quiet, and one trigger nothing does. */
const automation: ForgeTargetAutomation = {
  objectsRead: ['Account'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        bypassed('Account_BypassFlow', 'Account welcome'),
        bypassed('Bypass_VR', 'Account checks'),
      ],
      triggers: [{ name: 'AccountTrigger', events: ['afterInsert'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  bypassGrants: [
    {
      permission: 'Account_BypassFlow',
      permissionSets: [
        {
          name: 'PS_BypassFlow',
          label: 'Bypass flow',
          grants: 1,
          customPermissions: ['Account_BypassFlow'],
        },
      ],
    },
    {
      permission: 'Bypass_VR',
      permissionSets: [
        { name: 'PS_BypassVR', label: 'Bypass VR', grants: 1, customPermissions: ['Bypass_VR'] },
      ],
    },
  ],
  validationRuleBypasses: [],
  requests: 3,
};

/**
 * The trap org's shape: the set that holds the flow's bypass grants a
 * validation rule's too, which keeps two rules of Account quiet.
 */
const liftingTwoRules: ForgeTargetAutomation = {
  ...automation,
  objects: [
    {
      objectApiName: 'Account',
      flows: [bypassed('Account_BypassFlow', 'Account welcome')],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Account_BypassFlow',
      permissionSets: [
        {
          name: 'PS_BypassFlow',
          label: 'Bypass flow',
          grants: 2,
          customPermissions: ['Account_BypassFlow', 'Bypass_VR'],
        },
      ],
    },
  ],
  validationRuleBypasses: [
    { objectApiName: 'Account', name: 'Phone_Required', permissions: ['Bypass_VR'] },
    { objectApiName: 'Account', name: 'Region_Locked', permissions: ['Bypass_VR'] },
  ],
};

const SETS = [
  { id: SET_FLOW, name: 'PS_BypassFlow' },
  { id: SET_VR, name: 'PS_BypassVR' },
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mute-leases-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Leases taken as process `pid` of this machine, the other processes alive
 * unless told. A release it could not finish is tried again past the end of
 * any test, unless the test says when.
 */
function asProcess(pid: number, alive: (pid: number) => boolean = () => true): MuteLeaseOptions {
  return {
    dir,
    self: { host: 'this-machine', pid, startedAt: '2026-10-30T08:00:00.000Z' },
    checks: { isAlive: alive, bootedAt: () => Date.parse('2026-10-30T07:00:00.000Z') },
    renewEveryMs: 0,
    retryEveryMs: 60 * 60_000,
  };
}

/** A release process 100 could not finish, tried again every thirty seconds of the test's clock. */
const RETRY_EVERY_MS = 30_000;

function orgWith(setup: MemoryPermissionOrgSetup = {}) {
  return memoryPermissionOrg({ sets: SETS, ...setup });
}

async function prepared(
  org: ReturnType<typeof orgWith>,
  options: MuteLeaseOptions,
): Promise<MutePrepared> {
  const answer = await prepareMute(muteOrgOf(org.connection), automation, options);
  if ('refused' in answer) throw new Error(`refused: ${answer.refused.message}`);
  return answer;
}

function journalOf(org: ReturnType<typeof orgWith>): { leases: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(muteJournalFileOf(dir, org.organizationId, org.userId), 'utf8'));
}

describe('prepareMute', () => {
  it('plans the sets the user lacks, and hands the gate a read where what they silence no longer fires', async () => {
    const org = orgWith();
    const mute = await prepared(org, asProcess(100));
    expect(mute.plan.assign.map((a) => a.permissionSet)).toEqual(['PS_BypassFlow', 'PS_BypassVR']);
    expect(firedOnInsert(automation)).toBe(3);
    // The gate asks only for what still runs: the trigger, which no bypass keeps quiet.
    expect(firedOnInsert(mute.automation)).toBe(1);
    expect(mute.planned).toMatchObject({ state: 'planned', assigned: [] });
    expect(mute.planned.stillRan).toEqual([
      { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger', why: 'noBypass' },
    ]);
    expect(org.writes).toEqual([]);
  });

  it('refuses a production org whatever the setting, and assigns nothing', async () => {
    const org = orgWith({ sandbox: false, edition: 'Enterprise Edition' });
    const answer = await prepareMute(muteOrgOf(org.connection), automation, asProcess(100));
    expect(answer).toMatchObject({ refused: { code: 'MUTE_PRODUCTION' } });
    expect(org.writes).toEqual([]);
  });

  it('refuses a user who cannot assign permission sets before anything is read of the sets or journaled', async () => {
    const org = orgWith({ canAssign: false, canManageUsers: false });
    const answer = await prepareMute(muteOrgOf(org.connection), automation, asProcess(100));
    expect(answer).toMatchObject({ refused: { code: 'MUTE_NO_RIGHT' } });
    if ('refused' in answer) expect(answer.refused.message).toContain('Assign Permission Sets');
    expect(org.writes).toEqual([]);
    expect(org.queries.some((q) => /FROM PermissionSet\b/.test(q))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a user whose rights the org will not say', async () => {
    const org = orgWith({ canAssign: 'unreadable' });
    const answer = await prepareMute(muteOrgOf(org.connection), automation, asProcess(100));
    expect(answer).toMatchObject({ refused: { code: 'MUTE_NO_RIGHT' } });
  });

  it('takes a user with Manage Users as one who may assign', async () => {
    const org = orgWith({ canAssign: false, canManageUsers: true });
    await expect(prepared(org, asProcess(100))).resolves.toBeDefined();
  });

  it('says when nothing found can be muted, and the run goes on as without the option', async () => {
    const org = orgWith({ canAssign: false });
    const none: ForgeTargetAutomation = { ...automation, bypassGrants: [] };
    const answer = await prepareMute(muteOrgOf(org.connection), none, asProcess(100));
    if ('refused' in answer) throw new Error('refused');
    expect(answer.planned.state).toBe('nothing');
    expect(answer.planned.reason).toContain('nothing found can be muted');
    expect(answer.automation).toBe(none);
    const held = await answer.acquire('run-1');
    expect(await held.release()).toMatchObject({ state: 'nothing' });
    expect(org.writes).toEqual([]);
  });
});

describe('acquiring a lease', () => {
  it('journals the lease before the first assignment', async () => {
    const seen: unknown[] = [];
    const org = orgWith({
      beforeWrite: () => {
        const leases = journalOf(org).leases;
        seen.push(
          leases.map((lease) => ({
            runId: lease['runId'],
            assigning: lease['assigning'],
            created: (lease['created'] as unknown[]).length,
          })),
        );
      },
    });
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    expect(seen[0]).toEqual([{ runId: 'run-1', assigning: [SET_FLOW, SET_VR], created: 0 }]);
    // The second insert finds the first's assignment journaled, its id with it.
    expect(seen[1]).toEqual([{ runId: 'run-1', assigning: [SET_VR], created: 1 }]);
    await held.release();
  });

  it('assigns only the sets the user lacks, and reads them back held', async () => {
    const org = orgWith();
    org.assign(SET_VR);
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    expect(org.writes).toEqual([
      { kind: 'insert', permissionSetId: SET_FLOW, assigneeId: org.userId },
    ]);
    expect(held.outcome).toMatchObject({
      state: 'muted',
      assigned: ['PS_BypassFlow'],
      held: ['PS_BypassVR'],
    });
    const done = await held.release();
    expect(done.released).toBe(true);
    // The user's own assignment stays: the run did not make it.
    expect(org.assignments().map((a) => a.permissionSetId)).toEqual([SET_VR]);
  });

  it('takes as held a set another run assigned between its read and its insert, refused DUPLICATE_VALUE', async () => {
    const org = orgWith({
      beforeWrite: (write) => {
        if (
          write.kind === 'insert' &&
          write.permissionSetId === SET_FLOW &&
          org.assignments().length === 0
        ) {
          org.assign(SET_FLOW);
        }
      },
    });
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    expect(held.outcome.assigned).toEqual(['PS_BypassVR']);
    expect(held.outcome.held).toEqual(['PS_BypassFlow']);
    await held.release();
    expect(org.assignments().map((a) => a.permissionSetId)).toEqual([SET_FLOW]);
  });

  it('takes back what it assigned and refuses when a set cannot be assigned', async () => {
    const org = orgWith({ refuseAssigning: { [SET_VR]: 'FIELD_INTEGRITY_EXCEPTION' } });
    const mute = await prepared(org, asProcess(100));
    const error = await mute.acquire('run-1').catch((err: unknown) => err);
    expect(isMuteRefusedError(error)).toBe(true);
    expect((error as Error).message).toContain('PS_BypassVR could not be assigned');
    expect(org.assignments()).toEqual([]);
    expect(journalOf(org).leases).toEqual([]);
  });

  it('takes back only what it created as it refuses: a set an admin assigned the user meanwhile stays', async () => {
    // The sets not yet tried were looked up by the user and taken back as
    // the run's own: an admin's assignment made while the lease was being
    // taken went with them.
    let admins: string | undefined;
    const org = orgWith({
      refuseAssigning: { [SET_FLOW]: 'FIELD_INTEGRITY_EXCEPTION' },
      beforeWrite: (write) => {
        if (write.kind === 'insert' && write.permissionSetId === SET_FLOW) {
          admins = org.assign(SET_VR);
        }
      },
    });
    const mute = await prepared(org, asProcess(100));
    const error = await mute.acquire('run-1').catch((err: unknown) => err);

    expect(isMuteRefusedError(error)).toBe(true);
    expect((error as Error).message).toBe(
      'PS_BypassFlow could not be assigned to the user the run writes as: The org refused the ' +
        'assignment: FIELD_INTEGRITY_EXCEPTION. Nothing was assigned.',
    );
    expect(org.writes.filter((w) => w.kind === 'delete')).toEqual([]);
    expect(org.assignments()).toEqual([
      { id: admins, assigneeId: org.userId, permissionSetId: SET_VR },
    ]);
    expect(journalOf(org).leases).toEqual([]);
  });

  it('refuses a set the org does not hold before anything is journaled or assigned', async () => {
    const org = memoryPermissionOrg({ sets: [SETS[0]] });
    const mute = await prepared(org, asProcess(100));
    await expect(mute.acquire('run-1')).rejects.toThrow('holds no permission set PS_BypassVR');
    expect(org.writes).toEqual([]);
  });
});

/**
 * `org`, each of its requests to the target counted: one a query, an insert
 * or a delete, and two for who the connection is, as jsforce asks it of a
 * connection that has not asked it before — the API's root, then the
 * identity URL.
 */
function countedOf(org: MuteOrg): { org: MuteOrg; sent: () => number } {
  let sent = 0;
  const one =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>, requests = 1) =>
    (...args: A): Promise<R> => {
      sent += requests;
      return call(...args);
    };
  return {
    org: {
      typeOrg: one(org.typeOrg),
      query: one(org.query),
      identity: one(org.identity, 2),
      createAssignment: one(org.createAssignment),
      deleteAssignment: one(org.deleteAssignment),
    },
    sent: () => sent,
  };
}

describe('what a lease sends the target', () => {
  it('sends, from its take to its release, the requests its plan is priced at: who the run writes as, three reads, each set assigned and taken back', async () => {
    const counted = countedOf(muteOrgOf(orgWith().connection));
    const mute = await prepareMute(counted.org, automation, asProcess(100));
    if ('refused' in mute) throw new Error(mute.refused.message);
    const before = counted.sent();

    const held = await mute.acquire('run-1');
    await held.release();

    expect(counted.sent() - before).toBe(muteLeaseRequests(mute.plan));
    expect(muteLeaseRequests(mute.plan)).toBe(2 + 3 + 2 * 2);
    expect(mutePartOf(mute.plan)).toEqual({ mute: 9 });
  });

  it('sends fewer for a set the user holds already, and nothing for a plan that assigns nothing', async () => {
    const memory = orgWith();
    memory.assign(SET_VR);
    const counted = countedOf(muteOrgOf(memory.connection));
    const mute = await prepareMute(counted.org, automation, asProcess(100));
    if ('refused' in mute) throw new Error(mute.refused.message);
    const before = counted.sent();

    await (await mute.acquire('run-1')).release();

    // One set assigned and taken back, the other held: priced as two.
    expect(counted.sent() - before).toBe(2 + 3 + 2);
    expect(counted.sent() - before).toBeLessThanOrEqual(muteLeaseRequests(mute.plan));
    expect(muteLeaseRequests({ assign: [] })).toBe(0);
    expect(muteLeaseRequests(undefined)).toBe(0);
    expect(mutePartOf({ assign: [] })).toEqual({});
  });
});

describe('releasing a lease', () => {
  it('removes only its own assignments, and keeps one another live lease needs for that lease', async () => {
    const org = orgWith();
    const first = await (await prepared(org, asProcess(100))).acquire('run-a');
    const second = await (await prepared(org, asProcess(200))).acquire('run-b');
    // The second run found both sets held through the first: it assigned none.
    expect(second.outcome.assigned).toEqual([]);
    expect(second.outcome.held).toEqual(['PS_BypassFlow', 'PS_BypassVR']);

    const firstDone = await first.release();
    expect(firstDone.released).toBe(true);
    // The first run ended; the second still writes, and keeps its bypass.
    expect(
      org
        .assignments()
        .map((a) => a.permissionSetId)
        .sort(),
    ).toEqual([SET_FLOW, SET_VR]);
    expect(org.writes.filter((w) => w.kind === 'delete')).toEqual([]);

    await second.release();
    expect(org.assignments()).toEqual([]);
    expect(journalOf(org).leases).toEqual([]);
  });

  it('never touches another user’s assignments', async () => {
    const org = orgWith();
    org.assign(SET_FLOW, OTHER_USER);
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    await held.release();
    expect(org.assignments()).toEqual([
      expect.objectContaining({ assigneeId: OTHER_USER, permissionSetId: SET_FLOW }),
    ]);
  });

  it('keeps the lease past its end when an assignment cannot be taken back, says so, and the next acquire takes it back', async () => {
    const refuse: Record<string, string> = {};
    const org = orgWith({ refuseDeleting: refuse });
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    const [stuck] = org.assignments();
    refuse[stuck.id] = 'UNABLE_TO_LOCK_ROW';
    const done = await held.release();
    expect(done.released).toBe(false);
    expect(done.reason).toContain(
      'PS_BypassFlow (The org refused the delete: UNABLE_TO_LOCK_ROW) could not be taken back',
    );
    expect(org.assignments().map((a) => a.id)).toEqual([stuck.id]);
    expect(journalOf(org).leases).toEqual([
      expect.objectContaining({ runId: 'run-1', endsAt: '1970-01-01T00:00:00.000Z' }),
    ]);

    delete refuse[stuck.id];
    const next = await (await prepared(org, asProcess(100))).acquire('run-2');
    expect(org.writes.filter((w) => w.kind === 'delete' && w.id === stuck.id)).toHaveLength(2);
    await next.release();
    expect(org.assignments()).toEqual([]);
    expect(journalOf(org).leases).toEqual([]);
  });
});

describe('what a release says it did', () => {
  /*
   * A run that ended while another of this machine still wrote under the
   * same sets left them assigned for it, and said `released: true` and
   * "taken back" all the same: its result read what it removed and what the
   * org refused, never what it passed on. The run that took them over, which
   * had assigned neither, took both back as it ended and said nothing of it.
   */
  it('says what it left assigned for another run that needs it, and that run says it took it back', async () => {
    const org = orgWith();
    const first = await (await prepared(org, asProcess(100))).acquire('run-a');
    const second = await (await prepared(org, asProcess(200))).acquire('run-b');

    const firstDone = await first.release();

    expect(firstDone).toMatchObject({
      released: true,
      assigned: ['PS_BypassFlow', 'PS_BypassVR'],
      takenBack: [],
      passed: ['PS_BypassFlow', 'PS_BypassVR'],
    });
    const firstLines = muteLines(firstDone, 'TGT');
    expect(firstLines).toContain(
      '  stays assigned: PS_BypassFlow, PS_BypassVR, for another run that mutes TGT as the ' +
        'same user, which takes them back as it ends',
    );
    expect(firstLines.filter((line) => line.startsWith('  taken back'))).toEqual([]);
    expect(org.assignments()).toHaveLength(2);

    const secondDone = await second.release();

    expect(secondDone).toMatchObject({
      released: true,
      assigned: [],
      held: ['PS_BypassFlow', 'PS_BypassVR'],
      takenBack: ['PS_BypassFlow', 'PS_BypassVR'],
    });
    expect(secondDone.passed).toBeUndefined();
    expect(muteLines(secondDone, 'TGT')).toContain(
      '  taken back: PS_BypassFlow, PS_BypassVR, as the run ended',
    );
    expect(org.assignments()).toEqual([]);
  });

  it('names only what it took back of what it assigned, the rest kept for the run that needs it', async () => {
    const org = orgWith();
    const both = await (await prepared(org, asProcess(100))).acquire('run-a');
    /** A run that mutes the one flow PS_BypassFlow keeps quiet. */
    const flowOnly = await prepareMute(muteOrgOf(org.connection), liftingTwoRules, asProcess(200));
    if ('refused' in flowOnly) throw new Error(flowOnly.refused.message);
    const other = await flowOnly.acquire('run-b');

    const done = await both.release();

    expect(done).toMatchObject({
      released: true,
      takenBack: ['PS_BypassVR'],
      passed: ['PS_BypassFlow'],
    });
    expect(muteLines(done, 'TGT').slice(-2)).toEqual([
      '  taken back: PS_BypassVR, as the run ended',
      '  stays assigned: PS_BypassFlow, for another run that mutes TGT as the same user, which ' +
        'takes it back as it ends',
    ]);
    expect(org.assignments().map((a) => a.permissionSetId)).toEqual([SET_FLOW]);
    await other.release();
    expect(org.assignments()).toEqual([]);
  });
});

describe('a lease that no longer holds', () => {
  /** A journal left by a run of process `pid` that ended `endsAt`, having created `created`. */
  function leftBehind(
    org: ReturnType<typeof orgWith>,
    pid: number,
    endsAt: string,
    created: Array<{ id: string; permissionSetId: string; permissionSet: string }>,
    assigning: string[] = [],
  ): void {
    const file = muteJournalFileOf(dir, org.organizationId, org.userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        organizationId: org.organizationId,
        userId: org.userId,
        leases: [
          {
            runId: 'crashed',
            host: 'this-machine',
            pid,
            hostStartedAt: '2026-10-30T08:00:00.000Z',
            acquiredAt: '2026-10-30T08:01:00.000Z',
            endsAt,
            needs: created.map((c) => c.permissionSetId),
            assigning,
            created,
          },
        ],
      }),
    );
  }

  it('releases at the next acquire a lease whose process is gone', async () => {
    const org = orgWith();
    const left = org.assign(SET_FLOW);
    leftBehind(org, 999, '2099-01-01T00:00:00.000Z', [
      { id: left, permissionSetId: SET_FLOW, permissionSet: 'PS_BypassFlow' },
    ]);
    const held = await (
      await prepared(
        org,
        asProcess(100, (pid) => pid !== 999),
      )
    ).acquire('run-1');
    // Taken back, then assigned anew for this run, which owns it now.
    expect(org.writes[0]).toEqual({ kind: 'delete', id: left });
    expect(held.outcome.assigned).toEqual(['PS_BypassFlow', 'PS_BypassVR']);
    await held.release();
    expect(org.assignments()).toEqual([]);
  });

  it('releases at the next acquire a lease past its end, though its process still runs', async () => {
    const org = orgWith();
    const left = org.assign(SET_VR);
    leftBehind(org, 300, '2026-10-30T08:30:00.000Z', [
      { id: left, permissionSetId: SET_VR, permissionSet: 'PS_BypassVR' },
    ]);
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    expect(org.writes[0]).toEqual({ kind: 'delete', id: left });
    expect(journalOf(org).leases.map((l) => l['runId'])).toEqual(['run-1']);
    await held.release();
  });

  it('looks up a set a dead process was assigning when it died, and takes it back as its own', async () => {
    const org = orgWith();
    const orphan = org.assign(SET_FLOW);
    leftBehind(org, 999, '2099-01-01T00:00:00.000Z', [], [SET_FLOW]);
    const held = await (
      await prepared(
        org,
        asProcess(100, (pid) => pid !== 999),
      )
    ).acquire('run-1');
    expect(org.writes[0]).toEqual({ kind: 'delete', id: orphan });
    await held.release();
    expect(org.assignments()).toEqual([]);
  });

  /*
   * What a dead process was assigning is found by the user and the set: no
   * field of an assignment read so far tells the run's from one an admin
   * made the user since. The run took such an assignment back as it took its
   * lease, and said nothing of it.
   */
  it('says what it took back of a run that ended as it assigned it, found by user and set: one an admin made since goes with it', async () => {
    const org = orgWith();
    leftBehind(org, 999, '2099-01-01T00:00:00.000Z', [], [SET_FLOW]);
    // Assigned by an admin once the dead run had journaled the set.
    const admins = org.assign(SET_FLOW);

    const held = await (
      await prepared(
        org,
        asProcess(100, (pid) => pid !== 999),
      )
    ).acquire('run-1');

    expect(org.writes[0]).toEqual({ kind: 'delete', id: admins });
    expect(held.outcome.tookBackOfEnded).toEqual(['PS_BypassFlow']);
    expect(muteLines(held.outcome, 'TGT')).toContain(
      '  taken back before the run: PS_BypassFlow, found assigned to the user the run writes as ' +
        'for a run whose process ended as it assigned it; found by user and set, not by id: ' +
        'had an admin assigned it to that user since, theirs went with it',
    );
    const done = await held.release();
    expect(done.tookBackOfEnded).toEqual(['PS_BypassFlow']);
    expect(org.assignments()).toEqual([]);
  });

  /*
   * A run assigns its sets one after the other, and journals each as the org
   * answers it: a process that dies between an assignment and its line
   * leaves that set first in `assigning`, and those after it never asked of
   * the org. Each was looked up by user and set all the same, and taken back
   * as the dead run's: an admin's assignment of a set that run never got to
   * went with it.
   */
  it('looks up only the set a dead process was assigning as it died, never those it had not tried', async () => {
    const org = orgWith();
    // Died as it assigned PS_BypassFlow: PS_BypassVR was never asked of the org.
    leftBehind(org, 999, '2099-01-01T00:00:00.000Z', [], [SET_FLOW, SET_VR]);
    // Assigned by an admin once the dead run had journaled its lease.
    const admins = org.assign(SET_VR);

    const held = await (
      await prepared(
        org,
        asProcess(100, (pid) => pid !== 999),
      )
    ).acquire('run-1');

    expect(org.writes.filter((w) => w.kind === 'delete')).toEqual([]);
    expect(held.outcome).toMatchObject({ assigned: ['PS_BypassFlow'], held: ['PS_BypassVR'] });
    expect(held.outcome.tookBackOfEnded).toBeUndefined();
    const done = await held.release();
    expect(done).toMatchObject({ released: true, takenBack: ['PS_BypassFlow'] });
    expect(org.assignments()).toEqual([
      { id: admins, assigneeId: org.userId, permissionSetId: SET_VR },
    ]);
  });

  it('says nothing of a run that ended when it found nothing it was assigning', async () => {
    const org = orgWith();
    leftBehind(org, 999, '2099-01-01T00:00:00.000Z', [], [SET_FLOW]);
    const held = await (
      await prepared(
        org,
        asProcess(100, (pid) => pid !== 999),
      )
    ).acquire('run-1');
    expect(held.outcome.tookBackOfEnded).toBeUndefined();
    expect(muteLines(held.outcome, 'TGT').join('\n')).not.toContain('before the run');
    await held.release();
  });

  it('keeps a live lease of another process, and its assignments', async () => {
    const org = orgWith();
    const theirs = org.assign(SET_FLOW);
    leftBehind(org, 400, '2099-01-01T00:00:00.000Z', [
      { id: theirs, permissionSetId: SET_FLOW, permissionSet: 'PS_BypassFlow' },
    ]);
    const held = await (await prepared(org, asProcess(100))).acquire('run-1');
    expect(held.outcome.held).toEqual(['PS_BypassFlow']);
    await held.release();
    expect(org.assignments().map((a) => a.id)).toEqual([theirs]);
    expect(journalOf(org).leases.map((l) => l['runId'])).toEqual(['crashed']);
  });
});

describe('what a run says of a journal it cannot use', () => {
  /*
   * A journal is named by the start of the org's id and of the user's, and
   * what a run says of it goes to its output and to a pipeline's log. Run
   * for real, a run refused for a journal another process held printed the
   * journal's path, both ids in its name.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Leases taken as process 100 while process `holder` holds the journal's
   * lock: each look at the holder finds it alive a minute and a second
   * later, so that the run's minute of waiting ends at its first look.
   */
  function waitingOn(holder: number): MuteLeaseOptions {
    const options = asProcess(100);
    return {
      ...options,
      checks: {
        ...options.checks,
        isAlive: (pid) => {
          if (pid === holder) vi.setSystemTime(Date.now() + 61_000);
          return true;
        },
      },
    };
  }

  /** The journal's lock, taken by process `pid` of this machine, and held. */
  function lockedBy(org: ReturnType<typeof orgWith>, pid: number): void {
    const kind = linkedLockKind<LockFileHead>((content) => content as LockFileHead);
    const taken = kind.acquire(
      `${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`,
      (head) => head,
      { self: { host: 'this-machine', pid, startedAt: '2026-10-30T08:00:00.000Z' } },
    );
    expect('lock' in taken).toBe(true);
  }

  /** When the journal's lock stops holding whatever its process does: a day after it was taken. */
  function lockHoldsUntil(org: ReturnType<typeof orgWith>): string {
    const lock = JSON.parse(
      readFileSync(`${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`, 'utf8'),
    ) as LockFileHead;
    return new Date(Date.parse(lock.acquiredAt) + 24 * 60 * 60_000).toISOString();
  }

  /*
   * A run locks the journal for the moment it takes, renews or ends its
   * lease. The refusal said "Run again once that run ends": a lock its
   * process could not remove, a folder turned read only, holds as long as
   * that process runs, a window open for a day, whatever its runs do.
   */
  it('refuses, naming the folder, the process that holds the lock, how long it may and what to do', async () => {
    const org = orgWith();
    lockedBy(org, 200);
    const mute = await prepared(org, waitingOn(200));

    const error = await mute.acquire('run-1').catch((err: unknown) => err);

    expect(isMuteRefusedError(error)).toBe(true);
    expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
    const message = (error as Error).message;
    expect(message).toBe(
      `The journal of the mute leases in ${dir} stayed locked for a minute by process 200 on ` +
        'this-machine: nothing was assigned. A run locks it only while it takes, renews or ends ' +
        'a lease of the same org and user, but a lock its process could not remove holds until ' +
        `that process has ended, ${lockHoldsUntil(org)} at the latest. Run again in a moment, or ` +
        'end process 200 and run again should none of its runs be muting this org.',
    );
    expect(message).not.toContain('once that run ends');
    expect(message).not.toContain(org.organizationId.slice(0, 15));
    expect(message).not.toContain(org.userId.slice(0, 15));
    expect(org.writes).toEqual([]);
  });

  it('says how long a lock of another machine holds, whatever its process does', async () => {
    const org = orgWith();
    const kind = linkedLockKind<LockFileHead>((content) => content as LockFileHead);
    const taken = kind.acquire(
      `${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`,
      (head) => head,
      { self: { host: 'other-machine', pid: 300, startedAt: '2026-10-30T08:00:00.000Z' } },
    );
    expect('lock' in taken).toBe(true);
    const options = asProcess(100);
    const mute = await prepared(org, {
      ...options,
      // Each look at the clock a minute and a second later: the run's minute
      // of waiting ends at its first try at the lock.
      checks: {
        ...options.checks,
        now: () => {
          vi.setSystemTime(Date.now() + 61_000);
          return Date.now();
        },
      },
    });

    const error = await mute.acquire('run-1').catch((err: unknown) => err);

    expect((error as Error).message).toBe(
      `The journal of the mute leases in ${dir} stayed locked for a minute by process 300 on ` +
        'other-machine: nothing was assigned. A run locks it only while it takes, renews or ends ' +
        'a lease of the same org and user, but a lock a process of another machine could not ' +
        `remove holds until ${lockHoldsUntil(org)}. Run again in a moment, or end process 300 ` +
        'and run again should none of its runs be muting this org.',
    );
  });

  it('says, naming no id, that nothing was taken back when the journal stays locked as the run ends', async () => {
    const org = orgWith();
    const held = await (await prepared(org, waitingOn(200))).acquire('run-1');
    lockedBy(org, 200);

    const done = await held.release();

    expect(done).toMatchObject({ released: false, takenBack: [] });
    expect(done.reason).toBe(
      `the assignments could not be taken back (The journal of the mute leases in ${dir} ` +
        'stayed locked for a minute by process 200 on this-machine: nothing was taken back. A ' +
        'run locks it only while it takes, renews or ends a lease of the same org and user, but ' +
        'a lock its process could not remove holds until that process has ended, ' +
        `${lockHoldsUntil(org)} at the latest. Should none of its runs be muting this org, end ` +
        'process 200): this process tries again while it runs, and takes them back once it can ' +
        `use the journal; past ${held.outcome.leaseEndsAt}, or once process 100 has ended, the ` +
        'next run that mutes this org releases the lease',
    );
    expect(done.reason).not.toContain(org.organizationId.slice(0, 15));
    expect(done.reason).not.toContain(org.userId.slice(0, 15));
    expect(muteLines(done, 'TARGET').join('\n')).not.toContain(org.userId.slice(0, 15));
  });

  /*
   * What a run could not take back as it ended, the journal locked, stayed
   * assigned to the user once the lock was gone: its lease, before its end,
   * held them for the runs of other processes while its own process ran,
   * and no run of that process came to release it.
   */
  it('takes back, from its own process, what it could not as the run ended once the journal is no longer locked', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const org = orgWith();
    const held = await (
      await prepared(org, { ...waitingOn(200), retryEveryMs: RETRY_EVERY_MS })
    ).acquire('run-1');
    lockedBy(org, 200);
    expect(await held.release()).toMatchObject({ released: false, takenBack: [] });
    expect(org.assignments()).toHaveLength(2);

    // Still locked thirty seconds later: nothing taken back yet.
    await vi.advanceTimersByTimeAsync(RETRY_EVERY_MS);
    expect(org.writes.filter((w) => w.kind === 'delete')).toEqual([]);

    // Process 200 ends, its lock with it.
    rmSync(`${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`, { force: true });
    await vi.advanceTimersByTimeAsync(RETRY_EVERY_MS);
    await vi.waitFor(() => expect(org.assignments()).toEqual([]));
    expect(journalOf(org).leases).toEqual([]);
  });

  // Read and written by its owner alone: a journal another user made is not
  // this one's to read, unless this one is root, who reads them all.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names the folder and what to do, and neither id, when the journal cannot be read',
    async () => {
      const org = orgWith();
      const file = muteJournalFileOf(dir, org.organizationId, org.userId);
      writeFileSync(file, '{}');
      chmodSync(file, 0o000);

      const error = await (
        await prepared(org, asProcess(100))
      )
        .acquire('run-1')
        .catch((err: unknown) => err);

      expect(isMuteRefusedError(error)).toBe(true);
      expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
      const message = (error as Error).message;
      expect(message).toBe(
        `The journal of the mute leases in ${dir} could not be read (EACCES): the user ` +
          'SandForge runs as must read and write that folder, or SANDFORGE_MUTE_LEASES_DIR ' +
          'name another, the same for every run that mutes the org. Nothing was assigned.',
      );
      expect(message).not.toContain(org.organizationId.slice(0, 15));
      expect(message).not.toContain(org.userId.slice(0, 15));
      expect(org.writes).toEqual([]);
    },
  );
});

/*
 * The journal is written again as each set is assigned. Run against a
 * folder that turned read only once the lease was journaled, the error of
 * that write left the run: no code, the set assigned to the user in the org,
 * and the lease held for its hour by the process that took it, so that the
 * next run of that process found the set held and left it assigned as it
 * ended.
 */
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a journal that cannot be written once a set is assigned',
  () => {
    const UNWRITTEN =
      `could not be written (EACCES): the user SandForge runs as must read and write that ` +
      'folder, or SANDFORGE_MUTE_LEASES_DIR name another, the same for every run that mutes the org.';

    /** The folder of the journals, read only from the first assignment on, until `restore`. */
    function readOnlyOnceAssigning(): {
      beforeWrite: (write: { kind: string }) => void;
      restore: () => void;
      readOnly: () => boolean;
    } {
      let state: 'writable' | 'readOnly' | 'restored' = 'writable';
      return {
        beforeWrite: (write) => {
          if (write.kind === 'insert' && state === 'writable') {
            chmodSync(dir, 0o500);
            state = 'readOnly';
          }
        },
        restore: () => {
          if (state === 'readOnly') chmodSync(dir, 0o700);
          state = 'restored';
        },
        readOnly: () => state === 'readOnly',
      };
    }

    it('takes back what it assigned and refuses with its code, and its process holds no lease after', async () => {
      const folder = readOnlyOnceAssigning();
      const org = orgWith({ beforeWrite: folder.beforeWrite });
      let error: unknown;
      try {
        error = await (
          await prepared(org, asProcess(100))
        )
          .acquire('run-1')
          .catch((err: unknown) => err);
      } finally {
        folder.restore();
      }

      expect(isMuteRefusedError(error)).toBe(true);
      expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
      expect((error as Error).message).toBe(
        `The journal of the mute leases in ${dir} ${UNWRITTEN} What this run had assigned ` +
          'was taken back: PS_BypassFlow.',
      );
      const [insert, del] = org.writes;
      expect(insert).toEqual({ kind: 'insert', permissionSetId: SET_FLOW, assigneeId: org.userId });
      expect(del).toMatchObject({ kind: 'delete' });
      expect(org.writes).toHaveLength(2);
      expect(org.assignments()).toEqual([]);

      // The next run of the same process: the refused run holds nothing, and
      // what its journal kept of it goes as this one takes its lease.
      const next = await (await prepared(org, asProcess(100))).acquire('run-2');
      expect(next.outcome).toMatchObject({
        assigned: ['PS_BypassFlow', 'PS_BypassVR'],
        held: [],
      });
      expect(journalOf(org).leases.map((lease) => lease['runId'])).toEqual(['run-2']);
      await next.release();
      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([]);
    });

    it('says what the org would not take back, and why, and the next run takes it back', async () => {
      const folder = readOnlyOnceAssigning();
      const refuse: Record<string, string> = {};
      const org = orgWith({
        refuseDeleting: refuse,
        beforeWrite: (write) => {
          folder.beforeWrite(write);
          if (write.kind === 'delete' && folder.readOnly()) refuse[write.id] = 'UNABLE_TO_LOCK_ROW';
        },
      });
      let error: unknown;
      try {
        error = await (
          await prepared(org, asProcess(100))
        )
          .acquire('run-1')
          .catch((err: unknown) => err);
      } finally {
        folder.restore();
      }

      expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
      const [stuck] = org.assignments();
      expect(stuck).toMatchObject({ permissionSetId: SET_FLOW, assigneeId: org.userId });
      expect((error as Error).message).toBe(
        `The journal of the mute leases in ${dir} ${UNWRITTEN} PS_BypassFlow (The org refused ` +
          'the delete: UNABLE_TO_LOCK_ROW) could not be taken back. The journal still names ' +
          "this run's lease: this process tries again while it runs, and releases the lease " +
          'once the journal can be written; the next run that mutes this org from another ' +
          'process releases it at the latest once process 100 has ended.',
      );

      // The next run of the same process.
      delete refuse[stuck.id];
      const next = await (await prepared(org, asProcess(100))).acquire('run-2');
      expect(org.writes.filter((w) => w.kind === 'delete' && w.id === stuck.id)).toHaveLength(2);
      await next.release();
      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([]);
    });

    /*
     * The run's process goes on, as a window does, and the journal, not
     * written, names its lease as it was journaled before the set was
     * assigned. That lease never finished its assignments and holds nothing:
     * a run of another process took it for one under way, and found the set
     * the org kept held through it, or, ending, left the sets it had
     * assigned for it rather than take them back.
     */
    it('takes back, from another process, what the org kept for a lease whose run never finished assigning', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse('2026-10-30T09:00:00.000Z'));
      try {
        const folder = readOnlyOnceAssigning();
        const refuse: Record<string, string> = {};
        const org = orgWith({
          refuseDeleting: refuse,
          beforeWrite: (write) => {
            folder.beforeWrite(write);
            if (write.kind === 'delete' && folder.readOnly()) {
              refuse[write.id] = 'UNABLE_TO_LOCK_ROW';
            }
          },
        });
        /** The lease of a run that mutes the one flow its set's bypass keeps quiet. */
        const oneSet = async (options: MuteLeaseOptions): Promise<MutePrepared> => {
          const answer = await prepareMute(muteOrgOf(org.connection), liftingTwoRules, options);
          if ('refused' in answer) throw new Error(`refused: ${answer.refused.message}`);
          return answer;
        };
        let error: unknown;
        try {
          error = await (
            await oneSet(asProcess(100))
          )
            .acquire('run-1')
            .catch((err: unknown) => err);
        } finally {
          folder.restore();
        }

        expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
        expect((error as Error).message).toBe(
          `The journal of the mute leases in ${dir} ${UNWRITTEN} PS_BypassFlow (The org refused ` +
            'the delete: UNABLE_TO_LOCK_ROW) could not be taken back. The journal still names ' +
            "this run's lease: this process tries again while it runs, and releases the lease " +
            'once the journal can be written; the next run that mutes this org from another ' +
            'process releases it at the latest once process 100 has ended.',
        );
        const [stuck] = org.assignments();
        delete refuse[stuck.id];
        const lock = `${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`;
        expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: 100 });

        // Process 100 runs on: the lock it could not remove holds the journal,
        // each look at it a minute and a second later.
        const waiting = asProcess(200);
        const held = await (
          await oneSet({
            ...waiting,
            checks: {
              ...waiting.checks,
              isAlive: (pid) => {
                if (pid === 100) vi.setSystemTime(Date.now() + 61_000);
                return true;
              },
            },
          })
        )
          .acquire('run-2')
          .catch((err: unknown) => err);
        expect((held as MuteRefusedError).code).toBe('MUTE_FAILED');
        expect((held as Error).message).toContain(
          'stayed locked for a minute by process 100 on this-machine',
        );
        expect(org.assignments().map((a) => a.id)).toEqual([stuck.id]);

        // Without the lock, as a folder that takes its removal leaves it:
        // process 100 runs on, and its lease, before its end, holds nothing.
        rmSync(lock, { force: true });
        const other = await (await oneSet(asProcess(200))).acquire('run-3');
        expect(org.writes.filter((w) => w.kind === 'delete' && w.id === stuck.id)).toHaveLength(2);
        expect(other.outcome).toMatchObject({
          assigned: ['PS_BypassFlow'],
          held: [],
          tookBackOfEnded: ['PS_BypassFlow'],
        });
        expect(journalOf(org).leases.map((lease) => lease['runId'])).toEqual(['run-3']);
        const done = await other.release();
        expect(done).toMatchObject({ released: true, takenBack: ['PS_BypassFlow'] });
        expect(org.assignments()).toEqual([]);
        expect(journalOf(org).leases).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes back, as it ends, what it assigned rather than leave it for a lease whose run was refused', async () => {
      // Process 100 is refused as it takes its lease and takes back what it
      // had assigned; the journal, not written, names its lease as it was
      // before any assignment, and process 100 runs on.
      const folder = readOnlyOnceAssigning();
      const org = orgWith({ beforeWrite: folder.beforeWrite });
      let refused: unknown;
      try {
        refused = await (
          await prepared(org, asProcess(100))
        )
          .acquire('run-1')
          .catch((err: unknown) => err);
      } finally {
        folder.restore();
      }
      expect((refused as MuteRefusedError).code).toBe('MUTE_FAILED');
      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([
        expect.objectContaining({ runId: 'run-1', pid: 100, assigning: [SET_FLOW, SET_VR] }),
      ]);
      // The lock it could not remove, gone as a folder that takes its removal leaves it.
      rmSync(`${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`, { force: true });

      const other = await (await prepared(org, asProcess(200))).acquire('run-2');
      expect(other.outcome).toMatchObject({ assigned: ['PS_BypassFlow', 'PS_BypassVR'], held: [] });
      expect(other.outcome.tookBackOfEnded).toBeUndefined();
      const done = await other.release();

      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([]);
      expect(done).toMatchObject({
        released: true,
        takenBack: ['PS_BypassFlow', 'PS_BypassVR'],
      });
      expect(done.passed).toBeUndefined();
    });

    /*
     * The journal is written once the assignments are taken back. Written
     * into a folder turned read only meanwhile, the release said "the
     * assignments could not be taken back", which the org had taken back.
     */
    it('says what it took back when the journal cannot be written as the run ends, and what the journal still names', async () => {
      let turned = false;
      const org = orgWith({
        beforeWrite: (write) => {
          if (write.kind === 'delete' && !turned) {
            chmodSync(dir, 0o500);
            turned = true;
          }
        },
      });
      const held = await (await prepared(org, asProcess(100))).acquire('run-1');
      let done: Awaited<ReturnType<typeof held.release>>;
      try {
        done = await held.release();
      } finally {
        if (turned) chmodSync(dir, 0o700);
      }

      expect(org.assignments()).toEqual([]);
      expect(done).toMatchObject({
        released: false,
        takenBack: ['PS_BypassFlow', 'PS_BypassVR'],
        notTakenBack: [],
      });
      expect(done.reason).toBe(
        `The journal of the mute leases in ${dir} ${UNWRITTEN} The journal still names this ` +
          "run's lease: this process tries again while it runs, and releases the lease once the " +
          'journal can be written; the next run that mutes this org from another process releases ' +
          'it at the latest once process 100 has ended. Until it is released, and before ' +
          `${held.outcome.leaseEndsAt}, a run of another process that ends may leave what it holds ` +
          'of PS_BypassFlow, PS_BypassVR assigned for that lease, which the release takes back.',
      );
      expect(done.reason).not.toContain('could not be taken back');
      expect(muteLines(done, 'TGT').slice(-2)).toEqual([
        '  taken back: PS_BypassFlow, PS_BypassVR, as the run ended',
        `  lease not released: ${done.reason}`,
      ]);

      // The next run of the same process releases the lease.
      const next = await (await prepared(org, asProcess(100))).acquire('run-2');
      expect(journalOf(org).leases.map((lease) => lease['runId'])).toEqual(['run-2']);
      await next.release();
      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([]);
    });

    it('says what stays assigned when the journal that was to pass it on cannot be written', async () => {
      let turned = false;
      const org = orgWith({
        beforeWrite: (write) => {
          if (write.kind === 'delete' && !turned) {
            chmodSync(dir, 0o500);
            turned = true;
          }
        },
      });
      const both = await (await prepared(org, asProcess(100))).acquire('run-a');
      const flowOnly = await prepareMute(
        muteOrgOf(org.connection),
        liftingTwoRules,
        asProcess(200),
      );
      if ('refused' in flowOnly) throw new Error(flowOnly.refused.message);
      const other = await flowOnly.acquire('run-b');
      let done: Awaited<ReturnType<typeof both.release>>;
      try {
        done = await both.release();
      } finally {
        if (turned) chmodSync(dir, 0o700);
      }

      // PS_BypassVR was taken back; PS_BypassFlow stays for run-b, whose
      // line of the journal does not hold it.
      expect(done).toMatchObject({
        released: false,
        takenBack: ['PS_BypassVR'],
        notTakenBack: ['PS_BypassFlow'],
      });
      expect(done.passed).toBeUndefined();
      expect(done.reason).toBe(
        `The journal of the mute leases in ${dir} ${UNWRITTEN} PS_BypassFlow stays assigned for ` +
          'another run that mutes this org as the same user. The journal still names this ' +
          "run's lease: this process tries again while it runs, and releases the lease once the " +
          'journal can be written; the next run that mutes this org from another process releases ' +
          'it at the latest once process 100 has ended. Until it is released, and before ' +
          `${both.outcome.leaseEndsAt}, a run of another process that ends may leave what it holds ` +
          'of PS_BypassFlow, PS_BypassVR assigned for that lease, which the release takes back.',
      );
      expect(muteLines(done, 'TGT').slice(-2)).toEqual([
        '  taken back: PS_BypassVR, as the run ended',
        `  not taken back: ${done.reason}`,
      ]);
      const [kept] = org.assignments();
      expect(kept).toMatchObject({ permissionSetId: SET_FLOW });

      // Without the lock process 100 could not remove, run-b ends: the
      // journal never gave it PS_BypassFlow, and it takes nothing back.
      rmSync(`${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`, { force: true });
      expect(await other.release()).toMatchObject({ released: true, takenBack: [] });
      expect(org.assignments().map((a) => a.id)).toEqual([kept.id]);
      // The next run of process 100 releases the lease the journal still names.
      const next = await (await prepared(org, asProcess(100))).acquire('run-c');
      expect(org.writes.filter((w) => w.kind === 'delete' && w.id === kept.id)).toHaveLength(1);
      await next.release();
      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([]);
    });

    /*
     * A release whose journal could not be written leaves the journal naming
     * its lease as it was taken: its sets all assigned, its end within the
     * hour, its process at work. For a run of another process, that is a run
     * under way: one that took its lease within that hour assigned the sets
     * again and, as it ended, left them assigned for that lease rather than
     * take them back, both runs saying so. Nothing took them back before a
     * run that came past the lease's end, or once its process had ended.
     */
    describe('a release whose journal could not be written, its process at work', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      /** Process 100's run, ended as the folder turned read only: what its release did, the folder writable again. */
      async function endedUnjournaled(org: ReturnType<typeof orgWith>, turned: () => boolean) {
        const held = await (
          await prepared(org, { ...asProcess(100), retryEveryMs: RETRY_EVERY_MS })
        ).acquire('run-a');
        try {
          return { held, done: await held.release() };
        } finally {
          if (turned()) chmodSync(dir, 0o700);
        }
      }

      /** An org whose folder of journals turns read only at the first delete. */
      function readOnlyAtFirstDelete(): { org: ReturnType<typeof orgWith>; turned: () => boolean } {
        let turned = false;
        const org = orgWith({
          beforeWrite: (write) => {
            if (write.kind === 'delete' && !turned) {
              chmodSync(dir, 0o500);
              turned = true;
            }
          },
        });
        return { org, turned: () => turned };
      }

      it('is finished by its own process once the journal can be written, and a run of another process then takes back what it assigned', async () => {
        const { org, turned } = readOnlyAtFirstDelete();
        const { done } = await endedUnjournaled(org, turned);
        expect(done).toMatchObject({
          released: false,
          takenBack: ['PS_BypassFlow', 'PS_BypassVR'],
          notTakenBack: [],
        });
        expect(done.reason).toContain('this process tries again while it runs');
        expect(journalOf(org).leases.map((lease) => lease['runId'])).toEqual(['run-a']);

        // Process 100 runs on, and tries again: the lock it could not remove
        // in the read-only folder is its own, and goes with its lease.
        await vi.advanceTimersByTimeAsync(RETRY_EVERY_MS);
        await vi.waitFor(() => expect(journalOf(org).leases).toEqual([]));

        const other = await (await prepared(org, asProcess(200))).acquire('run-b');
        expect(other.outcome).toMatchObject({
          assigned: ['PS_BypassFlow', 'PS_BypassVR'],
          held: [],
        });
        const otherDone = await other.release();
        expect(otherDone).toMatchObject({
          released: true,
          takenBack: ['PS_BypassFlow', 'PS_BypassVR'],
        });
        expect(otherDone.passed).toBeUndefined();
        expect(muteLines(otherDone, 'TGT').slice(-1)).toEqual([
          '  taken back: PS_BypassFlow, PS_BypassVR, as the run ended',
        ]);
        expect(org.assignments()).toEqual([]);
        expect(journalOf(org).leases).toEqual([]);
      });

      it('takes back, as its own process releases the lease, what a run of another process left assigned for it meanwhile', async () => {
        const { org, turned } = readOnlyAtFirstDelete();
        await endedUnjournaled(org, turned);
        // The lock its process could not remove, gone as a folder that takes
        // its removal leaves it: a disk that was full.
        rmSync(`${muteJournalFileOf(dir, org.organizationId, org.userId)}.lock`, { force: true });

        // A run of another process, ended before process 100 tries again:
        // the journal names a lease at work that needs its sets.
        const other = await (await prepared(org, asProcess(200))).acquire('run-b');
        const otherDone = await other.release();
        expect(otherDone).toMatchObject({
          released: true,
          takenBack: [],
          passed: ['PS_BypassFlow', 'PS_BypassVR'],
        });
        expect(org.assignments()).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(RETRY_EVERY_MS);
        await vi.waitFor(() => expect(org.assignments()).toEqual([]));
        expect(journalOf(org).leases).toEqual([]);
      });

      /*
       * Refused as it took its lease, a run takes back what it assigned; the
       * journal, not written, names its lease as it was before its first
       * assignment, the sets it was assigning with it. A run of another
       * process released that lease as one whose process died assigning, and
       * looked its sets up by user and set: an admin's assignment of one,
       * made since, went as the refused run's.
       */
      it('releases from its own process, by what it knows it assigned, a lease refused as it was taken', async () => {
        const folder = readOnlyOnceAssigning();
        const org = orgWith({ beforeWrite: folder.beforeWrite });
        let refused: unknown;
        try {
          refused = await (
            await prepared(org, { ...asProcess(100), retryEveryMs: RETRY_EVERY_MS })
          )
            .acquire('run-1')
            .catch((err: unknown) => err);
        } finally {
          folder.restore();
        }
        expect((refused as MuteRefusedError).code).toBe('MUTE_FAILED');
        expect(journalOf(org).leases).toEqual([
          expect.objectContaining({ runId: 'run-1', assigning: [SET_FLOW, SET_VR] }),
        ]);
        const admins = org.assign(SET_FLOW);

        await vi.advanceTimersByTimeAsync(RETRY_EVERY_MS);
        await vi.waitFor(() => expect(journalOf(org).leases).toEqual([]));

        const other = await (await prepared(org, asProcess(200))).acquire('run-2');
        expect(other.outcome).toMatchObject({ assigned: ['PS_BypassVR'], held: ['PS_BypassFlow'] });
        expect(other.outcome.tookBackOfEnded).toBeUndefined();
        await other.release();
        expect(org.assignments()).toEqual([
          { id: admins, assigneeId: org.userId, permissionSetId: SET_FLOW },
        ]);
      });
    });

    it('says the journal that could not be written as it takes back a set the org refused', async () => {
      // The second set refused, the first assigned and journaled: the folder
      // turns read only as the run takes the first back.
      let turned = false;
      const org = orgWith({
        refuseAssigning: { [SET_VR]: 'FIELD_INTEGRITY_EXCEPTION' },
        beforeWrite: (write) => {
          if (write.kind === 'delete' && !turned) {
            chmodSync(dir, 0o500);
            turned = true;
          }
        },
      });
      let error: unknown;
      try {
        error = await (
          await prepared(org, asProcess(100))
        )
          .acquire('run-1')
          .catch((err: unknown) => err);
      } finally {
        if (turned) chmodSync(dir, 0o700);
      }

      expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
      expect((error as Error).message).toBe(
        'PS_BypassVR could not be assigned to the user the run writes as: The org refused the ' +
          `assignment: FIELD_INTEGRITY_EXCEPTION. The journal of the mute leases in ${dir} ` +
          `${UNWRITTEN} What this run had assigned was taken back: PS_BypassFlow.`,
      );
      expect(org.assignments()).toEqual([]);
    });

    it('refuses with its code, nothing assigned, when the folder is read only before the lease is taken', async () => {
      const org = orgWith();
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      let error: unknown;
      try {
        error = await (
          await prepared(org, asProcess(100))
        )
          .acquire('run-1')
          .catch((err: unknown) => err);
      } finally {
        chmodSync(dir, 0o700);
      }

      expect(isMuteRefusedError(error)).toBe(true);
      expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
      expect((error as Error).message).toMatch(
        new RegExp(
          `^The journal of the mute leases in ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ` +
            'could not be locked \\(EACCES\\): .* Nothing was assigned\\.$',
        ),
      );
      expect(org.writes).toEqual([]);
    });
  },
);

describe('whileMuted', () => {
  it('releases after a write that succeeds, and gives what was muted', async () => {
    const org = orgWith();
    const mute = await prepared(org, asProcess(100));
    const { result, muted } = await whileMuted(mute, 'run-1', async () => {
      expect(org.assignments()).toHaveLength(2);
      return 'written';
    });
    expect(result).toBe('written');
    expect(muted).toMatchObject({ state: 'muted', released: true });
    expect(org.assignments()).toEqual([]);
  });

  it('releases after a write that throws, a Stop among them, and hands the error what was muted', async () => {
    const org = orgWith();
    const mute = await prepared(org, asProcess(100));
    const stopped = await whileMuted(mute, 'run-1', async () => {
      throw new Error('Forge execution aborted');
    }).catch((err: unknown) => err);
    expect((stopped as Error).message).toBe('Forge execution aborted');
    expect(mutedOfError(stopped)).toMatchObject({ released: true });
    expect(org.assignments()).toEqual([]);
  });

  it('writes without a lease when the run did not ask to mute', async () => {
    expect(await whileMuted(undefined, 'run-1', async () => 1)).toEqual({ result: 1 });
  });
});

describe('muteForRun', () => {
  it('plans from a read that lists nothing it could not take, its `unread` an empty list', async () => {
    const org = orgWith();
    const mute = await muteForRun(
      async () => muteOrgOf(org.connection),
      automation,
      asProcess(100),
    );
    expect(mute.muted.state).toBe('planned');
    expect(mute.prepared).toBeDefined();
    expect(firedOnInsert(mute.automation!)).toBe(1);
  });

  it('says nothing can be muted when the read failed, and reaches no org', async () => {
    let reached = false;
    const mute = await muteForRun(
      async () => {
        reached = true;
        return muteOrgOf(orgWith().connection);
      },
      { unread: 'INSUFFICIENT_ACCESS' },
    );
    expect(mute).toEqual({
      automation: undefined,
      muted: expect.objectContaining({
        state: 'nothing',
        reason: expect.stringContaining('INSUFFICIENT_ACCESS'),
      }),
    });
    expect(reached).toBe(false);
  });

  it('throws the refusal of a production org, nothing assigned', async () => {
    const org = orgWith({ sandbox: false, edition: 'Enterprise Edition' });
    const error = await muteForRun(async () => muteOrgOf(org.connection), automation).catch(
      (err: unknown) => err,
    );
    expect(isMuteRefusedError(error)).toBe(true);
    expect((error as { code: string }).code).toBe('MUTE_PRODUCTION');
    expect(org.writes).toEqual([]);
  });

  it('holds no lease when nothing can be muted', async () => {
    const mute = await muteForRun(
      async () => muteOrgOf(orgWith().connection),
      { ...automation, bypassGrants: [] },
      asProcess(100),
    );
    expect(mute.prepared).toBeUndefined();
    expect(mute.muted.state).toBe('nothing');
  });
});

describe('planMute', () => {
  it('plans from the read alone, reading nothing of the org', () => {
    const { planned, automation: view } = planMute(automation);
    expect(planned.state).toBe('planned');
    expect(planned.permissions).toEqual(['Account_BypassFlow', 'Bypass_VR']);
    expect(firedOnInsert(view)).toBe(1);
  });
});

describe('defaultMuteLeasesDir', () => {
  it('is one place per user of the machine, in the home directory, unless a variable names another', () => {
    const home = join('/home', 'someone', '.sandforge', 'mute-leases');
    expect(defaultMuteLeasesDir({}, join('/home', 'someone'))).toBe(home);
    expect(
      defaultMuteLeasesDir({ SANDFORGE_JOURNAL_DIR: '/tmp/j' }, join('/home', 'someone')),
    ).toBe(home);
    expect(defaultMuteLeasesDir({ SANDFORGE_MUTE_LEASES_DIR: '/tmp/m' }, '/home/someone')).toBe(
      '/tmp/m',
    );
  });
});

describe('muteLines', () => {
  it('says what was assigned, what it silenced, what still runs and that it was taken back', async () => {
    const org = orgWith();
    const mute = await prepared(org, asProcess(100));
    const { muted } = await whileMuted(mute, 'run-1', async () => undefined);
    expect(muteLines(muted!, 'TGT')).toEqual([
      'mute: assigned PS_BypassFlow, PS_BypassVR to the user the run writes as in TGT, for the run alone',
      '  silenced: Account: flow "Account welcome" (bypass Account_BypassFlow)',
      '  silenced: Account: flow "Account checks" (bypass Bypass_VR)',
      '  still runs: Account: Apex trigger "AccountTrigger" (no bypass in its condition)',
      '  taken back: PS_BypassFlow, PS_BypassVR, as the run ended',
    ]);
  });

  it('says on a dry run what a real run would assign, and that it assigns nothing', async () => {
    const mute = await prepared(orgWith(), asProcess(100));
    expect(muteLines(mute.planned, 'TGT')[0]).toBe(
      'mute: planned, the permission set(s) holding Account_BypassFlow, Bypass_VR ' +
        'for the user it writes as in TGT, for the run alone; nothing is assigned yet',
    );
  });

  it('names on a dry run and in the result each rule the set lifts beside what it silences', async () => {
    const org = orgWith();
    const answer = await prepareMute(muteOrgOf(org.connection), liftingTwoRules, asProcess(100));
    if ('refused' in answer) throw new Error(answer.refused.message);
    const lifted = [
      '  also lifts: validation rule "Phone_Required" on Account (Bypass_VR, in PS_BypassFlow)',
      '  also lifts: validation rule "Region_Locked" on Account (Bypass_VR, in PS_BypassFlow)',
    ];
    expect(muteLines(answer.planned, 'TGT').slice(-2)).toEqual(lifted);
    const { muted } = await whileMuted(answer, 'run-1', async () => undefined);
    expect(muted?.alsoLifted?.map((entry) => entry.name)).toEqual([
      'Phone_Required',
      'Region_Locked',
    ]);
    expect(muteLines(muted!, 'TGT')).toEqual(expect.arrayContaining(lifted));
    // The audit counts them.
    expect(auditMutedOf(muted!)).toMatchObject({ alsoLifted: 2 });
  });

  it('says what a set grants could not be read, rather than naming nothing it lifts', () => {
    const [grant] = liftingTwoRules.bypassGrants!;
    const { planned } = planMute({
      ...liftingTwoRules,
      bypassGrants: [
        {
          ...grant!,
          permissionSets: [
            {
              name: 'PS_BypassFlow',
              label: 'Bypass flow',
              grants: 2,
              customPermissionsUnread: 'INSUFFICIENT_ACCESS: insufficient access rights',
            },
          ],
        },
      ],
    });
    expect(planned.alsoLifted).toEqual([]);
    expect(muteLines(planned, 'TGT')).toContain(
      '  what PS_BypassFlow grants could not be read (INSUFFICIENT_ACCESS: ' +
        'insufficient access rights): what else it lifts is not known',
    );
  });
});

describe('dryRunMuteOf', () => {
  it('gives a dry run’s summary what its lines say: what a real run would do, and the plan', async () => {
    const mute = await muteForRun(
      async () => muteOrgOf(orgWith().connection),
      liftingTwoRules,
      asProcess(100),
    );
    const summary = dryRunMuteOf(mute);
    expect(summary.mutedAutomation).toMatchObject({ state: 'planned', assigned: [] });
    expect(summary.mutePlan?.assign.map((set) => set.permissionSet)).toEqual(['PS_BypassFlow']);
    expect(summary.mutePlan?.alsoLifts).toHaveLength(2);
    expect(dryRunMuteOf(undefined)).toEqual({});
  });
});
