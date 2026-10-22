import { describe, it, expect, vi } from 'vitest';
import type { ApiName, ForgeTargetAutomation } from '@sandforge/shared';
import type { WriteConfirmation } from '../../core/precheck/ProductionGuard';
import {
  autopilotEmails,
  autopilotWritePlan,
  gateAutopilotWrite,
  objectsThePlanWrites,
} from './AutopilotRunGate';

/** A plan of the given objects, one wave each. */
function planOf(...objects: string[]) {
  return {
    waves: objects.map((name, order) => ({ order, objects: [name as ApiName], dependsOn: [] })),
  };
}

describe('autopilotWritePlan', () => {
  it("counts the plan's records per object, the most first, and the storage they take", () => {
    const plan = autopilotWritePlan(
      planOf('Account', 'Contact', 'Empty__c'),
      new Map([
        ['Account', 10],
        ['Contact', 40],
        ['Empty__c', 0],
      ]),
    );

    expect(plan.objects.map((o) => [o.objectApiName, o.rows])).toEqual([
      ['Contact', 40],
      ['Account', 10],
    ]);
    expect(plan.totalRows).toBe(50);
    expect(plan.storageBytes).toBe(50 * 2048);
  });

  it('sizes a person account at 4 KB and its contact at nothing of its own, as Forge sizes them', () => {
    // Salesforce counts a person account at 4 KB, being an account and a
    // contact; every record went at 2 KB, and a plan of person accounts said
    // half the storage it takes.
    const plan = autopilotWritePlan(
      planOf('Account', 'Contact', 'Opportunity'),
      new Map([
        ['Account', 20],
        ['Contact', 30],
        ['Opportunity', 20],
      ]),
      new Map([
        ['Account', 10],
        ['Contact', 10],
      ]),
    );

    const bytesOf = (name: string): number | undefined =>
      plan.objects.find((o) => o.objectApiName === name)?.storageBytes;
    expect(bytesOf('Account')).toBe(10 * 2048 + 10 * 4096);
    expect(bytesOf('Contact')).toBe(20 * 2048);
    expect(bytesOf('Opportunity')).toBe(20 * 2048);
    // Every record is still counted among those written.
    expect(plan.totalRows).toBe(70);
  });
});

describe('gateAutopilotWrite', () => {
  const roomy = { maxMB: 200, remainingMB: 150 };

  it('refuses a plan past the storage the target has left, before asking anything', async () => {
    // Run for real with plan only, 2.6 million records were planned for a
    // target with 22 MB left, and the run would have gone straight to write.
    const confirm = vi.fn();
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Account'), new Map([['Account', 20_000]])),
      storage: { maxMB: 200, remainingMB: 22 },
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: false, code: 'STORAGE_EXCEEDED' });
    expect(outcome.go === false && outcome.message).toContain('Nothing was written.');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks past the setting, with the counted records per object, and goes on when confirmed', async () => {
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'confirmed' as const);
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 2_500]])),
      storage: roomy,
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: true, asked: true });
    expect(confirm.mock.calls[0][0]).toMatchObject({
      stage: 'write',
      module: 'autopilot',
      objects: [{ objectApiName: 'Lead', rows: 2_500 }],
      total: 2_500,
      aboveRecords: 2_000,
      counted: true,
    });
  });

  it('stops when the question is declined, or when nobody can be asked', async () => {
    const run = (answer: 'declined' | 'unavailable') =>
      gateAutopilotWrite({
        plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 2_500]])),
        storage: roomy,
        confirmAboveRecords: 2_000,
        org: 'TARGET',
        orgTier: 'development',
        confirm: async () => answer,
      });

    expect(await run('declined')).toMatchObject({ go: false, code: 'WRITE_DECLINED' });
    expect(await run('unavailable')).toMatchObject({
      go: false,
      code: 'CONFIRMATION_UNAVAILABLE',
    });
  });

  it('asks when the target would not say what storage it has left', async () => {
    const confirm = vi.fn(async () => 'confirmed' as const);
    await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 3]])),
      storage: { unread: 'INSUFFICIENT_ACCESS' },
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('refuses a plan past the API requests the target has left today, asking nothing', async () => {
    // Only Forge's Review compared them: a run into an org whose
    // integrations had used the day's requests stopped part way through.
    const confirm = vi.fn();
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 1_000]])),
      storage: { ...roomy, dailyApiRequests: { max: 15_000, remaining: 4 } },
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
    expect(outcome.go === false && outcome.message).toContain(
      'The run takes about 5 API requests, and TARGET has 4 of its 15000 daily requests left',
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks when the target would not say what it has left of a daily email limit, saying so', async () => {
    // Said only in the log: the run went ahead without a question.
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'confirmed' as const);
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Contact'), new Map([['Contact', 20]])),
      storage: { ...roomy, dailyApiRequests: { max: 15_000, remaining: 1_400 } },
      confirmAboveRecords: 2_000,
      emails: [
        {
          limit: 'SingleEmail',
          emails: 40,
          verdict: 'unread',
          unread: 'INSUFFICIENT_ACCESS',
          objects: [],
        } as never,
      ],
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: true, asked: true });
    expect(confirm.mock.calls[0][0]).toMatchObject({
      emailsUnread: [{ limit: 'SingleEmail', emails: 40, unread: 'INSUFFICIENT_ACCESS' }],
      apiRequests: { estimate: 1, remaining: 1_400, max: 15_000 },
    });
  });

  it('lets a small plan that fits through without a question', async () => {
    const confirm = vi.fn();
    const outcome = await gateAutopilotWrite({
      plan: autopilotWritePlan(planOf('Lead'), new Map([['Lead', 3]])),
      storage: roomy,
      confirmAboveRecords: 2_000,
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: true, asked: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});

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

describe('objectsThePlanWrites', () => {
  it('names each object of the waves once, in their order', () => {
    expect(
      objectsThePlanWrites({
        waves: [
          { order: 0, objects: ['Account' as ApiName], dependsOn: [] },
          { order: 1, objects: ['Contact' as ApiName, 'Account' as ApiName], dependsOn: [] },
        ],
      }),
    ).toEqual(['Account', 'Contact']);
  });
});

describe('autopilotEmails', () => {
  const plan = autopilotWritePlan(
    planOf('Account', 'Contact'),
    new Map([
      ['Account', 4],
      ['Contact', 30],
    ]),
  );

  it("reads what the target runs on the plan's objects, and counts its emails against what it has left today", async () => {
    const readAutomation = vi.fn(async (_objects: readonly string[]) => WELCOME_FLOW);
    const readLimits = vi.fn(async () => ({ SingleEmail: { max: 15, remaining: 15 } }));

    const emails = await autopilotEmails({
      plan,
      objects: ['Account', 'Contact'],
      readAutomation,
      readLimits,
    });

    expect(readAutomation).toHaveBeenCalledWith(['Account', 'Contact']);
    expect(emails.checks).toEqual([
      expect.objectContaining({
        limit: 'SingleEmail',
        emails: 60,
        verdict: 'exceeds',
        remaining: 15,
        max: 15,
        objects: [
          { objectApiName: 'Contact', rows: 30, perRecord: 2, sentBy: ['Contact welcome'] },
        ],
      }),
    ]);
  });

  it("counts a Developer Edition's email alerts against its single emails, as Seed counts them", async () => {
    // Counted against the workflow emails alone, 8,040 a day, the alert of a
    // contact rule fitted; the Developer Edition counts it against its fifteen
    // single emails, and a run of 30 contacts takes it past them.
    const alerting: ForgeTargetAutomation = {
      ...WELCOME_FLOW,
      objects: [
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [],
          workflowRules: [
            {
              apiName: 'Contact_Rule',
              label: 'Contact rule',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [],
              messages: [{ kind: 'email', name: 'Contact alert', limit: 'DailyWorkflowEmails' }],
            },
          ],
        },
      ],
    };

    const emails = await autopilotEmails({
      plan,
      objects: ['Account', 'Contact'],
      readAutomation: async () => alerting,
      readLimits: async () => ({
        SingleEmail: { max: 15, remaining: 15 },
        DailyWorkflowEmails: { max: 8_040, remaining: 8_040 },
      }),
    });

    expect(emails.checks).toEqual([
      expect.objectContaining({ limit: 'DailyWorkflowEmails', emails: 30, verdict: 'fits' }),
      expect.objectContaining({
        limit: 'SingleEmail',
        emails: 30,
        verdict: 'exceeds',
        alertsCounted: true,
      }),
    ]);
  });

  it('reads no limit when nothing the target runs sends an email', async () => {
    const readLimits = vi.fn(async () => ({}));
    const emails = await autopilotEmails({
      plan,
      objects: ['Account', 'Contact'],
      readAutomation: async () => ({ ...WELCOME_FLOW, objects: [] }),
      readLimits,
    });

    expect(emails).toEqual({ checks: [] });
    expect(readLimits).not.toHaveBeenCalled();
  });

  it("says the target's automation could not be read rather than counting no email", async () => {
    const emails = await autopilotEmails({
      plan,
      objects: ['Account', 'Contact'],
      readAutomation: async () => {
        throw new Error('INSUFFICIENT_ACCESS: no access to the Tooling API');
      },
      readLimits: async () => ({}),
    });

    expect(emails.checks).toEqual([]);
    expect(emails.unread).toContain('INSUFFICIENT_ACCESS');
  });
});

describe('gateAutopilotWrite — the emails of a plan', () => {
  const roomy = { maxMB: 200, remainingMB: 150 };
  const contacts = autopilotWritePlan(planOf('Contact'), new Map([['Contact', 30]]));
  const sixty = {
    limit: 'SingleEmail' as const,
    objects: [{ objectApiName: 'Contact', rows: 30, perRecord: 2, sentBy: ['Contact welcome'] }],
    emails: 60,
  };

  it('asks before a small plan whose flows take the target past a daily email limit, naming it', async () => {
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'declined' as const);
    const outcome = await gateAutopilotWrite({
      plan: contacts,
      storage: roomy,
      confirmAboveRecords: 2_000,
      emails: [{ ...sixty, verdict: 'exceeds', remaining: 15, max: 15 }],
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(confirm.mock.calls[0][0].emails).toEqual([
      {
        limit: 'SingleEmail',
        emails: 60,
        remaining: 15,
        max: 15,
        objects: [{ objectApiName: 'Contact', perRecord: 2 }],
      },
    ]);
    expect(outcome).toMatchObject({ go: false, code: 'WRITE_DECLINED' });
  });

  it('says in its question that the email alerts are among the single emails it counts', async () => {
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'declined' as const);
    await gateAutopilotWrite({
      plan: contacts,
      storage: roomy,
      confirmAboveRecords: 2_000,
      emails: [{ ...sixty, verdict: 'exceeds', remaining: 15, max: 15, alertsCounted: true }],
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(confirm.mock.calls[0][0].emails).toEqual([
      expect.objectContaining({ limit: 'SingleEmail', emails: 60, alertsCounted: true }),
    ]);
  });

  it('asks nothing when the emails fit in what the target has left', async () => {
    const confirm = vi.fn();
    const outcome = await gateAutopilotWrite({
      plan: contacts,
      storage: roomy,
      confirmAboveRecords: 2_000,
      emails: [{ ...sixty, verdict: 'fits', remaining: 900, max: 1_000 }],
      org: 'TARGET',
      orgTier: 'development',
      confirm,
    });

    expect(outcome).toMatchObject({ go: true, asked: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});
