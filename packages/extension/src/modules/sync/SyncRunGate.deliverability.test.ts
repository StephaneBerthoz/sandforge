import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ForgeTargetAutomation,
  ForgeTargetFlow,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import { mutedAutomationOf } from '@sandforge/shared';

import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';
import { muteForRun, muteOrgOf, type RunMute } from '../forge/AutomationMuteLease.js';
import type { DeliverabilityRead } from '../forge/targetDeliverability.js';
import {
  gateSyncWrite,
  measureSyncWrite,
  mutingSyncWriteGate,
  syncRunWrites,
  syncWriteGate,
  type SyncCountedWrite,
  type SyncWriteMeasures,
} from './SyncRunGate.js';

/*
 * Whether the target delivers the emails of what still runs as a Sync run
 * writes, as the run's gate reads it and judges it: read only when
 * something may send one, its requests among the run's, asked about where
 * someone answers for the run, refused without the accord where nobody does,
 * and checked again once the mute's lease is read back.
 */

/** A flow of the target that emails as a contact goes in, kept quiet by `bypass` when given. */
function emailingFlow(label: string, bypass?: string): ForgeTargetFlow {
  return {
    apiName: label.replace(/ /g, '_'),
    label,
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: bypass ? [{ name: bypass, bypass: true, held: false }] : [],
    messages: [{ kind: 'email', name: `Send ${label}`, limit: 'SingleEmail' }],
  };
}

/**
 * The trap org's contact automation: a welcome email the org's bypass keeps
 * quiet for whoever holds `PS_Bypass`, and a notice nothing keeps quiet.
 */
function contactAutomation(
  flows: ForgeTargetFlow[] = [
    emailingFlow('Welcome email', 'Contact_Bypass'),
    emailingFlow('Contact noticed'),
  ],
): ForgeTargetAutomation {
  return {
    objectsRead: ['Contact'],
    objects: [{ objectApiName: 'Contact', flows, triggers: [] }],
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
}

/** The read of an org on All email: one request. */
const ALL_EMAIL: DeliverabilityRead = { reading: { level: 'all' }, requests: 1 };
/** The read of an org on System email only or No access: the Apex, then the user's Send Email. */
const WITHHELD: DeliverabilityRead = { reading: { level: 'withheld' }, requests: 2 };

/** What the gate reads of a target with room to spare and emails left today. */
function measures(overrides: Partial<SyncWriteMeasures> = {}): SyncWriteMeasures {
  return {
    readStorage: async () => ({
      maxMB: 500,
      remainingMB: 400,
      dailyApiRequests: { max: 15_000, remaining: 14_000 },
    }),
    readApiBudget: async () => ({ max: 15_000, remaining: 14_000 }),
    readAutomation: async () => contactAutomation(),
    readLimits: async () => ({ SingleEmail: { max: 5_000, remaining: 5_000 } }),
    readDeliverability: vi.fn(async () => ALL_EMAIL),
    emails: { target: 'TRAP', accepted: false, mayMute: true },
    confirmAboveRecords: 2_000,
    ...overrides,
  };
}

/** Twenty contacts inserted. */
const WRITE: SyncCountedWrite = {
  objects: [{ objectApiName: 'Contact', operation: 'insert', rows: 20 }],
  alreadyCopied: 0,
};

describe('measureSyncWrite, of the emails of what still runs', () => {
  it('reads the deliverability once something that still runs may send one, its requests counted beside the run’s own', async () => {
    const read = vi.fn(async () => WITHHELD);
    const quiet = await measureSyncWrite(
      WRITE,
      measures({
        readAutomation: async () => contactAutomation([]),
        readDeliverability: read,
      }),
    );
    expect(read).not.toHaveBeenCalled();

    const sending = await measureSyncWrite(WRITE, measures({ readDeliverability: read }));

    expect(read).toHaveBeenCalledTimes(1);
    expect(sending.check.deliverability).toEqual({
      reading: { level: 'withheld' },
      senders: [
        { objectApiName: 'Contact', kind: 'flow', name: 'Welcome email', why: 'email' },
        { objectApiName: 'Contact', kind: 'flow', name: 'Contact noticed', why: 'email' },
      ],
    });
    expect(sending.api.estimate).toBe(quiet.api.estimate + 2);
    expect(sending.api.parts).toMatchObject({ deliverability: 2 });
    // An org that withholds them asks nothing for them.
    expect(sending.check.verdict).toBe('writes');
    expect(quiet.check.deliverability).toBeUndefined();
  });

  it('reads nothing when the mute keeps quiet the one flow that sends', async () => {
    const read = vi.fn(async () => ALL_EMAIL);
    const automation = contactAutomation([emailingFlow('Welcome email', 'Contact_Bypass')]);

    const measured = await measureSyncWrite(
      WRITE,
      measures({
        readAutomation: async () => mutedAutomationOf(automation, ['Contact_Bypass']),
        readDeliverability: read,
      }),
    );

    expect(read).not.toHaveBeenCalled();
    expect(measured.check.deliverability).toBeUndefined();
    expect(measured.check.verdict).toBe('writes');
  });

  it('reads it when what sends could not be read at all, and asks though it lists no sender', async () => {
    const read = vi.fn(async () => ALL_EMAIL);

    const measured = await measureSyncWrite(
      WRITE,
      measures({
        readAutomation: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
        readDeliverability: read,
      }),
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(measured.check.deliverability).toEqual({
      reading: { level: 'all' },
      senders: [],
      sendersUnread:
        "the target's flows: INSUFFICIENT_ACCESS; the target's processes: INSUFFICIENT_ACCESS; " +
        "the target's workflow rules: INSUFFICIENT_ACCESS",
    });
    expect(measured.check.verdict).toBe('asks');
  });

  it('reads it for a run that only updates, whose update starts a flow that sends', async () => {
    const read = vi.fn(async () => ALL_EMAIL);
    const onUpdate = { ...emailingFlow('Contact changed'), startsOn: 'update' as const };

    const measured = await measureSyncWrite(
      { objects: [{ objectApiName: 'Contact', operation: 'update', rows: 20 }], alreadyCopied: 0 },
      measures({
        readAutomation: async () => contactAutomation([onUpdate]),
        readDeliverability: read,
      }),
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(measured.check.deliverability?.senders.map(({ name }) => name)).toEqual([
      'Contact changed',
    ]);
  });
});

describe('gateSyncWrite, on the emails of what still runs', () => {
  it('refuses the command line on All email without --accept-emails, naming who sends them and where they go', async () => {
    const measured = await measureSyncWrite(WRITE, measures());

    const refused = await gateSyncWrite(measured, {
      policy: 'refuse',
      org: 'TRAP',
      orgTier: 'development',
    });

    expect(refused).toMatchObject({ go: false, code: 'EMAILS_NOT_ACCEPTED' });
    const message = refused.go ? '' : refused.message;
    expect(message).toContain(
      'TRAP delivers every email its automation sends (Setup > Deliverability: All email), and ' +
        'what still runs as this sync writes its records sends some: flow "Welcome email" and ' +
        'flow "Contact noticed" on Contact.',
    );
    expect(message).toContain('those this sync writes are under .invalid');
    expect(message).toContain('Nothing was written. Add --accept-emails to sync all the same');
    expect(refused.emails).toEqual({ accepted: false, deliverability: 'all' });
  });

  it('lets it through with the accord, and says so', async () => {
    const measured = await measureSyncWrite(
      WRITE,
      measures({ emails: { target: 'TRAP', accepted: true } }),
    );

    expect(
      await gateSyncWrite(measured, { policy: 'refuse', org: 'TRAP', orgTier: 'development' }),
    ).toEqual({ go: true, asked: false, emails: { accepted: true, deliverability: 'all' } });
  });

  it('says the emails reach the addresses the records keep, under --keep-contact-points', async () => {
    const measured = await measureSyncWrite(
      WRITE,
      measures({ emails: { target: 'TRAP', accepted: false, keepsAddresses: true } }),
    );

    const refused = await gateSyncWrite(measured, {
      policy: 'refuse',
      org: 'TRAP',
      orgTier: 'development',
    });

    expect(refused.go ? '' : refused.message).toContain(
      'those of the records this sync writes, as they hold them',
    );
  });

  it('refuses when the org would not say, the reason in its words, and lets through one that withholds them', async () => {
    const unread = await measureSyncWrite(
      WRITE,
      measures({
        readDeliverability: async () => ({ reading: { unread: 'timed out' }, requests: 1 }),
      }),
    );
    const withheld = await measureSyncWrite(
      WRITE,
      measures({ readDeliverability: async () => WITHHELD }),
    );
    const decide = { policy: 'refuse' as const, org: 'TRAP', orgTier: 'development' as const };

    const refused = await gateSyncWrite(unread, decide);
    expect(refused).toMatchObject({ go: false, code: 'EMAILS_NOT_ACCEPTED' });
    expect(refused.go ? '' : refused.message).toContain(
      'Whether TRAP delivers the emails its automation sends could not be read (timed out)',
    );
    expect(await gateSyncWrite(withheld, decide)).toEqual({
      go: true,
      asked: false,
      emails: { accepted: false, deliverability: 'withheld' },
    });
  });

  it('names --mute-automation for what a mute would keep quiet, to a run that does not mute', async () => {
    const measured = await measureSyncWrite(WRITE, measures());

    const refused = await gateSyncWrite(measured, {
      policy: 'refuse',
      org: 'TRAP',
      orgTier: 'development',
    });

    expect(refused.go ? '' : refused.message).toContain(
      '--mute-automation keeps quiet flow "Welcome email" on Contact, which tests a bypass a ' +
        'permission set of TRAP holds; it cannot quiet flow "Contact noticed" on Contact.',
    );
  });

  it('says what lifts it where nobody answers for the run and there is no flag to add', async () => {
    const measured = await measureSyncWrite(WRITE, measures());

    const refused = await gateSyncWrite(measured, {
      policy: 'unattended',
      org: 'TRAP',
      orgTier: 'development',
      emailsLiftedBy: 'Approve an Approval step put before this Sync step to sync all the same',
    });

    const message = refused.go ? '' : refused.message;
    expect(message).toContain(
      'Nothing was written. Approve an Approval step put before this Sync step to sync all the ' +
        'same, set the org',
    );
    expect(message).not.toContain('--accept-emails');
  });

  it('asks the user who started the run, its block in the question, and takes the answer for the accord', async () => {
    const measured = await measureSyncWrite(
      WRITE,
      measures({ emails: { target: 'TRAP', accepted: false, keepsAddresses: true } }),
    );
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'confirmed' as const);

    const answer = await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });

    expect(answer).toEqual({
      go: true,
      asked: true,
      emails: { accepted: true, deliverability: 'all' },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      deliverability: { reading: { level: 'all' }, keepsAddresses: true },
    });
  });
});

describe('the write path of a Sync run that mutes, on its emails', () => {
  const SET = '0PSxx0000000001AAA';
  const ESTIMATE: RunCheckpointEstimate = {
    state: 'planned',
    estimate: { records: 20, apiRequests: 9, apiRequestsLeft: 14_000, seconds: 3, bytes: 40_000 },
    objects: ['Contact'],
    added: [],
    notHeld: [],
    keepDays: 7,
  };
  const TAKEN: RunCheckpointTaken = {
    state: 'taken',
    checkpointId: 'ck-20261101-101540-a1b2',
    name: 'Before Sync run 2026-11-01 10:15 UTC',
    takenAt: '2026-11-01T10:15:40.000Z',
    expiresAt: '2026-11-08T10:15:40.000Z',
    objects: ['Contact'],
    records: 20,
    bytes: 40_000,
    requests: 9,
    added: [],
    notHeld: [],
  };

  /**
   * A run that mutes and takes a checkpoint first, through the real gate, on
   * the memory org, every step put down in `events`; `holds` false reads back
   * a lease that holds none of its sets.
   */
  function runOf(holds = true, automation = contactAutomation()) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-emails-'));
    const events: WritePathStep[] = [];
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'PS_Bypass' }],
      beforeWrite: (write) => {
        if (write.kind === 'insert') events.push('leaseAcquire');
      },
    });
    const confirm = vi.fn(async (_question: WriteConfirmation) => {
      events.push('question');
      return 'confirmed' as const;
    });
    const muting = mutingSyncWriteGate(
      (read) =>
        syncWriteGate(
          measures({
            readAutomation: read,
            readDeliverability: async () => {
              events.push('deliverabilityRead');
              return ALL_EMAIL;
            },
            checkpointFirst: {
              scope: async () => {
                events.push('stillRunning');
                return ESTIMATE;
              },
              take: async () => {
                events.push('checkpointTake');
                return { taken: true, checkpoint: TAKEN };
              },
            },
          }),
          { policy: 'ask', org: 'TRAP', orgTier: 'development', confirm },
        ),
      async () => {
        events.push('reads');
        return automation;
      },
      async (read): Promise<RunMute> => {
        events.push('leasePlan');
        const mute = await muteForRun(async () => muteOrgOf(org.connection), read, {
          dir,
          renewEveryMs: 0,
          writes: syncRunWrites,
        });
        const prepared = mute.prepared;
        if (holds || !prepared) return mute;
        // Read back holding none of the sets it was to assign.
        return {
          ...mute,
          prepared: {
            ...prepared,
            acquire: async (runId) => {
              const held = await prepared.acquire(runId);
              return {
                outcome: { ...held.outcome, assigned: [], held: [] },
                release: held.release,
              };
            },
          },
        };
      },
      'run-1',
      { target: 'TRAP' },
    );
    return {
      muting,
      org,
      events,
      confirm,
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('lets the run through the check after the lease when the question had the accord for every email', async () => {
    // The lease holds nothing, so the welcome email runs too: the answer to
    // the question sent the emails of the org, which it delivers all.
    const run = runOf(false);
    const held = await run.muting.gate.hold(WRITE);

    expect(held.answer).toMatchObject({ go: true, emails: { accepted: true } });
    await run.muting.release();
    run.done();
  });

  it('reads the deliverability of what still runs after the lease is planned and before the one question, then takes the checkpoint and the lease', async () => {
    const run = runOf();
    const held = await run.muting.gate.hold(WRITE);
    expect(held.answer).toMatchObject({ go: true, asked: true, checkpoint: TAKEN });
    run.events.push('write');
    await run.muting.release();
    run.events.push('leaseRelease', 'result');

    expect(run.events).toEqual([
      'reads',
      'leasePlan',
      'stillRunning',
      'deliverabilityRead',
      'question',
      'checkpointTake',
      'leaseAcquire',
      'write',
      'leaseRelease',
      'result',
    ]);
    expect(writePathOrderDefects(run.events)).toEqual([]);
    // What the mute keeps quiet is not asked about; what it cannot quiet is.
    expect(run.confirm.mock.calls[0][0].deliverability?.senders.map(({ name }) => name)).toEqual([
      'Contact noticed',
    ]);
    run.done();
  });

  it('refuses the run before its first write when the lease read back does not hold what it was to keep quiet', async () => {
    // Muted, nothing was left to send: nothing was read, and nothing asked of the emails.
    const run = runOf(false, contactAutomation([emailingFlow('Welcome email', 'Contact_Bypass')]));
    const held = await run.muting.gate.hold(WRITE);

    expect(held.answer).toMatchObject({
      go: false,
      code: 'EMAILS_NOT_ACCEPTED',
      checkpoint: TAKEN,
    });
    const message = held.answer.go ? '' : held.answer.message;
    expect(message).toContain(
      'flow "Welcome email" on Contact may send emails, and whether TRAP delivers them was not ' +
        'read, as nothing that sends one was to run.',
    );
    expect(message).toContain("The run's question did not ask about them. Nothing was written.");
    expect(run.events).not.toContain('deliverabilityRead');
    expect(run.confirm.mock.calls[0][0].deliverability).toBeUndefined();
    // The run that stops gives its lease back, as its caller ends it.
    await run.muting.release();
    expect(run.org.assignments()).toEqual([]);
    run.done();
  });
});
