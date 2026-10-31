import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BaseMessage, SeedAutomationPreview } from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { refusedForEmails, seedMutePlanOf, useSeedAutomation } from './useSeedAutomation';

/** Every message of `type` the hook sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last `seed:automation` the hook sent, correlated to it as the extension does. */
function answer(type: string, payload: unknown): void {
  const request = sentAll('seed:automation').pop();
  if (!request) throw new Error("no 'seed:automation' was sent");
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${Math.random()}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

/** A Developer Edition whose contacts each make it send three single emails, fifteen left today. */
const PREVIEW: SeedAutomationPreview = {
  org: 'my-dev-org',
  objectsRead: ['Account', 'Contact'],
  objects: [],
  emailsPerRecord: [
    { objectApiName: 'Contact', limit: 'SingleEmail', perRecord: 3, sentBy: ['Welcome Email'] },
  ],
  limits: { SingleEmail: { max: 15, remaining: 15 } },
  alertsAsSingle: true,
  bypasses: [],
  bypassesHeld: [],
  unread: [],
  blinded: false,
  conditionsNotRead: 0,
};

describe('useSeedAutomation', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('asks what the org runs on the objects once, and answers with what was read', () => {
    const { result, rerender } = renderHook(
      ({ orgId, objects }) => useSeedAutomation(orgId, objects),
      { initialProps: { orgId: 'org-1', objects: ['Account', 'Contact'] } },
    );
    expect(sentAll('seed:automation').map((m) => m.payload)).toEqual([
      { orgId: 'org-1', objects: ['Account', 'Contact'] },
    ]);
    expect(result.current.loading).toBe(true);
    expect(result.current.preview).toBeNull();

    answer('seed:automation:response', {
      orgId: 'org-1',
      objects: ['Account', 'Contact'],
      preview: PREVIEW,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.preview).toEqual(PREVIEW);

    // The same objects again, in a new array: nothing is asked again.
    rerender({ orgId: 'org-1', objects: ['Account', 'Contact'] });
    expect(sentAll('seed:automation')).toHaveLength(1);
  });

  it('asks nothing without an org or an object', () => {
    renderHook(() => useSeedAutomation('', ['Contact']));
    renderHook(() => useSeedAutomation('org-1', []));
    expect(sentAll('seed:automation')).toEqual([]);
  });

  it('asks again for another org, and shows no answer of the one before for it', () => {
    const { result, rerender } = renderHook(({ orgId }) => useSeedAutomation(orgId, ['Contact']), {
      initialProps: { orgId: 'org-1' },
    });
    answer('seed:automation:response', { orgId: 'org-1', objects: ['Contact'], preview: PREVIEW });
    expect(result.current.preview).toEqual(PREVIEW);

    rerender({ orgId: 'org-2' });
    expect(sentAll('seed:automation').map((m) => m.payload.orgId)).toEqual(['org-1', 'org-2']);
    expect(result.current.preview).toBeNull();
  });

  it('keeps what it read while the same org and objects are read again, until the new answer', () => {
    // Blanked as the read went, the notice dropped what it said and its Read
    // again button with it.
    const { result } = renderHook(() => useSeedAutomation('org-1', ['Contact']));
    answer('seed:automation:response', { orgId: 'org-1', objects: ['Contact'], preview: PREVIEW });

    act(() => result.current.readAgain());
    expect(result.current.loading).toBe(true);
    expect(result.current.preview).toEqual(PREVIEW);

    const held = { ...PREVIEW, bypassesHeld: ['Automation_Bypass'] };
    answer('seed:automation:response', { orgId: 'org-1', objects: ['Contact'], preview: held });
    expect(result.current.loading).toBe(false);
    expect(result.current.preview).toEqual(held);
  });

  it('says why the read could not run, and reads again when asked', () => {
    const { result } = renderHook(() => useSeedAutomation('org-1', ['Contact']));
    answer('seed:automation:error', {
      message: 'INVALID_SESSION_ID',
      code: 'UNKNOWN',
      retryable: true,
    });
    expect(result.current.error).toContain('INVALID_SESSION_ID');
    expect(result.current.preview).toBeNull();

    act(() => result.current.readAgain());
    expect(sentAll('seed:automation')).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });
});

describe('refusedForEmails', () => {
  it('holds back a seed past the emails left today, as the read counts them, and nothing unread', () => {
    expect(refusedForEmails({ preview: PREVIEW }, { Account: 25, Contact: 6 })).toBe(true);
    expect(refusedForEmails({ preview: PREVIEW }, { Account: 25, Contact: 5 })).toBe(false);
    expect(refusedForEmails({ preview: null }, { Contact: 75 })).toBe(false);
  });
});

describe('seedMutePlanOf', () => {
  /** An entry of the preview, a flow after the save unless told. */
  const entry = (
    over: Partial<SeedAutomationPreview['objects'][number]['entries'][number]>,
  ): SeedAutomationPreview['objects'][number]['entries'][number] => ({
    kind: 'flow',
    name: 'Welcome',
    when: 'after',
    emails: 0,
    messages: [],
    creates: [],
    afterCommit: false,
    bypasses: [],
    keptQuiet: false,
    unread: false,
    ...over,
  });
  const preview = (
    entries: SeedAutomationPreview['objects'][number]['entries'],
    bypasses: SeedAutomationPreview['bypasses'],
  ): SeedAutomationPreview => ({
    org: 'dev',
    objectsRead: ['Contact'],
    objects: [{ objectApiName: 'Contact', entries }],
    emailsPerRecord: [],
    alertsAsSingle: false,
    bypasses,
    bypassesHeld: [],
    unread: [],
    blinded: false,
    conditionsNotRead: 0,
  });

  it('silences what a bypass the user lacks keeps quiet through the set that holds it, each set once', () => {
    const plan = seedMutePlanOf(
      preview(
        [
          entry({ name: 'Welcome', bypasses: [{ name: 'Skip_Flows', held: false }] }),
          entry({
            kind: 'workflowRule',
            name: 'Notify',
            bypasses: [{ name: 'skip_flows', held: false }],
          }),
          entry({
            kind: 'process',
            name: 'Escalate',
            bypasses: [{ name: 'Skip_PB', held: false }],
          }),
        ],
        [
          { permission: 'Skip_Flows', permissionSet: 'Automation_Bypass' },
          { permission: 'Skip_PB', permissionSet: 'Automation_Bypass' },
        ],
      ),
    );

    expect(plan.assign).toEqual([
      {
        permissionSet: 'Automation_Bypass',
        label: 'Automation_Bypass',
        permissions: ['Skip_Flows', 'Skip_PB'],
      },
    ]);
    expect(plan.silenced.map((silenced) => [silenced.name, silenced.permission])).toEqual([
      ['Welcome', 'Skip_Flows'],
      ['Notify', 'skip_flows'],
      ['Escalate', 'Skip_PB'],
    ]);
    expect(plan.stillRuns).toEqual([]);
  });

  it('leaves running a trigger, what no set holds the bypass of, what was not read, and what tests none', () => {
    const plan = seedMutePlanOf(
      preview(
        [
          entry({ kind: 'trigger', name: 'ContactTrigger', bypasses: [{ name: 'Skip_Flows' }] }),
          entry({ name: 'Orphan', bypasses: [{ name: 'No_Set', held: false }] }),
          entry({ name: 'Unread', unread: true }),
          entry({ name: 'Plain' }),
          // Quiet already for the user: in neither list.
          entry({ name: 'Quiet', keptQuiet: true, bypasses: [{ name: 'Skip_Flows', held: true }] }),
        ],
        [
          { permission: 'Skip_Flows', permissionSet: 'Automation_Bypass' },
          { permission: 'No_Set' },
        ],
      ),
    );

    expect(plan.assign).toEqual([]);
    expect(plan.silenced).toEqual([]);
    expect(plan.stillRuns.map((still) => [still.name, still.why])).toEqual([
      ['ContactTrigger', 'noBypass'],
      ['Orphan', 'noPermissionSet'],
      ['Unread', 'notRead'],
      ['Plain', 'noBypass'],
    ]);
  });
});
