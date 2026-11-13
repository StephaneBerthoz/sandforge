import { describe, it, expect, vi } from 'vitest';
import type { ApiName, ForgeTargetAutomation } from '@sandforge/shared';

import type { WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import type { DataStorage } from '../forge/ForgeRunGate.js';
import {
  runEmailsOf,
  type DeliverabilityRead,
  type RunEmails,
  type RunEmailsInput,
} from '../forge/targetDeliverability.js';
import {
  autopilotApiCheck,
  autopilotReadBackOf,
  autopilotWritePlan,
  gateAutopilotWrite,
  type AutopilotGateInput,
} from './AutopilotRunGate.js';

/*
 * What an Autopilot run's gate makes of the emails of what still runs as its
 * plan writes, and of the requests it sends once its writes are through to
 * read back the record types the target gave: counted, asked about on an org
 * that delivers them, and let through on one that withholds them.
 */

/** A plan of the given objects, one wave each. */
function planOf(...objects: string[]) {
  return {
    waves: objects.map((name, order) => ({ order, objects: [name as ApiName], dependsOn: [] })),
  };
}

// 400 accounts and 40 contacts, and no lead: two REST calls and one.
const plan = autopilotWritePlan(
  planOf('Account', 'Contact', 'Lead'),
  new Map([
    ['Account', 400],
    ['Contact', 40],
    ['Lead', 0],
  ]),
);

/** A target with room, and `remaining` of `max` requests left today. */
function storageOf(remaining: number, max = 15_000): DataStorage {
  return { maxMB: 500, remainingMB: 400, dailyApiRequests: { max, remaining } };
}

/** What the target runs on the contacts: a welcome email no bypass keeps quiet. */
const WELCOME: ForgeTargetAutomation = {
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
          messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
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

/** What the plan's emails came to, the org's deliverability read as `read` says. */
function emailsOf(
  read: DeliverabilityRead,
  over: Partial<RunEmailsInput> = {},
): Promise<RunEmails> {
  return runEmailsOf({
    read: WELCOME,
    writes: (_objectApiName, write) => write === 'insert' || write === 'update',
    readDeliverability: async () => read,
    accepted: false,
    target: 'TRAP',
    run: 'autopilot',
    ...over,
  });
}

/** The gate of the plan on a target with room, asking `confirm`. */
function inputOf(overrides: Partial<AutopilotGateInput> = {}): AutopilotGateInput {
  return {
    plan,
    storage: storageOf(14_000),
    readApiBudget: async () => ({ max: 15_000, remaining: 14_000 }),
    confirmAboveRecords: 2_000,
    org: 'TRAP',
    orgTier: 'development',
    confirm: vi.fn(async () => 'confirmed' as const),
    ...overrides,
  };
}

describe('autopilotReadBackOf', () => {
  it('bounds the reads back at one an object the plan writes records of', () => {
    expect(autopilotReadBackOf(plan)).toBe(2);
    expect(autopilotReadBackOf({ objects: [] })).toBe(0);
  });
});

describe('autopilotApiCheck', () => {
  it('counts the reads back and the read of the deliverability beside the plan’s own requests, each named', async () => {
    const own = await autopilotApiCheck(plan, storageOf(14_000), vi.fn());

    const counted = await autopilotApiCheck(plan, storageOf(14_000), vi.fn(), undefined, {
      readBack: 2,
      deliverability: 1,
    });

    expect(counted.estimate).toBe(own.estimate + 3);
    expect(counted.parts).toEqual({ run: own.estimate, readBack: 2, deliverability: 1 });
  });
});

describe('gateAutopilotWrite, on its emails and its reads back', () => {
  it('refuses a plan past the requests left once its reads back are counted', async () => {
    const own = await autopilotApiCheck(plan, storageOf(14_000), vi.fn());
    const storage = storageOf(own.estimate + 1);

    const without = await gateAutopilotWrite(inputOf({ storage, confirmAboveRecords: 0 }));
    const counted = await gateAutopilotWrite(
      inputOf({ storage, confirmAboveRecords: 0, readBack: autopilotReadBackOf(plan) }),
    );

    expect(without.go).toBe(true);
    expect(counted).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
    expect(counted.go ? '' : counted.message).toContain(
      '(2 of them to read back the record types the target gave)',
    );
  });

  it('refuses a plan past the requests left once the lease of its mute is counted, its part named', async () => {
    const own = await autopilotApiCheck(plan, storageOf(14_000), vi.fn());
    const storage = storageOf(own.estimate + 6);

    const without = await gateAutopilotWrite(inputOf({ storage, confirmAboveRecords: 0 }));
    // Who the run writes as, three reads, one set assigned and taken back.
    const muted = await gateAutopilotWrite(inputOf({ storage, confirmAboveRecords: 0, mute: 7 }));

    expect(without.go).toBe(true);
    expect(muted).toMatchObject({ go: false, code: 'API_BUDGET_EXCEEDED' });
    expect(
      (await autopilotApiCheck(plan, storageOf(14_000), vi.fn(), undefined, { mute: 7 })).parts,
    ).toEqual({ run: own.estimate, mute: 7 });
  });

  it('asks about the emails an org on All email delivers, though nothing else asks, and takes the answer for the accord', async () => {
    const confirm = vi.fn(async (_question: WriteConfirmation) => 'confirmed' as const);
    const runEmails = await emailsOf(
      { reading: { level: 'all' }, requests: 1 },
      { keepsAddresses: true },
    );

    const outcome = await gateAutopilotWrite(inputOf({ confirm, runEmails }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      module: 'autopilot',
      deliverability: {
        reading: { level: 'all' },
        keepsAddresses: true,
        senders: [{ objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome' }],
      },
    });
    expect(confirm.mock.calls[0][0].apiRequests).toBeUndefined();
    expect(outcome).toMatchObject({
      go: true,
      asked: true,
      emails: { accepted: true, deliverability: 'all' },
    });
  });

  it('writes nothing once declined, and keeps what the org delivers for the audit', async () => {
    const runEmails = await emailsOf({ reading: { unread: 'timed out' }, requests: 1 });

    const outcome = await gateAutopilotWrite(
      inputOf({ confirm: async () => 'declined', runEmails }),
    );

    expect(outcome).toMatchObject({
      go: false,
      code: 'WRITE_DECLINED',
      emails: { accepted: false, deliverability: 'unread' },
    });
  });

  it('asks nothing of an org that withholds them, and says it read them so', async () => {
    const confirm = vi.fn(async () => 'confirmed' as const);
    const runEmails = await emailsOf({ reading: { level: 'withheld' }, requests: 2 });

    const outcome = await gateAutopilotWrite(inputOf({ confirm, runEmails }));

    expect(confirm).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      go: true,
      check: expect.anything(),
      asked: false,
      emails: { accepted: false, deliverability: 'withheld' },
    });
  });
});
