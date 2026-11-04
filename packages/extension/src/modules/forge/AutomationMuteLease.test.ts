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
  muteLines,
  muteOrgOf,
  mutedOfError,
  planMute,
  prepareMute,
  whileMuted,
  type MuteLeaseOptions,
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

  it('refuses, naming the folder and what to do, when another run holds the journal for a minute', async () => {
    const org = orgWith();
    lockedBy(org, 200);
    const mute = await prepared(org, waitingOn(200));

    const error = await mute.acquire('run-1').catch((err: unknown) => err);

    expect(isMuteRefusedError(error)).toBe(true);
    expect((error as MuteRefusedError).code).toBe('MUTE_FAILED');
    const message = (error as Error).message;
    expect(message).toBe(
      `The journal of the mute leases in ${dir} stayed held by process 200 for a minute, by ` +
        'another run that mutes the same org as the same user: nothing was assigned. Run again ' +
        'once that run ends, or stop process 200 should it hang.',
    );
    expect(message).not.toContain(org.organizationId.slice(0, 15));
    expect(message).not.toContain(org.userId.slice(0, 15));
    expect(org.writes).toEqual([]);
  });

  it('says, naming no id, that nothing was taken back when the journal stays held as the run ends', async () => {
    const org = orgWith();
    const held = await (await prepared(org, waitingOn(200))).acquire('run-1');
    lockedBy(org, 200);

    const done = await held.release();

    expect(done.released).toBe(false);
    expect(done.reason).toContain(
      `The journal of the mute leases in ${dir} stayed held by process 200 for a minute, by ` +
        'another run that mutes the same org as the same user: nothing was taken back',
    );
    expect(done.reason).not.toContain(org.organizationId.slice(0, 15));
    expect(done.reason).not.toContain(org.userId.slice(0, 15));
    expect(muteLines(done, 'TARGET').join('\n')).not.toContain(org.userId.slice(0, 15));
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
          "this run's lease: once the journal can be written, the next run that mutes this org " +
          'from this process releases the lease, and one from another process only once ' +
          'process 100 has ended.',
      );

      // The next run of the same process.
      delete refuse[stuck.id];
      const next = await (await prepared(org, asProcess(100))).acquire('run-2');
      expect(org.writes.filter((w) => w.kind === 'delete' && w.id === stuck.id)).toHaveLength(2);
      await next.release();
      expect(org.assignments()).toEqual([]);
      expect(journalOf(org).leases).toEqual([]);
    });

    it('says who releases the lease the journal still names: a run of another process only once this one has ended', async () => {
      // The run's process goes on, as a window does. The journal, not
      // written, names its lease alive, and the folder, read only, kept the
      // journal's lock too: the message said the next run took back what the
      // org kept, and a run of another process found the journal held, then
      // the lease alive, and left the set where it was.
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
            "this run's lease: once the journal can be written, the next run that mutes this org " +
            'from this process releases the lease, and one from another process only once ' +
            'process 100 has ended.',
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
        expect((held as Error).message).toContain('stayed held by process 100 for a minute');
        expect(org.assignments().map((a) => a.id)).toEqual([stuck.id]);

        // Without the lock, as a folder that takes its removal leaves it: the
        // lease holds, before its end.
        rmSync(lock, { force: true });
        const other = await (await oneSet(asProcess(200))).acquire('run-3');
        expect(other.outcome).toMatchObject({ assigned: [], held: ['PS_BypassFlow'] });
        await other.release();
        expect(org.assignments().map((a) => a.id)).toEqual([stuck.id]);

        // Process 100 ended: a run of another process takes back what the org kept.
        const later = await (await oneSet(asProcess(200, (pid) => pid !== 100))).acquire('run-4');
        expect(org.writes.filter((w) => w.kind === 'delete' && w.id === stuck.id)).toHaveLength(2);
        await later.release();
        expect(org.assignments()).toEqual([]);
        expect(journalOf(org).leases).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
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
