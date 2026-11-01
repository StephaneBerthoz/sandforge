import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ForgeTargetAutomation,
  ForgeTargetObjectAutomation,
  MutedAutomation,
} from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  automationOf,
  changedSince,
  clock,
  previewed,
  removeTaken,
  request,
  resultOf,
  rewound,
  stateOf,
  T0,
  taken,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { planMute } from '../forge/AutomationMuteLease.js';
import { DELIVERABILITY_APEX } from '../forge/targetDeliverability.js';
import { writePathOrderDefects, type WritePathStep } from './beforeRunCheckpoint.js';
import type { MuteOfWrites } from './rewindOrg.js';
import { undoCheckpoint, type UndoCheckpointRequest } from './undoCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * Whether the org delivers the emails of what still runs, as a rewind and an
 * undo read it and judge it on the memory org: the answers its anonymous Apex
 * gave on a Developer Edition switched through the three levels, a request
 * counted for each, and every step of the write path told in order.
 */

/** What an org on All email answers. */
const ALL_EMAIL = {
  compiled: true,
  success: true,
  compileProblem: null,
  exceptionStackTrace: null,
  exceptionMessage: null,
};

/** The flow every test but those of no sender runs: it emails an owner as an account is updated. */
function accountChanged(bypass = false): ForgeTargetObjectAutomation {
  return {
    objectApiName: 'Account',
    flows: [
      {
        apiName: 'Account_changed',
        label: 'Account changed',
        timing: 'afterSave',
        startsOn: 'update',
        condition: 'read',
        permissions: bypass ? [{ name: 'Skip_Account', bypass: true, held: false }] : [],
        messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
      },
    ],
    triggers: [],
  };
}

const SENDING = automationOf({ objects: [accountChanged()] });

/** The same flow, kept quiet for whoever holds the set the org grants its bypass in. */
const MUTABLE: Partial<ForgeTargetAutomation> = {
  objects: [accountChanged(true)],
  bypassGrants: [
    {
      permission: 'Skip_Account',
      permissionSets: [{ name: 'Skip_Account_Set', label: 'Skip', grants: 1 }],
    },
  ],
};

/** The flow a bypass keeps quiet, and one no bypass does: the read has something left to say. */
const ONE_LEFT_RUNNING: ForgeTargetObjectAutomation[] = [
  {
    ...accountChanged(true),
    flows: [
      ...accountChanged(true).flows,
      { ...accountChanged().flows[0], apiName: 'Account_noticed', label: 'Account noticed' },
    ],
  },
];

/** A checkpoint, what a colleague did since and the preview confirmed. */
async function changed(): Promise<{ t: Taken; previewId: string; before: unknown }> {
  const t = await taken();
  changedSince(t.org);
  const diff = await previewed(t);
  return { t, previewId: diff.previewId, before: stateOf(t.org) };
}

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

describe('a rewind on the emails what still runs sends', () => {
  it('refuses an org that delivers them all, whatever its automation’s acceptance says, and says where they go', async () => {
    const { t, previewId, before } = await changed();
    t.org.anonymousApex = ALL_EMAIL;

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: SENDING },
      request: { acceptAutomation: true },
    });

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'EMAILS_DELIVERED' } });
    const said = outcome.rewound ? '' : outcome.refusal.message;
    expect(said).toContain(
      'DEV-ED delivers every email its automation sends (Setup > Deliverability: All email)',
    );
    expect(said).toContain('flow "Account changed" on Account');
    // A rewind writes the org's own values back: nothing of it is under .invalid.
    expect(said).toContain('those of the records this rewind writes, as they hold them');
    expect(said).not.toContain('.invalid');
    expect(said).toContain('Add --accept-emails to rewind all the same');
    expect(stateOf(t.org)).toEqual(before);
    expect(t.org.anonymousAsked).toEqual([DELIVERABILITY_APEX]);
  });

  it('writes once they are accepted, and says for the audit trail what it read', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: SENDING },
      request: { acceptAutomation: true, acceptEmails: true },
    });

    expect(resultOf(outcome).status).toBe('success');
    expect(outcome).toMatchObject({ deliverability: 'all' });
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
  });

  it('asks nothing of an org that withholds them, its user holding Send Email', async () => {
    const { t, previewId } = await changed();

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: SENDING },
      request: { acceptAutomation: true },
    });

    expect(resultOf(outcome).status).toBe('success');
    expect(outcome).toMatchObject({ deliverability: 'withheld' });
    expect(t.org.anonymousAsked).toHaveLength(1);
  });

  it('refuses an org whose answer it does not know, naming it, rather than take it for closed', async () => {
    const { t, previewId, before } = await changed();
    t.org.anonymousApex = {
      compiled: true,
      success: false,
      exceptionMessage: 'System.LimitException: something else',
    };

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: SENDING },
      request: { acceptAutomation: true },
    });

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'EMAILS_DELIVERED',
        message: expect.stringContaining(
          'could not be read (the org answered: System.LimitException: something else)',
        ) as unknown,
      },
    });
    expect(stateOf(t.org)).toEqual(before);
  });

  it('reads nothing when nothing that still runs sends one, and writes', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: automationOf() },
    });

    expect(resultOf(outcome).status).toBe('success');
    expect(outcome).not.toHaveProperty('deliverability');
    expect(t.org.anonymousAsked).toEqual([]);
  });

  it('leaves the daily limit of emails to its own refusal, which their acceptance does not lift', async () => {
    const { t, previewId, before } = await changed();
    t.org.anonymousApex = ALL_EMAIL;
    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 0 } };

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: SENDING },
      request: { acceptAutomation: true, acceptEmails: true },
    });

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'EMAILS' } });
    expect(stateOf(t.org)).toEqual(before);
  });

  it('counts the read among the requests the day has left, by name', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;
    t.org.limits = { Max: 15_000, Remaining: 30 };

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: SENDING },
      request: { acceptAutomation: true, acceptEmails: true },
    });

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringMatching(
          /^This rewind takes about \d+ API requests \(1 of them to read whether DEV-ED delivers its emails\); DEV-ED has 30/,
        ) as unknown,
      },
    });
  });

  it('names what the mute would keep quiet when it could mute and was not asked to', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: automationOf(MUTABLE) },
      request: { acceptAutomation: true, canMute: true },
    });

    expect(outcome.rewound ? '' : outcome.refusal.message).toContain(
      '--mute-automation keeps quiet flow "Account changed" on Account',
    );
  });
});

/** A mute whose lease holds what `holds` keeps of its plan's sets, each step told in order. */
function leased(steps: WritePathStep[], holds: (planned: string[]) => string[]): MuteOfWrites {
  return (automation, writes) => {
    steps.push('leasePlan', 'stillRunning');
    const { plan, automation: held, planned } = planMute(automation, writes);
    const outcome: MutedAutomation = {
      ...planned,
      state: 'muted',
      assigned: holds(plan.assign.map((set) => set.permissionSet)),
    };
    return Promise.resolve({
      automation: held,
      plan,
      muted: planned,
      prepared: {
        plan,
        automation: held,
        planned,
        acquire: () => {
          steps.push('leaseAcquire');
          return Promise.resolve({
            outcome,
            release: () => {
              steps.push('leaseRelease');
              return Promise.resolve({ ...outcome, released: true });
            },
          });
        },
      },
    });
  };
}

/** Tells the steps of a write path that reach the org, as the org hears them. */
function telling(t: Taken, steps: WritePathStep[]): void {
  const org = t.org;
  const write = <K extends 'update' | 'create' | 'destroy' | 'undelete'>(name: K): void => {
    const call = org[name].bind(org) as (...args: unknown[]) => Promise<unknown>;
    (org as unknown as Record<K, unknown>)[name] = (...args: unknown[]) => {
      if (steps.at(-1) !== 'write') steps.push('write');
      return call(...args);
    };
  };
  (['update', 'create', 'destroy', 'undelete'] as const).forEach(write);
  const request = org.request.bind(org);
  org.request = (asked) => {
    if (asked.url.includes('executeAnonymous')) steps.push('deliverabilityRead');
    return request(asked);
  };
  // Read once its gate let it through, right before the first write's journal:
  // where a person's answer would stand, had the rewind a question of its own.
  const userId = org.userId.bind(org);
  org.userId = () => {
    if (!steps.includes('question')) steps.push('question');
    return userId();
  };
}

/** The steps of a run a test told, in the order the write path keeps. */
const run = (steps: readonly WritePathStep[]): WritePathStep[] => ['reads', ...steps, 'result'];

describe('a rewind’s write path, on its emails', () => {
  it('reads the deliverability after the lease is planned and before it is taken, and writes under it', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;
    const steps: WritePathStep[] = [];
    telling(t, steps);

    const outcome = await rewound(t, previewId, {
      deps: {
        readAutomation: automationOf({ ...MUTABLE, objects: ONE_LEFT_RUNNING }),
        mute: leased(steps, (planned) => planned),
      },
      request: { acceptAutomation: true, acceptEmails: true },
    });

    expect(resultOf(outcome).status).toBe('success');
    expect(writePathOrderDefects(run(steps))).toEqual([]);
    expect(steps.slice(0, 5)).toEqual([
      'leasePlan',
      'stillRunning',
      'deliverabilityRead',
      'question',
      'leaseAcquire',
    ]);
    expect(steps.filter((step) => step === 'deliverabilityRead')).toHaveLength(1);
    expect(steps.indexOf('write')).toBeGreaterThan(steps.indexOf('leaseAcquire'));
    expect(steps.at(-1)).toBe('leaseRelease');
  });

  it('reads nothing and asks nothing of the emails when the mute keeps every sender quiet', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;
    const steps: WritePathStep[] = [];
    telling(t, steps);

    const outcome = await rewound(t, previewId, {
      deps: {
        readAutomation: automationOf(MUTABLE),
        mute: leased(steps, (planned) => planned),
      },
      request: { acceptAutomation: true },
    });

    expect(resultOf(outcome).status).toBe('success');
    expect(t.org.anonymousAsked).toEqual([]);
    expect(writePathOrderDefects(run(steps))).toEqual([]);
  });

  it('refuses before its first write a lease that does not hold the set keeping the sender quiet, and gives it back', async () => {
    const { t, previewId, before } = await changed();
    t.org.anonymousApex = ALL_EMAIL;
    const steps: WritePathStep[] = [];
    telling(t, steps);

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: automationOf(MUTABLE), mute: leased(steps, () => []) },
      request: { acceptAutomation: true },
    });

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'EMAILS_DELIVERED',
        message: expect.stringContaining(
          'flow "Account changed" on Account may send emails',
        ) as unknown,
      },
    });
    expect(steps).not.toContain('write');
    expect(steps.at(-1)).toBe('leaseRelease');
    expect(stateOf(t.org)).toEqual(before);
    expect(writePathOrderDefects(run(steps))).toEqual([]);
  });

  it('lets such a lease through once the emails were accepted', async () => {
    const { t, previewId } = await changed();
    t.org.anonymousApex = ALL_EMAIL;
    const steps: WritePathStep[] = [];

    const outcome = await rewound(t, previewId, {
      deps: { readAutomation: automationOf(MUTABLE), mute: leased(steps, () => []) },
      request: { acceptAutomation: true, acceptEmails: true },
    });

    expect(resultOf(outcome).status).toBe('success');
  });
});

/** A rewind that went through with nothing to ask, and the undo of it asked with `asked`. */
async function undoOf(
  deps: Parameters<typeof undoCheckpoint>[0] extends infer D ? Partial<D> : never,
  asked: Partial<UndoCheckpointRequest> = {},
  prepare: (t: Taken) => void = () => undefined,
) {
  const { t, previewId } = await changed();
  const rewind = resultOf(await rewound(t, previewId));
  const read = await t.store.read(t.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  clock.now += 60_000;
  t.org.ticking = true;
  prepare(t);
  const before = stateOf(t.org);
  const outcome = await undoCheckpoint(
    { org: t.org, undelete: (ids) => t.org.undelete(ids), store: t.store, ...deps },
    {
      ...request(t),
      checkpoint: read.checkpoint,
      rewindId: rewind.rewindId,
      acceptAutomation: true,
      ...asked,
    },
  );
  t.org.ticking = false;
  return { t, outcome, before };
}

describe('an undo on the emails what still runs sends', () => {
  it('refuses an org that delivers them all, whatever its automation’s acceptance says', async () => {
    const { t, outcome, before } = await undoOf({ readAutomation: SENDING }, {}, (t) => {
      t.org.anonymousApex = ALL_EMAIL;
    });

    expect(outcome).toMatchObject({ undone: false, refusal: { code: 'EMAILS_DELIVERED' } });
    const said = outcome.undone ? '' : outcome.refusal.message;
    expect(said).toContain('Add --accept-emails to undo all the same');
    expect(said).toContain('as they hold them');
    expect(stateOf(t.org)).toEqual(before);
    expect(t.org.anonymousAsked).toEqual([DELIVERABILITY_APEX]);
  });

  it('writes once they are accepted, and says for the audit trail what it read', async () => {
    const { outcome } = await undoOf({ readAutomation: SENDING }, { acceptEmails: true }, (t) => {
      t.org.anonymousApex = ALL_EMAIL;
    });

    expect(outcome).toMatchObject({ undone: true, deliverability: 'all' });
  });

  it('asks nothing of an org that withholds them, and reads nothing when nothing sends', async () => {
    const closed = await undoOf({ readAutomation: SENDING });
    expect(closed.outcome).toMatchObject({ undone: true, deliverability: 'withheld' });

    const quiet = await undoOf({ readAutomation: automationOf() });
    expect(quiet.outcome).toMatchObject({ undone: true });
    expect(quiet.outcome).not.toHaveProperty('deliverability');
    expect(quiet.t.org.anonymousAsked).toEqual([]);
  });

  it('counts the read among the requests the day has left, by name', async () => {
    const { outcome } = await undoOf({ readAutomation: SENDING }, { acceptEmails: true }, (t) => {
      t.org.anonymousApex = ALL_EMAIL;
      t.org.limits = { Max: 15_000, Remaining: 8 };
    });

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringMatching(
          /^This undo takes about \d+ API requests \(1 of them to read whether DEV-ED delivers its emails\); DEV-ED has 8/,
        ) as unknown,
      },
    });
  });

  it('keeps its write path in order under a lease, the read before it is taken', async () => {
    const steps: WritePathStep[] = [];
    const { t, outcome } = await undoOf(
      {
        readAutomation: automationOf({ ...MUTABLE, objects: ONE_LEFT_RUNNING }),
        mute: leased(steps, (planned) => planned),
      },
      { acceptEmails: true },
      (t) => {
        t.org.anonymousApex = ALL_EMAIL;
        telling(t, steps);
      },
    );

    expect(outcome).toMatchObject({ undone: true, deliverability: 'all' });
    expect(t.org.anonymousAsked).toHaveLength(1);
    expect(writePathOrderDefects(run(steps))).toEqual([]);
    expect(steps.slice(0, 5)).toEqual([
      'leasePlan',
      'stillRunning',
      'deliverabilityRead',
      'question',
      'leaseAcquire',
    ]);
    expect(steps.at(-1)).toBe('leaseRelease');
  });

  it('refuses before its first write a lease that does not hold the set keeping the sender quiet, and gives it back', async () => {
    const steps: WritePathStep[] = [];
    const { t, outcome, before } = await undoOf(
      {
        readAutomation: automationOf(MUTABLE),
        mute: leased(steps, () => []),
      },
      {},
      (t) => {
        t.org.anonymousApex = ALL_EMAIL;
        telling(t, steps);
      },
    );

    expect(outcome).toMatchObject({
      undone: false,
      refusal: {
        code: 'EMAILS_DELIVERED',
        message: expect.stringContaining('Add --accept-emails to undo all the same') as unknown,
      },
    });
    expect(steps).not.toContain('write');
    expect(steps.at(-1)).toBe('leaseRelease');
    expect(stateOf(t.org)).toEqual(before);
    expect(writePathOrderDefects(run(steps))).toEqual([]);
  });
});
