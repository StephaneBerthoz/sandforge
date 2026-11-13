import { describe, it, expect, vi } from 'vitest';
import { DATA_STORAGE_NOT_TOLD, type ForgeTargetAutomation } from '@sandforge/shared';
import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import { API_BUDGET_EXCEEDED, readApiBudget, readDataStorage } from '../forge/ForgeRunGate.js';
import { AUTOMATION_READ_MOST } from '../forge/TargetAutomationReader.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { muteForRun, muteOrgOf } from '../forge/AutomationMuteLease.js';
import {
  gateSyncWrite,
  measureSyncWrite,
  mutingSyncWriteGate,
  syncGateStops,
  syncRequestsEstimate,
  syncRequestsPastTheGate,
  syncRunWrites,
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

/**
 * What a run reads of the target from its gate on, beside its writes, in its
 * own part: who it writes as (2), the limits (3), and the read of its
 * automation, which says it sent 4.
 */
const GATE_READS = 2 + 3 + QUIET.requests;

/** What a gate says of the emails of an org that withholds them: read, and no accord needed. */
const WITHHELD = { accepted: false, deliverability: 'withheld' } as const;

/** What the gate reads of a target with room, a quiet automation and a Developer Edition's emails. */
function measures(overrides: Partial<SyncWriteMeasures> = {}): SyncWriteMeasures {
  return {
    readStorage: async () => ({ maxMB: 5, remainingMB: 3 }),
    readApiBudget: async () => ({ max: 15_000, remaining: 14_000 }),
    readAutomation: async () => QUIET,
    readLimits: async () => ({
      SingleEmail: { max: 15, remaining: 12 },
      DailyWorkflowEmails: { max: 8_040, remaining: 8_040 },
    }),
    // An org that delivers none of the emails of its automation: no question.
    readDeliverability: async () => ({ reading: { level: 'withheld' }, requests: 2 }),
    emails: { target: 'TRAP', accepted: false },
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
    expect(check).not.toHaveProperty('alreadyLinked');
    const linked = await measureSyncWrite(
      {
        ...counted([{ objectApiName: 'Account', operation: 'insert', rows: 0 }], 40),
        alreadyLinked: 2,
      },
      measures({ readStorage, readApiBudget, readAutomation }),
    );
    expect(linked.check).toMatchObject({ alreadyCopied: 40, alreadyLinked: 2 });
    // The contact roles the run links to the platform's, told apart from what it writes.
    const roles = await measureSyncWrite(
      {
        ...counted([{ objectApiName: 'OpportunityContactRole', operation: 'insert', rows: 0 }]),
        rolesLinked: 1,
      },
      measures({ readStorage, readApiBudget, readAutomation }),
    );
    expect(roles.check).toMatchObject({ total: 0, rolesLinked: 1 });
    expect(roles.check).not.toHaveProperty('rolesByThePlatform');
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
      estimate: 1 + GATE_READS,
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

    // A Developer Edition counts a flow's single emails against its workflow
    // emails too, as the trap took them.
    expect(check.emails).toEqual([
      {
        limit: 'SingleEmail',
        emails: 40,
        verdict: 'exceeds',
        remaining: 12,
        max: 15,
        objects: [{ objectApiName: 'Contact', perRecord: 2 }],
      },
      {
        limit: 'DailyWorkflowEmails',
        emails: 40,
        verdict: 'fits',
        remaining: 8_040,
        max: 8_040,
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

  it('asks, naming it, when a flow that fires on the inserts had its definition left unread: its emails were not counted', async () => {
    // Past the read's bound, or refused, a flow's start condition and actions
    // are not read: it was counted as sending nothing, and a run of contacts
    // went on without a question whatever it sent.
    const notRead: ForgeTargetAutomation = {
      ...WELCOME_FLOW,
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              ...WELCOME_FLOW.objects[0].flows[0],
              apiName: 'Contact_Nurture',
              label: 'Contact nurture',
              condition: 'notRead',
              messages: [],
            },
          ],
          triggers: [],
        },
      ],
      conditionsNotRead: 1,
    };

    const { check } = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 3 }]),
      measures({ readAutomation: async () => notRead }),
    );

    expect(check.emails).toEqual([]);
    expect(check.emailsUnread).toBe('the definition of Contact nurture on Contact');
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

describe('the API requests of a run, priced as its writer sends them', () => {
  /** What the target runs, a standard duplicate rule watching each of `ruled`. */
  const ruledBy = (...ruled: string[]): ForgeTargetAutomation => ({
    ...QUIET,
    objectsRead: ['Account', 'Contact', 'Lead'],
    objects: ruled.map((objectApiName) => ({
      objectApiName,
      flows: [],
      triggers: [],
      duplicateRules: [{ name: 'Standard rule', developerName: 'Standard_Rule' }],
    })),
  });
  const estimateOf = async (
    objects: SyncCountedWrite['objects'],
    overrides: Partial<SyncWriteMeasures> = {},
  ): Promise<number> => {
    // The run's own part, its writes alone: an automation that could not be
    // read has its deliverability read besides, and a command line that has
    // sent the target nothing before its gate prices no read beside them.
    const { api } = await measureSyncWrite(
      counted(objects),
      measures({ sentBefore: () => 0, ...overrides }),
    );
    return api.parts?.run ?? api.estimate;
  };

  it('prices an object past the Bulk API threshold as the job its writer opens, and what a duplicate rule refused in it again by REST', async () => {
    // 201 contacts went as one job of thirteen calls, and what the
    // standard rule refused in it went again in two REST calls: counted
    // two, a REST call per 200 rows.
    const contacts = [{ objectApiName: 'Contact', operation: 'insert' as const, rows: 201 }];
    expect(await estimateOf(contacts, { readAutomation: async () => ruledBy('Contact') })).toBe(
      13 + 2,
    );
    // No rule watches them: the job alone.
    expect(await estimateOf(contacts)).toBe(13);
    // The rules not read: every row may go again.
    expect(
      await estimateOf(contacts, {
        readAutomation: async () => Promise.reject(new Error('INSUFFICIENT_ACCESS')),
      }),
    ).toBe(13 + 2);
  });

  it('sends nothing of a delete again, and prices each object by its own batch size under the threshold', async () => {
    expect(
      await estimateOf([{ objectApiName: 'Contact', operation: 'delete', rows: 600 }], {
        readAutomation: async () => ruledBy('Contact'),
      }),
    ).toBe(14);
    // Four calls of fifty accounts, one of 150 contacts: what is read before
    // each is priced past the gate (`syncRequestsPastTheGate`).
    expect(
      syncRequestsEstimate(
        [
          { objectApiName: 'Account', operation: 'upsert', rows: 200, batchSize: 50 },
          { objectApiName: 'Contact', operation: 'update', rows: 150 },
        ],
        {},
      ),
    ).toBe(4 + 1);
  });

  it("prices by the threshold the run's writer is given: set to 500, 300 records go by REST", async () => {
    const accounts = [{ objectApiName: 'Account', operation: 'insert' as const, rows: 300 }];
    expect(await estimateOf(accounts, { bulkThreshold: 500 })).toBe(2);
    expect(await estimateOf(accounts)).toBe(3 + 7 + 3);
  });
});

describe('what a run sends its target from its gate on, beside its writes', () => {
  const ID = { characters: 20, wide: false };

  it('prices, before each call that writes over records, the reads of what it writes over, by its key', () => {
    // 600 accounts updated by id: one Bulk API job, read in four statements
    // of 181 before it; the rows a duplicate rule may have refused in it sent
    // again in three calls of 200, each read in two; once more without the
    // stamps; and whether the run's user reads encrypted fields.
    const updated = [
      { objectApiName: 'Account', operation: 'update' as const, rows: 600, overwriteKey: ID },
    ];
    expect(syncRequestsPastTheGate({ objects: updated }, {})).toBe(4 + 3 * 2 + 1 + 1);
    // No rule watches them: the job's reads alone.
    expect(
      syncRequestsPastTheGate(
        { objects: updated },
        { duplicateRules: new Map([['Account', false]]) },
      ),
    ).toBe(4 + 1 + 1);
    // An upsert by an external id of 80 characters: 47 a statement.
    expect(
      syncRequestsPastTheGate(
        {
          objects: [
            {
              objectApiName: 'Account',
              operation: 'upsert',
              rows: 100,
              overwriteKey: { characters: 82, wide: false },
            },
          ],
        },
        {},
      ),
    ).toBe(3 + 1 + 1);
    // An insert and a delete write over nothing.
    expect(
      syncRequestsPastTheGate(
        {
          objects: [
            { objectApiName: 'Account', operation: 'insert', rows: 600 },
            { objectApiName: 'Contact', operation: 'delete', rows: 600 },
          ],
        },
        {},
      ),
    ).toBe(0);
  });

  it('prices the roles the platform wrote with the opportunities created with a contact: read, then given the rows’ fields', () => {
    const objects = [
      { objectApiName: 'Opportunity', operation: 'insert' as const, rows: 300 },
      {
        objectApiName: 'OpportunityContactRole',
        operation: 'insert' as const,
        rows: 250,
        overwriteKey: ID,
      },
    ];
    // 300 roles at most, 50 the gate linked already: read 200 opportunities
    // a statement, updated in two calls of 200 and 100, each read first as
    // any update — two statements, then one —, once more without the stamps,
    // and whether encrypted fields read in clear.
    expect(syncRequestsPastTheGate({ objects, rolesLinked: 50 }, {})).toBe(2 + 2 + (2 + 1 + 1) + 1);
  });

  it('prices a describe of each object whose record types it reads again, once the mute assigns a permission set', async () => {
    const typed = { ...counted([{ objectApiName: 'Contact', operation: 'insert', rows: 150 }]) };
    const again = { ...typed, describedAgain: 2 };
    expect(syncRequestsPastTheGate(again, { leaseAssigns: true })).toBe(2);
    expect(syncRequestsPastTheGate(again, { leaseAssigns: false })).toBe(0);

    const plan = {
      assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Contact_Bypass'] }],
    };
    const leased = await measureSyncWrite(again, measures({ mutePlan: () => plan }));
    const unleased = await measureSyncWrite(again, measures());
    expect(leased.api.parts?.run).toBe(1 + GATE_READS + 2);
    expect(unleased.api.estimate).toBe(1 + GATE_READS);
  });
});

describe('what a run reads of the target, priced beside its writes', () => {
  const contacts = counted([{ objectApiName: 'Contact', operation: 'insert', rows: 150 }]);

  it('prices who the run writes as, the limits from its gate on and the read of its automation, as that read says it sent them', async () => {
    // One REST call of 150 contacts; who the run writes as for the sweep of
    // its removal (the API's root, then the identity URL), the gate's read
    // of the limits, its read of the daily requests alone, its read of the
    // day's emails; and the four requests the read of the automation said.
    // Its call alone was priced.
    const { api } = await measureSyncWrite(contacts, measures());
    expect(api.estimate).toBe(1 + 2 + 3 + 4);
    expect(api).not.toHaveProperty('parts');

    // A read that failed whole, which said nothing of what it sent: priced
    // at the most a read sends.
    const failed = await measureSyncWrite(
      contacts,
      measures({ readAutomation: async () => Promise.reject(new Error('timed out')) }),
    );
    expect(failed.api.parts).toMatchObject({ run: 1 + 2 + 3 + AUTOMATION_READ_MOST });
  });

  it('prices, on the command line, every request it sent so far in their place, the read of the deliverability apart', async () => {
    // Sent so far: what typed the org, described and counted, the read of
    // the automation, the limits, who it writes as — 31 —, the two of the
    // deliverability among them, which keep their own part.
    const senders = measures({
      readAutomation: async () => WELCOME_FLOW,
      readDeliverability: async () => ({ reading: { level: 'all' }, requests: 2 }),
      emails: { target: 'TRAP', accepted: true },
      sentBefore: () => 31,
    });
    const { api } = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 5 }]),
      senders,
    );
    expect(api.parts).toEqual({ run: 1 + (31 - 2), deliverability: 2 });
    expect(api.estimate).toBe(1 + 31);
  });

  it('prices the lease of the mute the run holds in a part of its own: who the run writes as, three reads, each set assigned and taken back', async () => {
    const plan = {
      assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Contact_Bypass'] }],
    };
    const { api } = await measureSyncWrite(contacts, measures({ mutePlan: () => plan }));
    expect(api.parts).toEqual({ run: 1 + 2 + 3 + 4, mute: 2 + 3 + 2 });
    // A mute that assigns nothing asks the org nothing.
    const none = await measureSyncWrite(contacts, measures({ mutePlan: () => ({ assign: [] }) }));
    expect(none.api).not.toHaveProperty('parts');
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

  it('lists every reason it stops a run for in the order it meets them, the first the one it stops with', async () => {
    // Past the storage, the requests and the emails left today at once: the
    // command line was refused for the storage alone, and a pipeline that
    // freed it was refused again for the requests.
    const measured = await measureSyncWrite(
      counted([{ objectApiName: 'Contact', operation: 'insert', rows: 3_000 }]),
      measures({
        readStorage: async () => ({
          maxMB: 5,
          remainingMB: 4,
          dailyApiRequests: { max: 15_000, remaining: 3 },
        }),
        readAutomation: async () => WELCOME_FLOW,
      }),
    );

    const stops = syncGateStops(measured, { policy: 'refuse', org: 'TRAP' });

    expect(stops.map(({ code }) => code)).toEqual([
      'SYNC_STORAGE_EXCEEDED',
      API_BUDGET_EXCEEDED,
      'SYNC_EMAILS_EXCEEDED',
    ]);
    const answer = await gateSyncWrite(measured, {
      policy: 'refuse',
      org: 'TRAP',
      orgTier: 'development',
    });
    expect(answer).toEqual({ go: false, ...stops[0] });
    // Asked, the emails are the user's to answer: no stop of them.
    expect(syncGateStops(measured, { policy: 'ask', org: 'TRAP' }).map(({ code }) => code)).toEqual(
      ['SYNC_STORAGE_EXCEEDED', API_BUDGET_EXCEEDED],
    );
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

    // The org withholds the emails of its automation: said, never asked about.
    expect(answer).toEqual({ go: true, asked: true, emails: WITHHELD });
    expect(confirm.mock.calls[0][0].deliverability).toBeUndefined();
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
    expect(confirm.mock.calls[0][0]).not.toHaveProperty('rolesLinked');

    // The roles the run links to the platform's, said in the question too.
    const withRoles = await measureSyncWrite(
      { ...pastEmails, rolesLinked: 2 },
      measures({ readAutomation: async () => WELCOME_FLOW }),
    );
    await gateSyncWrite(withRoles, { policy: 'ask', org: 'TRAP', orgTier: 'development', confirm });
    expect(confirm.mock.calls[1][0]).toMatchObject({ total: 20, rolesLinked: 2 });
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

    // What could not be read may send emails: the org's deliverability is
    // read all the same, and withholds them.
    expect([first, second]).toEqual([
      { go: true, asked: true, emails: WITHHELD },
      { go: true, asked: true, emails: WITHHELD },
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
      ).toEqual({ go: true, asked: false, emails: WITHHELD });
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

  it('counts the contacts an account left out holds back apart, writes none of them, and names them in its refusal', async () => {
    // A run whose account upsert matched on Name said "4 record(s) to write
    // … Contact 4", and its refusal named the account alone: the run would
    // have written none of the contacts, each naming an account left out.
    const confirm = vi.fn();
    const measured = await measureSyncWrite(
      {
        objects: [{ objectApiName: 'Contact', operation: 'insert', rows: 0 }],
        alreadyCopied: 0,
        unwritable: [
          { objectApiName: 'Account', operation: 'upsert', rows: 2, why: 'notAKey', key: 'Name' },
        ],
        heldBack: [{ objectApiName: 'Contact', rows: 4, parent: 'Account', field: 'AccountId' }],
      },
      measures(),
    );

    expect(measured.check).toMatchObject({
      objects: [],
      total: 0,
      heldBack: [{ objectApiName: 'Contact', rows: 4, parent: 'Account', field: 'AccountId' }],
      verdict: 'refused',
    });
    // Nothing else to write: refused whoever answers, nobody asked.
    for (const policy of ['ask', 'unattended', 'refuse'] as const) {
      expect(
        await gateSyncWrite(measured, { policy, org: 'TRAP', orgTier: 'development', confirm }),
      ).toEqual({
        go: false,
        code: 'SYNC_TARGET_UNWRITABLE',
        message:
          'TRAP would take no record of one object the sync writes — Account (2 records): its ' +
          'upsert matches on Name, neither an External ID nor an idLookup field in TRAP. Left ' +
          'out, it holds back 4 Contact records, whose AccountId names an Account record left ' +
          'out. Leave it out of the run, or match on an External ID field of TRAP. Nothing was ' +
          'written.',
      });
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('names in the question that leaves an object out the rows it holds back, which the run writes none of', async () => {
    // Asked with an account left out, the question listed the opportunities
    // alone: the contacts, every one naming an account left out, were
    // neither among the records to write nor said held back, and the result
    // then counted them failed.
    const confirm = vi.fn(
      async (_question: WriteConfirmation): Promise<'confirmed'> => 'confirmed',
    );
    const measured = await measureSyncWrite(
      {
        objects: [
          { objectApiName: 'Contact', operation: 'insert', rows: 0 },
          { objectApiName: 'Opportunity', operation: 'insert', rows: 10 },
        ],
        alreadyCopied: 0,
        unwritable: [
          { objectApiName: 'Account', operation: 'upsert', rows: 2, why: 'notAKey', key: 'Name' },
        ],
        heldBack: [{ objectApiName: 'Contact', rows: 4, parent: 'Account', field: 'AccountId' }],
      },
      measures(),
    );

    const answer = await gateSyncWrite(measured, {
      policy: 'ask',
      org: 'TRAP',
      orgTier: 'development',
      confirm,
    });

    expect(answer).toEqual({ go: true, asked: true });
    expect(confirm.mock.calls[0][0]).toMatchObject({
      objects: [{ objectApiName: 'Opportunity', rows: 10 }],
      total: 10,
      unwritable: [{ objectApiName: 'Account', rows: 2, why: 'notAKey', key: 'Name' }],
      heldBack: [{ objectApiName: 'Contact', rows: 4, parent: 'Account', field: 'AccountId' }],
    });
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

    // 1,000 contacts in one Bulk API job of sixteen calls, no rule watching
    // them; before it, what they write over read in twenty statements of
    // fifty, as a call that may write more than a hundred fields reads it,
    // one sent again without the stamps, and whether the run's user reads
    // encrypted fields; and the run's reads of the target.
    expect(measured.check).toMatchObject({
      apiRequests: {
        verdict: 'exceeds',
        estimate: 16 + (20 + 1 + 1) + GATE_READS,
        remaining: 4,
        max: 15_000,
      },
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

    // 3,000 contacts in one job of twenty-two calls, and the run's reads.
    expect(confirm.mock.calls[0][0]).toMatchObject({
      apiRequests: { estimate: 22 + GATE_READS, remaining: 1_000, max: 15_000 },
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

describe('mutingSyncWriteGate', () => {
  /** The welcome flow, kept quiet for a holder of `Contact_Bypass`, which `PS_Bypass` holds. */
  const BYPASSED: ForgeTargetAutomation = {
    ...WELCOME_FLOW,
    objects: WELCOME_FLOW.objects.map((object) => ({
      ...object,
      flows: object.flows.map((flow) => ({
        ...flow,
        permissions: [{ name: 'Contact_Bypass', bypass: true, held: false }],
      })),
    })),
    bypassGrants: [
      {
        permission: 'Contact_Bypass',
        permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
      },
    ],
  };
  const SET = '0PSxx0000000001AAA';
  // Twenty contacts, two emails each, twelve left today: refused unless muted.
  const write = counted([{ objectApiName: 'Contact', operation: 'insert', rows: 20 }]);

  function gateOf(setup: Parameters<typeof memoryPermissionOrg>[0] = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-mute-'));
    const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'PS_Bypass' }], ...setup });
    const readAutomation = vi.fn(async () => BYPASSED);
    const muting = mutingSyncWriteGate(
      (read) =>
        syncWriteGate(measures({ readAutomation: read }), {
          policy: 'refuse',
          org: 'TRAP',
          orgTier: 'development',
        }),
      readAutomation,
      (read) =>
        muteForRun(async () => muteOrgOf(org.connection), read, {
          dir,
          renewEveryMs: 0,
          writes: syncRunWrites,
        }),
      'run-1',
      { target: 'TRAP' },
    );
    return { muting, org, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('measures what still runs once the mute is planned, and takes the lease as the gate lets the run write', async () => {
    // Unmuted, the emails refuse the run.
    const plain = syncWriteGate(measures({ readAutomation: async () => BYPASSED }), {
      policy: 'refuse',
      org: 'TRAP',
      orgTier: 'development',
    });
    expect((await plain.hold(write)).answer).toMatchObject({
      go: false,
      code: 'SYNC_EMAILS_EXCEEDED',
    });

    const { muting, org, done } = gateOf();
    const held = await muting.gate.hold(write);
    expect(held.answer).toEqual({ go: true, asked: false });
    expect(org.assignments().map((a) => a.permissionSetId)).toEqual([SET]);

    const muted = await muting.release();
    expect(muted).toMatchObject({ state: 'muted', assigned: ['PS_Bypass'], released: true });
    expect(org.assignments()).toEqual([]);
    done();
  });

  it('hands its gate the mute it planned, whose lease the run’s requests count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-mute-'));
    const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'PS_Bypass' }] });
    const planned: Array<SyncWriteMeasures['mutePlan']> = [];
    const muting = mutingSyncWriteGate(
      (read, mutePlan) => {
        planned.push(mutePlan);
        return syncWriteGate(measures({ readAutomation: read, mutePlan }), {
          policy: 'refuse',
          org: 'TRAP',
          orgTier: 'development',
        });
      },
      async () => BYPASSED,
      (read) =>
        muteForRun(async () => muteOrgOf(org.connection), read, {
          dir,
          renewEveryMs: 0,
          writes: syncRunWrites,
        }),
      'run-1',
      { target: 'TRAP' },
    );
    // Not planned yet: no lease to price.
    expect(planned[0]?.()).toBeUndefined();

    expect((await muting.gate.hold(write)).answer).toMatchObject({ go: true });
    expect(planned[0]?.()?.assign.map((a) => a.permissionSet)).toEqual(['PS_Bypass']);
    await muting.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops the run at its gate when the mute is refused, nothing assigned', async () => {
    const { muting, org, done } = gateOf({ canAssign: false });
    const held = await muting.gate.hold(write);
    expect(held.answer).toMatchObject({ go: false, code: 'MUTE_NO_RIGHT' });
    expect(org.writes).toEqual([]);
    expect(await muting.release()).toBeUndefined();
    done();
  });
});
