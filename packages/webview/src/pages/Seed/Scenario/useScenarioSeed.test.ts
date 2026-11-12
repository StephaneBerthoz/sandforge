import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage, SalesforceOrg, SeedScenarioPreparation } from '@sandforge/shared';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useScenarioSeed } from './useScenarioSeed';
import { useOrgStore } from '../../../stores/useOrgStore';

function sent(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function deliver(type: string, payload: unknown, correlationId?: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `m-${Math.random()}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

const DEV = {
  id: 'org-dev',
  alias: 'DEV',
  orgType: 'Scratch',
  status: 'connected',
} as unknown as SalesforceOrg;
const PROD = {
  id: 'org-prod',
  alias: 'PROD',
  orgType: 'Production',
  status: 'connected',
} as unknown as SalesforceOrg;

const PREPARATION: SeedScenarioPreparation = {
  options: { seed: 1, caseStatus: { open: 'New', closed: 'Closed' } },
  objects: [{ objectApiName: 'Account', recordCount: 10 }],
  tests: 14,
  caseStatusFrom: { from: 'org' },
  knowledge: { available: true, bodyFields: [] },
};

describe('useScenarioSeed', () => {
  beforeEach(() => mockPostMessage.mockClear());

  it('aims at the org selected in the panel unless it is a production org', () => {
    useOrgStore.setState({ orgs: [DEV, PROD], selectedOrgId: 'org-prod' });
    const picked = { pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' as const } };
    expect(renderHook(() => useScenarioSeed(picked)).result.current.orgId).toBe('');

    useOrgStore.setState({ selectedOrgId: 'org-dev' });
    expect(renderHook(() => useScenarioSeed(picked)).result.current.orgId).toBe('org-dev');
  });

  it('reads the org again for each seed asked, and seeds with the last read', () => {
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: 'org-dev' });
    const { result } = renderHook(() =>
      useScenarioSeed({ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }),
    );
    act(() => result.current.toConfirm());
    act(() => result.current.setSeed(7));

    expect(sent('seed:scenario:prepare').map((m) => m.payload.seed)).toEqual([1, 7]);
    const last = sent('seed:scenario:prepare').pop();
    deliver(
      'seed:scenario:prepare:response',
      { preparation: { ...PREPARATION, options: { ...PREPARATION.options, seed: 7 } } },
      last?.id,
    );
    act(() => result.current.execute());

    expect(sent('seed:scenario:execute')[0]?.payload.options).toEqual({
      seed: 7,
      caseStatus: { open: 'New', closed: 'Closed' },
    });
  });

  it('asks the run to mute and to take a checkpoint first only once their boxes are ticked', () => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: 'org-dev' });
    const { result } = renderHook(() =>
      useScenarioSeed({ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }),
    );
    act(() => result.current.toConfirm());
    deliver(
      'seed:scenario:prepare:response',
      { preparation: PREPARATION },
      sent('seed:scenario:prepare').pop()?.id,
    );
    act(() => result.current.execute());
    expect(sent('seed:scenario:execute')[0]?.payload).not.toHaveProperty('checkpointFirst');
    expect(sent('seed:scenario:execute')[0]?.payload).not.toHaveProperty('muteAutomation');

    act(() => {
      result.current.setMuteAutomation(true);
      result.current.setCheckpointFirst(true);
    });
    act(() => result.current.execute());
    expect(sent('seed:scenario:execute')[1]?.payload).toMatchObject({
      muteAutomation: true,
      checkpointFirst: {},
    });
  });

  it('goes back from a refusal to the confirmation, its boxes as they were set', () => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: 'org-dev' });
    const { result } = renderHook(() =>
      useScenarioSeed({ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }),
    );
    act(() => result.current.toConfirm());
    deliver(
      'seed:scenario:prepare:response',
      { preparation: PREPARATION },
      sent('seed:scenario:prepare').pop()?.id,
    );
    act(() => result.current.setCheckpointFirst(true));
    act(() => result.current.execute());
    deliver(
      'seed:error',
      {
        message: 'Refused.',
        code: 'CHECKPOINT_REFUSED',
        checkpointRefusal: 'DISK',
        checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
      },
      sent('seed:scenario:execute').pop()?.id,
    );

    expect(result.current.phase).toBe('executing');
    expect(result.current.canSetUpAgain).toBe(true);
    expect(result.current.stoppedCheckpoint).toEqual({
      state: 'deleted',
      deleted: 'nothingWritten',
    });
    act(() => result.current.toConfirm());
    expect(result.current.phase).toBe('confirm');
    expect(result.current.checkpointFirst).toBe(true);
  });

  it('stops a run only once it has reported progress, aiming at its own run', () => {
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: 'org-dev' });
    const { result } = renderHook(() =>
      useScenarioSeed({ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }),
    );
    act(() => result.current.toConfirm());
    deliver(
      'seed:scenario:prepare:response',
      { preparation: PREPARATION },
      sent('seed:scenario:prepare').pop()?.id,
    );
    act(() => result.current.execute());
    act(() => result.current.cancel());
    expect(sent('execution:abort')).toEqual([]);

    const runId = sent('seed:scenario:execute')[0]?.id as string;
    deliver('operation:progress', {
      operationId: runId,
      percentage: 10,
      processedRecords: 1,
      totalRecords: 10,
      currentStep: 'Insert Account',
    });
    act(() => result.current.cancel());

    expect(sent('execution:abort')[0]?.payload).toEqual({ operationId: runId });
  });

  it('keeps an edit as unsaved: the pack is saved again before it is seeded', () => {
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: 'org-dev' });
    const { result } = renderHook(() =>
      useScenarioSeed({ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }),
    );
    expect(result.current.mustSave).toBe(false);

    act(() => result.current.edit({ ...RETAIL_ORDERS_PACK, name: 'Edited' }));
    expect(result.current.mustSave).toBe(true);
    act(() => result.current.toConfirm());
    expect(result.current.phase).toBe('review');
  });
});
