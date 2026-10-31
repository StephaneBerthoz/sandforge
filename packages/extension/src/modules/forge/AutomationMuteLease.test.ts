import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firedOnInsert, type ForgeTargetAutomation, type ForgeTargetFlow } from '@sandforge/shared';
import {
  memoryPermissionOrg,
  type MemoryPermissionOrgSetup,
} from '../../test/memoryPermissionOrg.js';
import {
  defaultMuteLeasesDir,
  isMuteRefusedError,
  muteForRun,
  muteJournalFileOf,
  muteLines,
  muteOrgOf,
  mutedOfError,
  planMute,
  prepareMute,
  whileMuted,
  type MuteLeaseOptions,
  type MutePrepared,
} from './AutomationMuteLease.js';

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
      permissionSets: [{ name: 'PS_BypassFlow', label: 'Bypass flow', grants: 1 }],
    },
    {
      permission: 'Bypass_VR',
      permissionSets: [{ name: 'PS_BypassVR', label: 'Bypass VR', grants: 1 }],
    },
  ],
  requests: 3,
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

/** Leases taken as process `pid` of this machine, the other processes alive unless told. */
function asProcess(pid: number, alive: (pid: number) => boolean = () => true): MuteLeaseOptions {
  return {
    dir,
    self: { host: 'this-machine', pid, startedAt: '2026-10-30T08:00:00.000Z' },
    checks: { isAlive: alive, bootedAt: () => Date.parse('2026-10-30T07:00:00.000Z') },
    renewEveryMs: 0,
  };
}

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

  it('refuses a set the org does not hold before anything is journaled or assigned', async () => {
    const org = memoryPermissionOrg({ sets: [SETS[0]] });
    const mute = await prepared(org, asProcess(100));
    await expect(mute.acquire('run-1')).rejects.toThrow('holds no permission set PS_BypassVR');
    expect(org.writes).toEqual([]);
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
      'mute: a real run would assign the permission set(s) holding Account_BypassFlow, Bypass_VR ' +
        'to the user it writes as in TGT, for the run alone; this dry run assigns nothing',
    );
  });
});
