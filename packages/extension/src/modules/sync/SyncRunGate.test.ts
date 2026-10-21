import { describe, it, expect, vi } from 'vitest';
import type { ForgeTargetAutomation } from '@sandforge/shared';
import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import {
  gateSyncWrite,
  measureSyncWrite,
  syncWriteGate,
  syncWritePlan,
  type SyncCountedWrite,
  type SyncWriteMeasures,
} from './SyncRunGate.js';

/** A Developer Edition's contact flow, which sends two emails for each contact created. */
const WELCOME_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome',
          label: 'Contact welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
          messages: [
            { kind: 'email', name: 'Send welcome', limit: 'SingleEmail' },
            { kind: 'email', name: 'Send follow up', limit: 'SingleEmail' },
          ],
        },
      ],
      triggers: [],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

const QUIET: ForgeTargetAutomation = { ...WELCOME_FLOW, objects: [] };

/** What the gate reads of a target with room, a quiet automation and a Developer Edition's emails. */
function measures(overrides: Partial<SyncWriteMeasures> = {}): SyncWriteMeasures {
  return {
    readStorage: async () => ({ maxMB: 5, remainingMB: 3 }),
    readAutomation: async () => QUIET,
    readLimits: async () => ({ SingleEmail: { max: 15, remaining: 12 } }),
    confirmAboveRecords: 2_000,
    ...overrides,
  };
}

/** A run that writes these objects, counted. */
function counted(objects: SyncCountedWrite['objects'], alreadyCopied = 0): SyncCountedWrite {
  return { objects, alreadyCopied };
}

describe('syncWritePlan', () => {
  it('measures the records the run creates, a person account at 4 KB, and no update or delete', () => {
    const plan = syncWritePlan(
      counted([
        { objectApiName: 'Account', operation: 'insert', rows: 20, personAccounts: 10 },
        { objectApiName: 'Contact', operation: 'upsert', rows: 30, personAccounts: 10 },
        { objectApiName: 'Case', operation: 'update', rows: 500 },
        { objectApiName: 'Lead', operation: 'delete', rows: 70 },
      ]),
    );

    expect(plan.objects.map((o) => [o.objectApiName, o.rows, o.storageBytes])).toEqual([
      ['Contact', 30, 20 * 2048],
      ['Account', 20, 10 * 2048 + 10 * 4096],
    ]);
    expect(plan.totalRows).toBe(50);
  });
});

describe('measureSyncWrite', () => {
  it('asks the target nothing for a run that writes nothing', async () => {
    const readStorage = vi.fn();
    const readAutomation = vi.fn();

    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 0 }], 40),
      measures({ readStorage, readAutomation }),
    );

    expect(check).toMatchObject({ total: 0, alreadyCopied: 40, verdict: 'writes', emails: [] });
    expect(readStorage).not.toHaveBeenCalled();
    expect(readAutomation).not.toHaveBeenCalled();
  });

  it('writes without asking what fits, under the setting', async () => {
    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 100 }]),
      measures(),
    );

    expect(check).toMatchObject({
      objects: [{ objectApiName: 'Account', rows: 100 }],
      total: 100,
      storage: { verdict: 'fits', maxMB: 5, remainingMB: 3 },
      verdict: 'writes',
    });
    expect(check.aboveRecords).toBeUndefined();
  });

  it('is refused past the storage the target has left', async () => {
    // A Quick Sync of 3 000 contacts into a Developer Edition of 5 MB.
    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 3_000 }]),
      measures({ readStorage: async () => ({ maxMB: 5, remainingMB: 4 }) }),
    );

    expect(check.storage).toMatchObject({ verdict: 'exceeds', remainingMB: 4 });
    expect(check.verdict).toBe('refused');
  });

  it('asks past the setting, near the storage, or when the storage could not be read', async () => {
    const above = await measureSyncWrite(
      counted([{ objectApiName: 'Case', operation: 'update', rows: 2_500 }]),
      measures(),
    );
    const near = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 1_300 }]),
      measures(),
    );
    const unread = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 10 }]),
      measures({
        readStorage: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
      }),
    );

    expect(above.check).toMatchObject({ aboveRecords: 2_000, verdict: 'asks' });
    expect(near.check).toMatchObject({ storage: { verdict: 'near' }, verdict: 'asks' });
    expect(unread.check).toMatchObject({
      storage: { verdict: 'unread', unread: 'INSUFFICIENT_ACCESS' },
      verdict: 'asks',
    });
  });

  it("counts the emails the target's flows send as the records go in, against what is left today", async () => {
    const { check } = await measureSyncWrite(
      counted([
        { objectApiName: 'Account', operation: 'insert', rows: 5 },
        { objectApiName: 'Contact', operation: 'insert', rows: 20 },
      ]),
      measures({ readAutomation: async () => WELCOME_FLOW }),
    );

    expect(check.emails).toEqual([
      {
        limit: 'SingleEmail',
        emails: 40,
        verdict: 'exceeds',
        remaining: 12,
        max: 15,
        objects: [{ objectApiName: 'Contact', perRecord: 2 }],
      },
    ]);
    expect(check.verdict).toBe('asks');
  });

  it("says the target's automation could not be read rather than counting no email", async () => {
    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 20 }]),
      measures({
        readAutomation: async () => {
          throw new Error('timed out');
        },
      }),
    );

    expect(check.emails).toEqual([]);
    expect(check.emailsUnread).toBe("the target's automation: timed out");
  });
});

describe('gateSyncWrite', () => {
  const pastEmails = counted([{ objectApiName: 'Contact', operation: 'insert', rows: 20 }], 3);

  it('refuses past the storage, whoever answers for the run, asking nothing', async () => {
    const confirm = vi.fn();
    const measured = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 3_000 }]),
      measures({ readStorage: async () => ({ maxMB: 5, remainingMB: 4 }) }),
    );

    for (const policy of ['ask', 'unattended', 'refuse'] as const) {
      const answer = await gateSyncWrite(measured, {
        policy,
        org: 'TRAP',
        orgTier: 'development',
        confirm,
      });
      expect(answer).toEqual({
        go: false,
        code: 'SYNC_STORAGE_EXCEEDED',
        message:
          'The records to write take about 5.86 MB of data storage, and TRAP has 4 MB left of ' +
          '5 MB: leave objects out, narrow their filters, or free data storage in TRAP. Nothing ' +
          'was written.',
      });
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks the user who started the run past a daily email limit, naming the records left as they are', async () => {
    const confirm = vi.fn(
      async (_question: WriteConfirmation): Promise<'confirmed'> => 'confirmed',
    );
    const measured = await measureSyncWrite(
      pastEmails,
      measures({ readAutomation: async () => WELCOME_FLOW }),
    );

    const answer = await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });

    expect(answer).toEqual({ go: true, asked: true });
    expect(confirm.mock.calls[0][0]).toMatchObject({
      stage: 'write',
      module: 'sync',
      org: 'TRAP',
      objects: [{ objectApiName: 'Contact', rows: 20 }],
      total: 20,
      counted: true,
      alreadyCopied: 3,
      emails: [{ limit: 'SingleEmail', emails: 40, remaining: 12, max: 15 }],
    });
  });

  it('stops before the first write when the user declines, or when nobody can be asked', async () => {
    const measured = await measureSyncWrite(
      pastEmails,
      measures({ readAutomation: async () => WELCOME_FLOW }),
    );

    const declined = await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm: async () => 'declined',
    });
    const nobody = await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
    });

    expect(declined).toMatchObject({ go: false, code: 'SYNC_WRITE_DECLINED' });
    expect(nobody).toMatchObject({ go: false, code: 'SYNC_CONFIRMATION_UNAVAILABLE' });
  });

  it('refuses a run nobody watches, and the command line, past a daily email limit', async () => {
    const measured = await measureSyncWrite(
      pastEmails,
      measures({ readAutomation: async () => WELCOME_FLOW }),
    );

    for (const policy of ['unattended', 'refuse'] as const) {
      const answer = await gateSyncWrite(measured, {
        policy,
        org: 'TRAP',
        orgTier: 'development',
      });
      expect(answer).toMatchObject({
        go: false,
        code: 'SYNC_EMAILS_EXCEEDED',
        message: expect.stringContaining('about 40 single emails, 12 of 15 left today'),
      });
    }
  });

  it('lets a run nobody watches through past the setting, as it was set up', async () => {
    const measured = await measureSyncWrite(
      counted([{ objectApiName: 'Case', operation: 'update', rows: 9_000 }]),
      measures(),
    );

    expect(
      await gateSyncWrite(measured, { policy: 'unattended', org: 'TRAP', orgTier: 'development' }),
    ).toEqual({ go: true, asked: false });
  });
});

describe('syncWriteGate', () => {
  it('measures a simulation without asking, and holds a run to its policy', async () => {
    const confirm = vi.fn(async () => 'declined' as const);
    const gate = syncWriteGate(measures({ readAutomation: async () => WELCOME_FLOW }), {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });
    const write = counted([{ objectApiName: 'Contact', operation: 'insert', rows: 20 }]);

    const check = await gate.measure(write);
    expect(check.verdict).toBe('asks');
    expect(confirm).not.toHaveBeenCalled();

    const held = await gate.hold(write);
    expect(held.answer).toMatchObject({ go: false, code: 'SYNC_WRITE_DECLINED' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
