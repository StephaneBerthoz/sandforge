import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgSafetyTier } from '@sandforge/shared';
import type { RecoveryStatus, SalesforceOrg } from '@sandforge/shared';

import { useRecoveryLeads } from './useRecoveryLeads';

/** Each request the hook posts, with the id the bridge gives it. */
const sent: Array<{ id: string; type: string; payload: unknown }> = [];
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload: unknown) => {
    const id = `req-${sent.length + 1}`;
    sent.push({ id, type, payload });
    return id;
  },
}));

function org(id: string, orgType: SalesforceOrg['orgType']): SalesforceOrg {
  return {
    id,
    alias: id.toUpperCase(),
    username: `${id}@acme.test`,
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: '00Dxx0000001XyZ',
    orgType,
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: '', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-11-18T08:00:00.000Z',
    tags: [],
  };
}

/** A sandbox refreshed and three steps on: users and masking to do, the replay refused. */
function status(orgId: string, overrides: Partial<RecoveryStatus> = {}): RecoveryStatus {
  const step = (
    id: RecoveryStatus['steps'][number]['id'],
    stepStatus: RecoveryStatus['steps'][number]['status'],
    reason: RecoveryStatus['steps'][number]['reason'],
  ) => ({ id, status: stepStatus, reason });
  return {
    orgId,
    alias: orgId.toUpperCase(),
    tier: 'development',
    refresh: {
      detectedAt: '2026-11-17T09:00:00.000Z',
      evidence: 'connection',
      cachesForgotten: true,
    },
    steps: [
      step('refresh', 'done', 'refreshDetected'),
      step('users', 'done', 'ranAfterRefresh'),
      step('masking', 'skipped', 'skipped'),
      step('replay', 'refused', 'stagingSandbox'),
      step('frozen', 'notApplicable', 'noManifest'),
      step('testersCheckpoint', 'todo', 'toDo'),
      step('deliverability', 'todo', 'toDo'),
      step('scheduledJobs', 'notApplicable', 'noInventoryBefore'),
      step('endpoints', 'todo', 'toDo'),
      step('handoff', 'todo', 'toDo'),
    ],
    beforeNextRefresh: [],
    done: 3,
    total: 8,
    ...overrides,
  };
}

/** The extension answering request `id`, as it posts to the panel. */
function answer(id: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'recovery:status:response', id: `answer-${id}`, correlationId: id, payload },
      }),
    );
  });
}

describe('useRecoveryLeads', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('asks where each registered sandbox stands, and no other kind of org', () => {
    renderHook(() =>
      useRecoveryLeads([org('uat', 'Sandbox'), org('prod', 'Production'), org('qa', 'Sandbox')]),
    );
    expect(sent).toEqual([
      { id: 'req-1', type: 'recovery:status', payload: { orgId: 'qa' } },
      { id: 'req-2', type: 'recovery:status', payload: { orgId: 'uat' } },
    ]);
  });

  it('asks nothing before the org list is in, nor of an org list without a sandbox', () => {
    const { rerender } = renderHook(({ orgs }) => useRecoveryLeads(orgs), {
      initialProps: { orgs: undefined as SalesforceOrg[] | undefined },
    });
    rerender({ orgs: [org('dev', 'Developer'), org('prod', 'Production')] });
    expect(sent).toEqual([]);
  });

  it('asks again only when the sandboxes registered change', () => {
    const { rerender } = renderHook(({ orgs }) => useRecoveryLeads(orgs), {
      initialProps: { orgs: [org('uat', 'Sandbox')] },
    });
    rerender({ orgs: [org('uat', 'Sandbox'), org('prod', 'Production')] });
    expect(sent).toHaveLength(1);
    rerender({ orgs: [org('uat', 'Sandbox'), org('qa', 'Sandbox')] });
    expect(sent.map((request) => request.payload)).toEqual([
      { orgId: 'uat' },
      { orgId: 'qa' },
      { orgId: 'uat' },
    ]);
  });

  it('gives the hero the refreshed sandbox, n of N steps, and the step it is at', () => {
    const { result } = renderHook(() => useRecoveryLeads([org('uat', 'Sandbox')]));
    answer('req-1', { status: status('uat') });

    expect(result.current.afterRefresh).toEqual([
      { orgId: 'uat', alias: 'UAT', detectedAt: '2026-11-17T09:00:00.000Z', done: 3, total: 8 },
    ]);
    // The first step still to do, though a refused one comes before it.
    expect(result.current.nextStepOf('uat')).toBe('testersCheckpoint');
  });

  it('says the refused step is next once nothing is left to do but it', () => {
    const { result } = renderHook(() => useRecoveryLeads([org('uat', 'Sandbox')]));
    const settled = status('uat').steps.map((step) =>
      step.status === 'todo'
        ? { ...step, status: 'done' as const, reason: 'markedDone' as const }
        : step,
    );
    answer('req-1', { status: status('uat', { steps: settled, done: 7, total: 8 }) });
    expect(result.current.nextStepOf('uat')).toBe('replay');
  });

  it('leads with no sandbox whose refresh was not noticed', () => {
    const { result } = renderHook(() => useRecoveryLeads([org('uat', 'Sandbox')]));
    answer('req-1', { status: status('uat', { refresh: undefined }) });
    expect(result.current.afterRefresh).toEqual([]);
  });

  it('reads no answer to a request it did not send, nor one without a status', () => {
    const { result } = renderHook(() => useRecoveryLeads([org('uat', 'Sandbox')]));
    answer('another-panel', { status: status('uat') });
    answer('req-1', { error: 'refused' });
    expect(result.current.afterRefresh).toEqual([]);
    expect(result.current.nextStepOf('uat')).toBeUndefined();
  });

  it('forgets a sandbox no longer registered', () => {
    const { result, rerender } = renderHook(({ orgs }) => useRecoveryLeads(orgs), {
      initialProps: { orgs: [org('uat', 'Sandbox')] },
    });
    answer('req-1', { status: status('uat') });
    rerender({ orgs: [org('qa', 'Sandbox')] });
    expect(result.current.afterRefresh).toEqual([]);
  });
});
