import { vi } from 'vitest';
import {
  OrgSafetyTier,
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
  BaseMessage,
  EnvAuditResult,
  RecoveryReason,
  RecoveryStatus,
  RecoveryStepId,
  RecoveryUser,
  RecoveryUsersList,
  SalesforceOrg,
  UsersApplyAnswer,
  UsersPlanAnswer,
} from '@sandforge/shared';

/*
 * What the extension answers the Back into service page with, for its tests:
 * each fixture is parsed by the contract's schema, so a test draws only a
 * state the extension can send.
 */

/** The sandbox the page brings back into service, as the registry holds it. */
export function uatOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-uat',
    alias: 'UAT',
    username: 'admin@example.com.uat',
    instanceUrl: 'https://example--uat.sandbox.my.salesforce.com',
    orgId: '00Dxx0000001XyZ',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: '', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-11-18T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

/** A production org, which the page refuses before it asks anything. */
export function productionOrg(): SalesforceOrg {
  return uatOrg({
    id: 'org-prod',
    alias: 'PROD',
    instanceUrl: 'https://example.my.salesforce.com',
    orgType: 'Production',
    safetyTier: OrgSafetyTier.HIGH,
  });
}

/** One step's status and the reason of it, the status the reason explains. */
export type StepState = { reason: RecoveryReason; at?: string };

/**
 * The status of the sandbox refreshed this morning: the refresh noticed, every
 * other step to do unless `steps` says otherwise, the checkpoint of before
 * and the inventory of the jobs kept. n of N counted as the contract counts.
 */
export function refreshedStatus(
  overrides: Partial<Omit<RecoveryStatus, 'steps' | 'done' | 'total'>> = {},
  steps: Partial<Record<RecoveryStepId, StepState>> = {},
): RecoveryStatus {
  const listed = RECOVERY_STEP_IDS.map((id) => {
    const state: StepState =
      steps[id] ?? (id === 'refresh' ? { reason: 'refreshDetected' } : { reason: 'toDo' });
    return {
      id,
      status: RECOVERY_REASON_STATUS[state.reason],
      reason: state.reason,
      ...(state.at ? { at: state.at } : {}),
    };
  });
  const { done, total } = recoveryProgressOf(listed);
  return recoveryStatusSchema.parse({
    orgId: 'org-uat',
    alias: 'UAT',
    tier: 'development',
    sandboxType: 'Partial',
    myDomainHost: 'example--uat.sandbox.my.salesforce.com',
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
    frozenManifest: {
      frozenAt: '2026-11-01T10:00:00.000Z',
      objects: 4,
      records: 1250,
    },
    inventoryBefore: {
      savedAt: '2026-11-10T09:05:00.000Z',
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
    done,
    total,
  });
}

/** The status of a sandbox no refresh of which was noticed: the page opens on it all the same. */
export function unrefreshedStatus(): RecoveryStatus {
  const status: Partial<RecoveryStatus> = refreshedStatus(
    {},
    {
      refresh: { reason: 'noRefreshDetected' },
      replay: { reason: 'noCheckpointBefore' },
    },
  );
  delete status.refresh;
  delete status.checkpointBefore;
  return recoveryStatusSchema.parse(status);
}

/** The users the sandbox lists to bring back: one under `.invalid`, one inactive and frozen. */
export function usersList(overrides: Partial<RecoveryUsersList> = {}): RecoveryUsersList {
  const users: RecoveryUser[] = [
    {
      username: 'ana.tester@example.com.uat',
      userId: '005xx0000010001AAA',
      address: 'invalid',
      active: true,
      frozen: false,
      profile: 'Standard User',
    },
    {
      username: 'bo.qa@example.com.uat',
      userId: '005xx0000010002AAA',
      address: 'invalid',
      active: false,
      frozen: true,
    },
  ];
  return recoveryUsersListSchema.parse({ orgId: 'org-uat', users, ...overrides });
}

/** What a simulation of Ana alone answers: her address asked back, one email to her. */
export function planOfAna(overrides: Partial<UsersPlanAnswer> = {}): UsersPlanAnswer {
  return usersPlanAnswerSchema.parse({
    org: {
      organizationId: '00Dxx0000002AbC',
      kind: 'sandbox',
      alias: 'UAT',
      username: 'admin@example.com.uat',
    },
    users: [
      {
        username: 'ana.tester@example.com.uat',
        userId: '005xx0000010001AAA',
        address: 'invalid',
        changes: [{ what: 'email', to: 'awaiting' }],
        emailsToPeople: 1,
      },
    ],
    emailsToPeople: 1,
    apiRequests: 3,
    refusals: [
      {
        code: 'USERS_EMAILS_NOT_ACCEPTED',
        message: 'Salesforce would email 1 person: the confirmation of each address asked back',
      },
    ],
    ...overrides,
  });
}

/** What the run of Ana answers: her address asked back, awaiting her click. */
export function appliedAna(overrides: Partial<UsersApplyAnswer> = {}): UsersApplyAnswer {
  return usersApplyAnswerSchema.parse({
    org: {
      organizationId: '00Dxx0000002AbC',
      kind: 'sandbox',
      alias: 'UAT',
      username: 'admin@example.com.uat',
    },
    run: 1,
    status: 'success',
    users: [
      {
        username: 'ana.tester@example.com.uat',
        userId: '005xx0000010001AAA',
        before: { isActive: true, isFrozen: false, profileId: '00exx0000000001AAA' },
        done: [{ what: 'email', to: 'awaiting' }],
        created: { permissionSetAssignments: [], groupMembers: [] },
        address: 'awaiting',
      },
    ],
    emailsToPeople: 1,
    apiRequests: 4,
    ...overrides,
  });
}

/** What the audits answer of the sandbox: the deliverability open, a job gone, an endpoint of production. */
export function auditOf(overrides: Partial<EnvAuditResult> = {}): EnvAuditResult {
  return envAuditResultSchema.parse({
    org: {
      organizationId: '00Dxx0000002AbC',
      kind: 'sandbox',
      alias: 'UAT',
      host: 'example--uat.sandbox.my.salesforce.com',
    },
    at: '2026-11-18T09:00:00.000Z',
    apiRequests: 3,
    deliverability: { read: 'open' },
    schedules: {
      now: 5,
      against: {
        savedAt: '2026-11-10T09:05:00.000Z',
        organizationId: '00Dxx0000001XyZ',
        refreshed: true,
      },
      jobs: [{ status: 'gone', name: 'Nightly rollup', type: 'Scheduled Apex' }],
      kept: 5,
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
      ],
    },
    findings: 3,
    ...overrides,
  });
}

/** The extension's side of the bridge, as a test plays it: what the page sent, and the answers. */
export interface FakeHost {
  api: { postMessage: (message: unknown) => void; getState: () => unknown; setState: () => void };
  sent: (type?: string) => BaseMessage[];
  lastPayload: (type: string) => Record<string, unknown> | undefined;
  answer: (type: string, answerType: string, payload: unknown) => void;
  fail: (type: string, error: { code: string; message: string; retryable?: boolean }) => void;
  push: (type: string, payload: unknown, correlationId?: string) => void;
}

/** A host that records each message the page posts and answers on request. */
export function fakeHost(): FakeHost {
  const posted = vi.fn();
  const requests = (): BaseMessage[] =>
    posted.mock.calls.map((call) => (call[0] as { payload: BaseMessage }).payload);
  const sent = (type?: string): BaseMessage[] =>
    requests().filter((message) => type === undefined || message.type === type);
  const last = (type: string): BaseMessage => {
    const all = sent(type);
    const message = all[all.length - 1];
    if (!message) throw new Error(`The page sent no ${type}`);
    return message;
  };
  const dispatch = (type: string, payload: unknown, correlationId?: string): void => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `host-${type}-${Date.now()}`,
          type,
          timestamp: Date.now(),
          payload,
          correlationId,
        },
      }),
    );
  };
  return {
    api: {
      postMessage: (message: unknown) => posted(message),
      getState: () => undefined,
      setState: () => undefined,
    },
    sent,
    lastPayload: (type) =>
      (last(type) as BaseMessage & { payload?: Record<string, unknown> }).payload,
    answer: (type, answerType, payload) => dispatch(answerType, payload, last(type).id),
    fail: (type, error) =>
      dispatch('recovery:error', { retryable: false, ...error }, last(type).id),
    push: (type, payload, correlationId) => dispatch(type, payload, correlationId),
  };
}
