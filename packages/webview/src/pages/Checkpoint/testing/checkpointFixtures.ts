/**
 * What the Checkpoints page's tests stand in for: the checkpoints a store
 * lists, the scope a take reads, and the extension's side of the bridge —
 * the messages the page posts, and the answers a handler sends back,
 * correlated to them, on the channels of the `checkpoint:*` contract.
 */
import { vi } from 'vitest';
import { OrgSafetyTier } from '@sandforge/shared';
import type {
  BaseMessage,
  CheckpointListEntry,
  CheckpointScopeResponse,
  OrgCheckpoint,
  SalesforceOrg,
} from '@sandforge/shared';

/** `<dialog>`'s modal methods, which jsdom does not implement. */
export function polyfillDialog(): void {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
}

/** A Developer Edition org, as the registry holds it. */
export function developerOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-dev',
    alias: 'DEV-SB',
    username: 'admin@example.com',
    instanceUrl: 'https://example-dev-ed.my.salesforce.com',
    orgId: '00Dxx0000001234AAA',
    orgType: 'Developer',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '66.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-10-22T08:00:00Z',
    tags: [],
    ...overrides,
  };
}

/** A production org of a paid edition. */
export function productionOrg(): SalesforceOrg {
  return developerOrg({
    id: 'org-prod',
    alias: 'PROD',
    orgType: 'Production',
    safetyTier: OrgSafetyTier.CRITICAL,
    metadata: { apiVersion: '66.0', edition: 'Enterprise Edition', features: [] },
  });
}

/** A `checkpoint.json` as a ready take writes it. */
export function readyCheckpoint(overrides: Partial<OrgCheckpoint> = {}): OrgCheckpoint {
  return {
    version: 1,
    checkpointId: 'ck-20261020-140512-a1b2',
    name: 'Before UAT',
    org: {
      organizationId: '00Dxx0000001234AAA',
      alias: 'DEV-SB',
      username: 'admin@example.com',
      instanceUrl: 'https://example-dev-ed.my.salesforce.com',
      isSandbox: false,
      organizationType: 'Developer Edition',
      tier: 'developer',
    },
    takenBy: { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: true },
    readFrom: '2026-10-20T14:05:12.000Z',
    takenAt: '2026-10-20T14:06:03.000Z',
    scope: { mode: 'everything', leftOut: [] },
    objects: [
      {
        objectApiName: 'Account',
        records: 400,
        inBin: 2,
        readOrder: 1,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        fingerprint: 'a'.repeat(64),
        fields: ['Id', 'Name'],
        leftOutFields: [],
      },
      {
        objectApiName: 'Contact',
        records: 2012,
        inBin: 0,
        readOrder: 0,
        readMode: 'query',
        undeletable: true,
        cascadeParents: ['AccountId'],
        fingerprint: 'b'.repeat(64),
        fields: ['Id', 'LastName', 'AccountId'],
        leftOutFields: [],
      },
      {
        objectApiName: 'Campaign',
        records: 0,
        inBin: 0,
        readOrder: 2,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        fingerprint: 'c'.repeat(64),
        fields: ['Id', 'Name'],
        leftOutFields: [],
      },
    ],
    ignoredFields: [],
    snapshotId: 'op-1',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 2_400_000,
    expiresAt: '2026-11-19T12:00:00.000Z',
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
    ...overrides,
  };
}

/**
 * A checkpoint as the list shows it: usable, unless `overrides` says
 * otherwise. `null` lists one whose file does not parse.
 */
export function listEntry(
  checkpoint: OrgCheckpoint | null = readyCheckpoint(),
  overrides: Partial<CheckpointListEntry> = {},
): CheckpointListEntry {
  return {
    checkpointId: checkpoint?.checkpointId ?? 'ck-20261019-090000-dead',
    organizationId: '00Dxx0000001234AAA',
    ...(checkpoint ? { checkpoint } : {}),
    valid: true,
    ...overrides,
  };
}

/** What `checkpoint:scope` answers for an org of a few objects, one of a package. */
export function scopeAnswer(
  overrides: Partial<CheckpointScopeResponse['payload']> = {},
): CheckpointScopeResponse['payload'] {
  return {
    orgId: 'org-dev',
    mode: 'everything',
    objects: [
      {
        objectApiName: 'Account',
        label: 'Account',
        records: 400,
        undeletable: true,
        leftOutFields: [],
      },
      {
        objectApiName: 'Contact',
        label: 'Contact',
        records: 2012,
        undeletable: true,
        leftOutFields: [
          { field: 'SSN__c', reason: 'encrypted' },
          { field: 'Salary__c', reason: 'fls' },
          { field: 'Bonus__c', reason: 'fls' },
        ],
      },
      {
        objectApiName: 'OpportunityLineItem',
        label: 'Opportunity Product',
        records: 12,
        undeletable: false,
        leftOutFields: [],
      },
      {
        objectApiName: 'Campaign',
        label: 'Campaign',
        records: 0,
        undeletable: true,
        leftOutFields: [],
      },
      {
        objectApiName: 'vlocity_cmt__Party__c',
        label: 'Party',
        namespace: 'vlocity_cmt',
        records: 0,
        undeletable: true,
        leftOutFields: [],
      },
    ],
    leftOut: [{ objectApiName: 'FeedItem', reason: 'Chatter posts are left out.' }],
    estimate: {
      records: 2424,
      apiRequests: 250,
      apiRequestsLeft: 14_997,
      seconds: 64,
      bytes: 2_400_000,
    },
    ...overrides,
  };
}

/**
 * The extension's side of the bridge: what the page posts through the VS Code
 * API, unwrapped from its envelope, and answers sent the way a handler sends
 * them, correlated to the request they answer.
 */
export interface FakeHost {
  /** The VS Code API the page posts through. */
  api: {
    postMessage: (message: unknown) => void;
    getState: () => undefined;
    setState: () => undefined;
  };
  /** Every request posted so far, of `type` when given, oldest first. */
  sent: (type?: string) => BaseMessage[];
  /** The payload of the last request of `type`. */
  lastPayload: (type: string) => Record<string, unknown> | undefined;
  /** Answer the last request of `type` on `answerType`. */
  answer: (type: string, answerType: string, payload: unknown) => void;
  /** Answer the last request of `type` on the domain's error channel. */
  fail: (type: string, error: { message: string; code: string; retryable?: boolean }) => void;
  /** Send a message no request asked for: progress, a broadcast. */
  push: (type: string, payload: unknown) => void;
  /** Forget what was posted. */
  reset: () => void;
}

/** A fresh {@link FakeHost}. */
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
      dispatch('checkpoint:error', { retryable: false, ...error }, last(type).id),
    push: (type, payload) => dispatch(type, payload),
    reset: () => posted.mockClear(),
  };
}
