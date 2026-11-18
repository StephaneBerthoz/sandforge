import { describe, it, expect } from 'vitest';

import {
  RECOVERY_MARKABLE_STEPS,
  RECOVERY_PREPARATION_IDS,
  RECOVERY_REASONS,
  RECOVERY_REASON_STATUS,
  RECOVERY_SKIPPABLE_STEPS,
  RECOVERY_STEP_COUNT,
  RECOVERY_STEP_IDS,
  RECOVERY_STEP_STATUSES,
  recoveryAckKey,
  recoveryAckPayloadSchema,
  recoveryAcksSchema,
  recoveryAuditPayloadSchema,
  recoveryErrorPayloadSchema,
  recoveryProgressOf,
  recoveryStatusSchema,
  recoveryUsersConfigPayloadSchema,
  recoveryUsersListSchema,
  recoveryUsersRunPayloadSchema,
  type RecoveryStatus,
  type RecoveryStep,
} from './recovery.schema.js';

/** Every step to do, in the order the page lists them. */
function steps(): RecoveryStep[] {
  return RECOVERY_STEP_IDS.map((id) => ({ id, status: 'todo', reason: 'toDo' }));
}

/** The status of a sandbox refreshed this morning, nothing done yet. */
function status(): RecoveryStatus {
  return {
    orgId: 'entry-uat',
    alias: 'uat',
    tier: 'development',
    sandboxType: 'Partial',
    myDomainHost: 'acme--uat.sandbox.my.salesforce.com',
    organizationId: '00Dxx0000002AbC',
    refresh: {
      detectedAt: '2026-11-18T08:12:00.000Z',
      evidence: 'connection',
      previousOrganizationId: '00Dxx0000001XyZ',
      organizationId: '00Dxx0000002AbC',
      cachesForgotten: true,
    },
    checkpointBefore: {
      checkpointId: 'ck-20261110-090000-a1b2',
      name: 'Before refresh',
      takenAt: '2026-11-10T09:00:00.000Z',
    },
    steps: steps(),
    beforeNextRefresh: RECOVERY_PREPARATION_IDS.map((id) => ({
      id,
      status: 'todo',
      reason: 'toDo',
    })),
    done: 0,
    total: RECOVERY_STEP_COUNT,
  };
}

/** What a parse refused, each issue after the path it names. */
function refusalsOf(schema: { safeParse(input: unknown): unknown }, input: unknown): string[] {
  const parsed = schema.safeParse(input) as
    | { success: true }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
  );
}

describe('the steps of a recovery', () => {
  it('lists the ten steps in the order the page shows them, and the four kept for the next refresh', () => {
    expect(RECOVERY_STEP_IDS).toEqual([
      'refresh',
      'users',
      'masking',
      'replay',
      'frozen',
      'testersCheckpoint',
      'deliverability',
      'scheduledJobs',
      'endpoints',
      'handoff',
    ]);
    expect(RECOVERY_STEP_COUNT).toBe(10);
    expect(RECOVERY_PREPARATION_IDS).toEqual([
      'beforeRefreshCheckpoint',
      'jobsInventory',
      'testersList',
      'automation',
    ]);
    // The refresh is what the page is about: every other step may be skipped.
    expect(RECOVERY_SKIPPABLE_STEPS).toEqual(RECOVERY_STEP_IDS.filter((id) => id !== 'refresh'));
    // Only the two checks a person makes by eye are marked done by hand.
    expect(RECOVERY_MARKABLE_STEPS).toEqual(['deliverability', 'endpoints']);
  });

  it('gives each reason the one status it explains, and every status a reason', () => {
    expect(Object.keys(RECOVERY_REASON_STATUS).sort()).toEqual([...RECOVERY_REASONS].sort());
    for (const reason of RECOVERY_REASONS) {
      expect(RECOVERY_STEP_STATUSES).toContain(RECOVERY_REASON_STATUS[reason]);
    }
    expect([...new Set(Object.values(RECOVERY_REASON_STATUS))].sort()).toEqual(
      [...RECOVERY_STEP_STATUSES].sort(),
    );
  });
});

describe('recoveryProgressOf', () => {
  it('counts done and skipped steps over the steps that apply', () => {
    const list = steps();
    list[0] = { id: 'refresh', status: 'done', reason: 'refreshDetected' };
    list[1] = { id: 'users', status: 'done', reason: 'ranAfterRefresh' };
    list[2] = { id: 'masking', status: 'notApplicable', reason: 'nothingCopied' };
    list[3] = { id: 'replay', status: 'refused', reason: 'stagingSandbox' };
    list[6] = { id: 'deliverability', status: 'skipped', reason: 'skipped' };

    expect(recoveryProgressOf(list)).toEqual({ done: 3, total: 9 });
  });

  it('counts nothing done of a recovery whose steps all wait', () => {
    expect(recoveryProgressOf(steps())).toEqual({ done: 0, total: 10 });
  });
});

describe('recoveryStatusSchema', () => {
  it('reads the status of a refreshed sandbox', () => {
    expect(refusalsOf(recoveryStatusSchema, status())).toEqual([]);
  });

  it('reads the status of a sandbox no refresh was noticed on, with no fact of a refresh', () => {
    const quiet = status();
    delete quiet.refresh;
    delete quiet.checkpointBefore;
    quiet.steps[0] = { id: 'refresh', status: 'notApplicable', reason: 'noRefreshDetected' };
    quiet.total = 9;
    expect(refusalsOf(recoveryStatusSchema, quiet)).toEqual([]);
  });

  it('refuses a reason that explains another status', () => {
    const wrong = status();
    wrong.steps[3] = { id: 'replay', status: 'todo', reason: 'stagingSandbox' };
    expect(refusalsOf(recoveryStatusSchema, wrong)).toEqual([
      'steps.3.reason: stagingSandbox explains a step refused, not one todo',
    ]);
  });

  it('refuses the steps out of their order, or one missing', () => {
    const swapped = status();
    [swapped.steps[1], swapped.steps[2]] = [swapped.steps[2], swapped.steps[1]];
    expect(refusalsOf(recoveryStatusSchema, swapped)).toEqual([
      'steps: the steps are refresh, users, masking, replay, frozen, testersCheckpoint, ' +
        'deliverability, scheduledJobs, endpoints, handoff, in that order',
    ]);

    const short = status();
    short.steps.pop();
    expect(refusalsOf(recoveryStatusSchema, short)).toContain(
      'steps: the steps are refresh, users, masking, replay, frozen, testersCheckpoint, ' +
        'deliverability, scheduledJobs, endpoints, handoff, in that order',
    );
  });

  it('refuses a count the steps do not add up to', () => {
    const counted = status();
    counted.done = 2;
    expect(refusalsOf(recoveryStatusSchema, counted)).toEqual([
      'done: 2 of 10 counted, where the steps say 0 of 10',
    ]);
  });

  it('never reads a production org: the page and its writes are for sandboxes, scratch orgs and Developer Editions', () => {
    expect(refusalsOf(recoveryStatusSchema, { ...status(), tier: 'production' })).toHaveLength(1);
  });

  it('refuses a key it does not name', () => {
    expect(refusalsOf(recoveryStatusSchema, { ...status(), restored: true })).toHaveLength(1);
  });
});

describe('the acknowledgements a person keeps', () => {
  it('keys them by the entry and the org it was before the refresh', () => {
    expect(recoveryAckKey('entry-uat', '00Dxx0000001XyZ')).toBe(
      'recovery:entry-uat:00Dxx0000001XyZ',
    );
  });

  it('keeps a skip on any step, a mark done on the two checks made by eye, and the end of the recovery', () => {
    expect(
      refusalsOf(recoveryAcksSchema, {
        steps: { masking: 'skipped', deliverability: 'done', endpoints: 'skipped' },
        finishedAt: '2026-11-18T17:00:00.000Z',
      }),
    ).toEqual([]);
    expect(refusalsOf(recoveryAcksSchema, { steps: { users: 'done' } })).toEqual([
      'steps.users: users is deduced from what ran: only deliverability and endpoints are marked done by hand',
    ]);
  });

  it('asks a step skipped, marked done, cleared, or the recovery finished', () => {
    expect(
      refusalsOf(recoveryAckPayloadSchema, {
        orgId: 'entry-uat',
        what: 'step',
        step: 'endpoints',
        mark: 'done',
      }),
    ).toEqual([]);
    expect(refusalsOf(recoveryAckPayloadSchema, { orgId: 'entry-uat', what: 'finish' })).toEqual(
      [],
    );
    expect(
      refusalsOf(recoveryAckPayloadSchema, {
        orgId: 'entry-uat',
        what: 'step',
        step: 'replay',
        mark: 'done',
      }),
    ).toEqual([
      'mark: replay is deduced from what ran: only deliverability and endpoints are marked done by hand',
    ]);
    // The refresh is what the page is about: it is neither skipped nor cleared.
    expect(
      refusalsOf(recoveryAckPayloadSchema, {
        orgId: 'entry-uat',
        what: 'step',
        step: 'refresh',
        mark: 'skipped',
      }),
    ).toHaveLength(1);
  });
});

describe('what the page asks of the users', () => {
  const users = { users: [{ username: 'jane.qa@acme.example.uat', email: 'restore' }] };

  it('asks a simulation and a run with the acceptances given at each run', () => {
    const run = {
      orgId: 'entry-uat',
      config: users,
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: false,
    };
    expect(refusalsOf(recoveryUsersRunPayloadSchema, run)).toEqual([]);
    expect(refusalsOf(recoveryUsersRunPayloadSchema, { ...run, replaces: 3 })).toEqual([]);
    // No acceptance is assumed: a run that does not say is refused.
    expect(
      refusalsOf(recoveryUsersRunPayloadSchema, { ...run, acceptUserEmails: undefined }),
    ).toHaveLength(1);
  });

  it('saves and exports the list in the format sandforge users --config reads', () => {
    expect(
      refusalsOf(recoveryUsersConfigPayloadSchema, { orgId: 'entry-uat', config: users }),
    ).toEqual([]);
    expect(
      refusalsOf(recoveryUsersConfigPayloadSchema, {
        orgId: 'entry-uat',
        config: { users: [{ username: 'jane.qa@acme.example.uat', restored: true }] },
      }),
    ).toHaveLength(1);
  });

  it('lists the users read in the sandbox, with the list kept for it', () => {
    expect(
      refusalsOf(recoveryUsersListSchema, {
        orgId: 'entry-uat',
        users: [
          {
            username: 'jane.qa@acme.example.uat',
            userId: '005xx0000012AbC',
            name: 'Jane QA',
            address: 'invalid',
            active: true,
            frozen: false,
            profile: 'QA Tester',
          },
          {
            username: 'paul.qa@acme.example.uat',
            name: 'Paul QA',
            address: 'awaiting',
            active: false,
            frozen: true,
          },
        ],
        saved: { config: users, savedAt: '2026-11-01T10:00:00.000Z' },
      }),
    ).toEqual([]);
  });
});

describe('what the page asks of the audits', () => {
  it('reads the deliverability, the jobs and the endpoints, with production hosts and fields beside', () => {
    expect(
      refusalsOf(recoveryAuditPayloadSchema, {
        orgId: 'entry-uat',
        asked: {
          deliverability: true,
          schedules: true,
          endpoints: { productionHosts: ['erp.acme.example'], fields: ['Erp__mdt.Url__c'] },
        },
        save: true,
      }),
    ).toEqual([]);
    expect(
      refusalsOf(recoveryAuditPayloadSchema, {
        orgId: 'entry-uat',
        asked: { deliverability: true, schedules: false, endpoints: false },
        save: false,
      }),
    ).toEqual([]);
    expect(
      refusalsOf(recoveryAuditPayloadSchema, {
        orgId: 'entry-uat',
        asked: {
          deliverability: true,
          schedules: true,
          endpoints: { productionHosts: ['https://erp.acme.example/api'], fields: [] },
        },
        save: false,
      }),
    ).toHaveLength(1);
  });
});

describe('recoveryErrorPayloadSchema', () => {
  it('names an error by its code, which the page translates', () => {
    expect(
      refusalsOf(recoveryErrorPayloadSchema, {
        code: 'NOT_A_DEVELOPMENT_ORG',
        message: 'uat is a production org: nothing was read',
        retryable: false,
      }),
    ).toEqual([]);
    expect(
      refusalsOf(recoveryErrorPayloadSchema, {
        code: 'SOMETHING_ELSE',
        message: 'x',
        retryable: false,
      }),
    ).toHaveLength(1);
  });
});
