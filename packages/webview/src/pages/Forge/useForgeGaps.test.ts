import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeGap,
  ForgeGraph,
  ForgeTargetGaps,
} from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useForgeGaps } from './useForgeGaps';
import { useForgeStore } from '../../stores/useForgeStore';

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

function gap(kind: ForgeGap['kind'], severity: ForgeGap['severity'], field?: string): ForgeGap {
  return {
    id: forgeGapId(kind, 'Account', field),
    kind,
    severity,
    source: 'metadata',
    objectApiName: 'Account',
    ...(field ? { field } : {}),
    rows: 0,
    decisions: ['ignore'],
  };
}

const READ: ForgeTargetGaps = {
  gaps: [
    gap('required_field_missing', 'blocking', 'Region__c'),
    { ...gap('validation_rule', 'warning', 'Phone'), detail: { formula: 'notRead' } },
    gap('api_budget', 'info'),
  ],
  unread: [{ part: 'apiBudget', reason: 'INSUFFICIENT_ACCESS' }],
  requests: 9,
};

/** The gaps requests the hook posted, each with its id. */
function requests(): Array<BaseMessage & { payload: { graph: ForgeGraph; config: ForgeConfig } }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        call[0] as {
          payload: BaseMessage & { payload: { graph: ForgeGraph; config: ForgeConfig } };
        },
    )
    .map((envelope) => envelope.payload)
    .filter((message) => message.type === 'forge:gaps:request');
}

/** Deliver an extension -> webview message, answering `correlationId`. */
function fromExtension(type: string, correlationId: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `resp-${type}`, type, timestamp: Date.now(), correlationId, payload },
        origin: '',
      }),
    );
  });
}

describe('useForgeGaps', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.setState({ gaps: { metadata: [], simulation: [], rehearsal: [] } });
  });

  it('asks the extension for the gaps of the graph under the config', () => {
    const { result } = renderHook(() => useForgeGaps());

    act(() => result.current.request(CONFIG, GRAPH));

    expect(requests().map((message) => message.payload)).toEqual([
      { graph: GRAPH, config: CONFIG },
    ]);
    expect(result.current.pending).toBe(true);
  });

  it('keeps the answer as the metadata gaps, and says what the read came to', () => {
    const simulated = [gap('value_too_long', 'warning', 'Name')];
    useForgeStore.getState().setGaps('simulation', simulated);
    const { result } = renderHook(() => useForgeGaps());
    act(() => result.current.request(CONFIG, GRAPH));

    fromExtension('forge:gaps:response', requests()[0].id, { gaps: READ });

    expect(useForgeStore.getState().gaps.metadata).toEqual(READ.gaps);
    // A read of the metadata replaces its own gaps only.
    expect(useForgeStore.getState().gaps.simulation).toEqual(simulated);
    // What the read could not read is kept with its gaps, for the Gaps tab.
    expect(useForgeStore.getState().gapReads.metadata).toEqual(READ.unread);
    expect(result.current).toMatchObject({
      pending: false,
      error: null,
      read: {
        count: 3,
        blocking: 1,
        formulasNotRead: 1,
        unread: READ.unread,
        requests: 9,
      },
    });
  });

  it('takes the answer to its last request only', () => {
    const { result } = renderHook(() => useForgeGaps());
    act(() => result.current.request(CONFIG, GRAPH));
    const [first] = requests();
    act(() => result.current.request({ ...CONFIG, targetOrgId: 'other-org' }, GRAPH));

    fromExtension('forge:gaps:response', first.id, { gaps: READ });

    expect(useForgeStore.getState().gaps.metadata).toEqual([]);
    expect(result.current.read).toBeNull();
    expect(result.current.pending).toBe(true);
  });

  it('says why the read could not run, instead of reading for ever', () => {
    const { result } = renderHook(() => useForgeGaps());
    act(() => result.current.request(CONFIG, GRAPH));

    fromExtension('forge:gaps:error', requests()[0].id, {
      message: 'Target gap reader not configured',
      code: 'NOT_INITIALIZED',
      retryable: false,
    });

    expect(result.current).toMatchObject({
      pending: false,
      error: 'Target gap reader not configured',
      read: null,
    });
  });
});
