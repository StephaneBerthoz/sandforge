import { describe, it, expect, vi } from 'vitest';
import { DATA_STORAGE_NOT_TOLD, type ForgeTargetAutomation } from '@sandforge/shared';
import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import { readApiBudget, readDataStorage } from '../forge/ForgeRunGate.js';
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
    readApiBudget: async () => ({ max: 15_000, remaining: 14_000 }),
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
    const readApiBudget = vi.fn();
    const readAutomation = vi.fn();

    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 0 }], 40),
      measures({ readStorage, readApiBudget, readAutomation }),
    );

    expect(check).toMatchObject({ total: 0, alreadyCopied: 40, verdict: 'writes', emails: [] });
    expect(readStorage).not.toHaveBeenCalled();
    expect(readApiBudget).not.toHaveBeenCalled();
    expect(readAutomation).not.toHaveBeenCalled();
  });

  it("reads the API requests on their own when a Standard User's limits leave out the storage", async () => {
    // A Standard User's `/limits` list DailyApiRequests and SingleEmail, and
    // no DataStorageMB: the run lost the budget with the storage, and said a
    // JSON dump of the schema's issues as the reason for both.
    const limits = vi.fn(async () => ({
      DailyApiRequests: { Max: 5_000_000, Remaining: 4_998_432 },
      SingleEmail: { Max: 5_000, Remaining: 5_000 },
    }));
    const transport = { request: limits };

    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 21 }]),
      measures({
        readStorage: () => readDataStorage(transport),
        readApiBudget: () => readApiBudget(transport),
      }),
    );

    expect(check.storage).toEqual({
      verdict: 'unread',
      estimateMB: expect.any(Number) as unknown,
      unread: DATA_STORAGE_NOT_TOLD,
    });
    expect(check.apiRequests).toEqual({
      verdict: 'fits',
      estimate: 1,
      remaining: 4_998_432,
      max: 5_000_000,
    });
    // The storage it does not tell is asked about, as before.
    expect(check.verdict).toBe('asks');
  });

  it('reads the API requests with the storage when the storage was read, in one request', async () => {
    const readApiBudget = vi.fn();

    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Account', operation: 'insert', rows: 21 }]),
      measures({
        readStorage: async () => ({
          maxMB: 5,
          remainingMB: 3,
          dailyApiRequests: { max: 15_000, remaining: 9_000 },
        }),
        readApiBudget,
      }),
    );

    expect(check.apiRequests).toMatchObject({ verdict: 'fits', remaining: 9_000 });
    expect(readApiBudget).not.toHaveBeenCalled();
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

  it('counts what an update or an upsert may write over with the rest against the setting, and says it apart', async () => {
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'confirmed' as const);
    const measured = await measureSyncWrite(
      counted([
        { objectApiName: 'Account', operation: 'upsert', rows: 1_500 },
        { objectApiName: 'Case', operation: 'update', rows: 600 },
        { objectApiName: 'Lead', operation: 'insert', rows: 10 },
      ]),
      measures({ readStorage: async () => ({ maxMB: 500, remainingMB: 400 }) }),
    );

    expect(measured.check).toMatchObject({
      total: 2_110,
      overwrites: 2_100,
      aboveRecords: 2_000,
      verdict: 'asks',
    });
    await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });
    expect(confirm.mock.calls[0][0]).toMatchObject({ total: 2_110, overwrites: 2_100 });

    const inserts = await measureSyncWrite(
      counted([{ objectApiName: 'Lead', operation: 'insert', rows: 10 }]),
      measures(),
    );
    expect(inserts.check.overwrites).toBeUndefined();
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
    expect(check.verdict).toBe('asks');
  });

  it("asks, saying why, when the target's flows could not be read: their emails were not counted", async () => {
    // The rest of the automation read, the flows refused: the count left
    // their emails out with no word, and a run past the target's fifteen
    // emails a day went on without a question.
    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 20 }]),
      measures({
        readAutomation: async () => ({
          ...QUIET,
          unread: [{ part: 'flows', reason: 'INVALID_TYPE: sObject type FlowDefinitionView' }],
        }),
      }),
    );

    expect(check.emails).toEqual([]);
    expect(check.emailsUnread).toBe(
      "the target's flows: INVALID_TYPE: sObject type FlowDefinitionView",
    );
    expect(check.verdict).toBe('asks');
  });

  it('asks when the target would not say what it has left of a daily email limit its flows send against', async () => {
    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 2 }]),
      measures({
        readAutomation: async () => WELCOME_FLOW,
        readLimits: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
      }),
    );

    expect(check.emails).toEqual([
      {
        limit: 'SingleEmail',
        emails: 4,
        verdict: 'unread',
        objects: [{ objectApiName: 'Contact', perRecord: 2 }],
        unread: 'INSUFFICIENT_ACCESS',
      },
    ]);
    expect(check.verdict).toBe('asks');
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

  it('asks the user who started the run about emails it could not count, naming each limit and the unread automation', async () => {
    // The page said "what is left today could not be read" and the run went
    // on, the user who started it asked nothing.
    const confirm = vi.fn(
      async (_question: WriteConfirmation): Promise<'confirmed'> => 'confirmed',
    );
    const unreadLimit = await measureSyncWrite(
      pastEmails,
      measures({
        readAutomation: async () => WELCOME_FLOW,
        readLimits: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
      }),
    );
    const unreadAutomation = await measureSyncWrite(
      pastEmails,
      measures({
        readAutomation: async () => {
          throw new Error('timed out');
        },
      }),
    );

    const first = await gateSyncWrite(unreadLimit, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });
    const second = await gateSyncWrite(unreadAutomation, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });

    expect([first, second]).toEqual([
      { go: true, asked: true },
      { go: true, asked: true },
    ]);
    expect(confirm.mock.calls[0][0].emailsUnread).toEqual([
      { limit: 'SingleEmail', emails: 40, unread: 'INSUFFICIENT_ACCESS' },
    ]);
    expect(confirm.mock.calls[0][0].emails).toBeUndefined();
    expect(confirm.mock.calls[1][0].emailsUncounted).toBe("the target's automation: timed out");
  });

  it('lets a run nobody watches, and the command line, go on when its emails could not be counted, as when the storage could not be read', async () => {
    // Neither puts a question: the command line prints the line and writes,
    // a schedule writes as it was set up; only past a limit are they refused.
    const measured = await measureSyncWrite(
      pastEmails,
      measures({
        readAutomation: async () => WELCOME_FLOW,
        readLimits: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
      }),
    );

    for (const policy of ['unattended', 'refuse'] as const) {
      expect(
        await gateSyncWrite(measured, { policy, org: 'TRAP', orgTier: 'development' }),
      ).toEqual({ go: true, asked: false });
    }
  });

  /** A run of accounts and cases, whose cases the target user may not create. */
  const casesClosed: SyncCountedWrite = {
    objects: [{ objectApiName: 'Account', operation: 'insert', rows: 40 }],
    alreadyCopied: 0,
    unwritable: [{ objectApiName: 'Case', operation: 'insert', rows: 120, why: 'notCreateable' }],
  };

  it('asks the user who started the run whether to leave out an object the target takes none of, and says it on the page', async () => {
    // A run wrote the accounts, then had each of the 120 cases refused.
    const confirm = vi.fn(
      async (_question: WriteConfirmation): Promise<'confirmed'> => 'confirmed',
    );
    const measured = await measureSyncWrite(casesClosed, measures());

    expect(measured.check).toMatchObject({
      objects: [{ objectApiName: 'Account', rows: 40 }],
      total: 40,
      unwritable: [{ objectApiName: 'Case', rows: 120, why: 'notCreateable' }],
      verdict: 'asks',
    });
    const answer = await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });

    expect(answer).toEqual({ go: true, asked: true });
    expect(confirm.mock.calls[0][0]).toMatchObject({
      objects: [{ objectApiName: 'Account', rows: 40 }],
      unwritable: [{ objectApiName: 'Case', rows: 120, why: 'notCreateable' }],
    });
  });

  it('refuses a run nobody watches, the command line, and a run with nothing else to write, naming each object the target takes none of', async () => {
    const confirm = vi.fn();
    const measured = await measureSyncWrite(casesClosed, measures());
    const alone = await measureSyncWrite(
      { objects: [], alreadyCopied: 0, unwritable: casesClosed.unwritable },
      measures(),
    );
    expect(alone.check.verdict).toBe('refused');

    for (const [policy, run] of [
      ['unattended', measured],
      ['refuse', measured],
      ['ask', alone],
    ] as const) {
      expect(
        await gateSyncWrite(run, { policy, org: 'TRAP', orgTier: 'development', confirm }),
      ).toEqual({
        go: false,
        code: 'SYNC_TARGET_UNWRITABLE',
        message:
          'TRAP would take no record of one object the sync writes — Case (120 records): the ' +
          'user the run writes as may not create its records in TRAP. Leave it out of the run, ' +
          'or give the user SandForge writes as access to it in TRAP. Nothing was written.',
      });
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('refuses a run past the API requests the target has left today, whoever answers for it, and says them on the page', async () => {
    const confirm = vi.fn();
    const measured = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'update', rows: 1_000 }]),
      measures({
        readStorage: async () => ({
          maxMB: 5,
          remainingMB: 3,
          dailyApiRequests: { max: 15_000, remaining: 4 },
        }),
      }),
    );

    expect(measured.check).toMatchObject({
      apiRequests: { verdict: 'exceeds', estimate: 5, remaining: 4, max: 15_000 },
      verdict: 'refused',
    });
    for (const policy of ['ask', 'unattended', 'refuse'] as const) {
      expect(
        await gateSyncWrite(measured, { policy, org: 'TRAP', orgTier: 'development', confirm }),
      ).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('says in the question it asks anyway that the run would leave the target short of API requests', async () => {
    const confirm = vi.fn(
      async (_question: WriteConfirmation): Promise<'confirmed'> => 'confirmed',
    );
    const measured = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 3_000 }]),
      measures({
        readStorage: async () => ({
          maxMB: 500,
          remainingMB: 400,
          dailyApiRequests: { max: 15_000, remaining: 1_000 },
        }),
      }),
    );

    await gateSyncWrite(measured, { policy: 'ask', org: 'TRAP', orgTier: 'development', confirm });

    expect(confirm.mock.calls[0][0]).toMatchObject({
      apiRequests: { estimate: 15, remaining: 1_000, max: 15_000 },
    });
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
