import {
  RECOVERY_PREPARATION_IDS,
  RECOVERY_REASON_STATUS,
  RECOVERY_STEP_IDS,
  envAuditResultSchema,
  recoveryProgressOf,
  recoveryStatusSchema,
  recoveryUsersListSchema,
  usersApplyAnswerSchema,
  usersPlanAnswerSchema,
} from '@sandforge/shared';
import type {
  EnvAuditResult,
  RecoveryReason,
  RecoveryStatus,
  RecoveryStepId,
  RecoveryUsersList,
  UsersApplyAnswer,
  UsersPlanAnswer,
} from '@sandforge/shared';
import { DEV_SANDBOX } from './mock-orgs';

/**
 * What the extension answers the Back into service page with, for the specs
 * that draw it in Chromium: the status of the dev sandbox after its refresh,
 * the users it lists to bring back, a simulation and a run of them, and the
 * audits. Each is parsed by the `recovery:*` contract's schema, so a spec
 * draws only a state the extension can send.
 */

/** The sandbox the page brings back into service: the first org the specs connect. */
export const RECOVERY_ORG = DEV_SANDBOX;

const DAY = 86_400_000;

/** The instant `days` from now, as the stores write it. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString();
}

/**
 * The status of the dev sandbox refreshed this morning: the refresh noticed,
 * each other step to do unless `steps` says otherwise.
 */
export function refreshedStatus(
  overrides: Partial<Omit<RecoveryStatus, 'steps' | 'done' | 'total'>> = {},
  steps: Partial<Record<RecoveryStepId, RecoveryReason>> = {},
): RecoveryStatus {
  const listed = RECOVERY_STEP_IDS.map((id) => {
    const reason = steps[id] ?? (id === 'refresh' ? 'refreshDetected' : 'toDo');
    return { id, status: RECOVERY_REASON_STATUS[reason], reason };
  });
  return recoveryStatusSchema.parse({
    orgId: RECOVERY_ORG.id,
    alias: RECOVERY_ORG.alias,
    tier: 'development',
    sandboxType: 'Partial',
    myDomainHost: 'example--dev.sandbox.my.salesforce.com',
    organizationId: '00Dxx0000002AbC',
    refresh: {
      detectedAt: daysFromNow(-0.1),
      evidence: 'connection',
      previousOrganizationId: '00Dxx0000001XyZ',
      organizationId: '00Dxx0000002AbC',
      cachesForgotten: true,
    },
    checkpointBefore: {
      checkpointId: 'ck-20261110-090000-a1b2',
      name: 'Before refresh',
      takenAt: daysFromNow(-8),
    },
    frozenManifest: { frozenAt: daysFromNow(-17), objects: 4, records: 1250 },
    inventoryBefore: {
      savedAt: daysFromNow(-8),
      organizationId: '00Dxx0000001XyZ',
      jobs: 6,
    },
    beforeNextRefresh: RECOVERY_PREPARATION_IDS.map((id) => ({
      id,
      status: 'todo',
      reason: 'toDo',
    })),
    ...overrides,
    steps: listed,
    ...recoveryProgressOf(listed),
  });
}

/** The status of the dev sandbox no refresh of which was noticed. */
export function unrefreshedStatus(): RecoveryStatus {
  const status: Partial<RecoveryStatus> = refreshedStatus(
    {},
    { refresh: 'noRefreshDetected', replay: 'noCheckpointBefore' },
  );
  delete status.refresh;
  delete status.checkpointBefore;
  return recoveryStatusSchema.parse(status);
}

export const ANA = 'ana.tester@example.com.dev';
export const BO = 'bo.qa@example.com.dev';

/** The users the sandbox lists to bring back. */
export function usersList(): RecoveryUsersList {
  return recoveryUsersListSchema.parse({
    orgId: RECOVERY_ORG.id,
    users: [
      {
        username: ANA,
        userId: '005xx0000010001AAA',
        address: 'invalid',
        active: true,
        frozen: false,
        profile: 'Standard User',
      },
      {
        username: BO,
        userId: '005xx0000010002AAA',
        address: 'invalid',
        active: false,
        frozen: true,
      },
    ],
  });
}

const ORG = {
  organizationId: '00Dxx0000002AbC',
  kind: 'sandbox',
  alias: RECOVERY_ORG.alias,
  username: 'admin@example.com.dev',
} as const;

/** What a simulation of Ana answers: her address asked back, an email to her to accept. */
export function planOfAna(): UsersPlanAnswer {
  return usersPlanAnswerSchema.parse({
    org: ORG,
    users: [
      {
        username: ANA,
        userId: '005xx0000010001AAA',
        address: 'invalid',
        changes: [{ what: 'email', to: 'awaiting' }],
        emailsToPeople: 1,
      },
    ],
    emailsToPeople: 1,
    apiRequests: 3,
    refusals: [{ code: 'USERS_EMAILS_NOT_ACCEPTED', message: 'Salesforce would email 1 person' }],
  });
}

/** What the run of Ana answers: her address asked back, awaiting her click. */
export function appliedAna(): UsersApplyAnswer {
  return usersApplyAnswerSchema.parse({
    org: ORG,
    run: 1,
    status: 'success',
    users: [
      {
        username: ANA,
        userId: '005xx0000010001AAA',
        before: { isActive: true, isFrozen: false, profileId: '00exx0000000001AAA' },
        done: [{ what: 'email', to: 'awaiting' }],
        created: { permissionSetAssignments: [], groupMembers: [] },
        address: 'awaiting',
      },
    ],
    emailsToPeople: 1,
    apiRequests: 4,
  });
}

/** What the audits read of the sandbox: email open, a job gone, an endpoint of production. */
export function auditOf(): EnvAuditResult {
  return envAuditResultSchema.parse({
    org: {
      organizationId: '00Dxx0000002AbC',
      kind: 'sandbox',
      alias: RECOVERY_ORG.alias,
      host: 'example--dev.sandbox.my.salesforce.com',
    },
    at: daysFromNow(0),
    apiRequests: 3,
    deliverability: { read: 'open' },
    schedules: {
      now: 5,
      against: { savedAt: daysFromNow(-8), organizationId: '00Dxx0000001XyZ', refreshed: true },
      jobs: [
        { status: 'gone', name: 'Nightly rollup', type: 'Scheduled Apex' },
        { status: 'frozen', name: 'Weekly digest', type: 'Scheduled Apex', owner: BO },
      ],
      kept: 4,
    },
    endpoints: {
      productionHosts: ['example.my.salesforce.com', 'login.salesforce.com'],
      found: [
        {
          source: 'namedCredential',
          name: 'ERP',
          url: 'https://example.my.salesforce.com/services',
          host: 'example.my.salesforce.com',
          why: 'myDomain',
        },
        {
          source: 'remoteSite',
          name: 'Billing',
          url: 'https://billing.example.com',
          host: 'billing.example.com',
          why: 'listed',
        },
      ],
    },
    findings: 4,
  });
}
