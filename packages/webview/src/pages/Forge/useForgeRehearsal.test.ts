import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeGap,
  ForgeGraph,
  ForgeRehearsal,
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

import { useForgeRehearsal } from './useForgeRehearsal';
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

const REFUSED: ForgeGap = {
  id: forgeGapId(
    'rehearsal_refusal',
    'Contact',
    'Phone',
    undefined,
    'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  ),
  kind: 'rehearsal_refusal',
  severity: 'warning',
  source: 'rehearsal',
  objectApiName: 'Contact',
  field: 'Phone',
  value: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  rows: 1,
  decisions: ['leave_empty'],
};

const VERDICTS: ForgeRehearsal = {
  gaps: [REFUSED],
  rows: 12,
  sampled: 4,
  judged: 4,
  passed: 3,
  notJudged: 0,
  notJudgedWhy: [],
  updates: 0,
  updatesJudged: 0,
  updatesPassed: 0,
  updatesNotRehearsed: 0,
  calls: 1,
  plannedCalls: 1,
};

/** The rehearsal requests the hook posted. */
function requests(): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === 'forge:rehearse:request');
}

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

describe('useForgeRehearsal', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
    useForgeStore.getState().reset();
    useForgeStore.setState({ graph: GRAPH, config: CONFIG });
  });

  it('sends the run the store holds, as Execute would send it', () => {
    const { result } = renderHook(() => useForgeRehearsal());
    act(() => result.current.rehearse());
    const [request] = requests();
    expect(request.payload).toEqual({
      graph: GRAPH,
      config: CONFIG,
      anonymizationRules: useForgeStore.getState().anonymizationRules,
    });
    expect(result.current.status).toBe('running');
  });

  it('sends nothing without a graph and a config', () => {
    useForgeStore.setState({ graph: null });
    const { result } = renderHook(() => useForgeRehearsal());
    act(() => result.current.rehearse());
    expect(requests()).toEqual([]);
    expect(result.current.status).toBe('idle');
  });

  it('keeps the verdicts as the rehearsal’s gaps, apart from the others', () => {
    useForgeStore.getState().setGaps('metadata', [{ ...REFUSED, id: 'm', source: 'metadata' }]);
    const { result } = renderHook(() => useForgeRehearsal());
    act(() => result.current.rehearse());
    fromExtension('forge:rehearse:response', requests()[0].id, { rehearsal: VERDICTS });
    expect(useForgeStore.getState().gaps.rehearsal).toEqual([REFUSED]);
    expect(useForgeStore.getState().gaps.metadata).toHaveLength(1);
    expect(result.current.status).toBe('done');
    expect(result.current.result).toEqual(VERDICTS);
  });

  it('follows the progress of its own request alone', () => {
    const { result } = renderHook(() => useForgeRehearsal());
    act(() => result.current.rehearse());
    fromExtension('forge:rehearse:progress', 'another-request', {
      phase: 'rehearsing',
      call: 9,
      calls: 9,
    });
    expect(result.current.progress).toBeNull();
    fromExtension('forge:rehearse:progress', requests()[0].id, { phase: 'confirming', calls: 2 });
    expect(result.current.progress).toEqual({ phase: 'confirming', calls: 2 });
  });

  it('takes no verdict answering an earlier request', () => {
    const { result } = renderHook(() => useForgeRehearsal());
    act(() => result.current.rehearse());
    const first = requests()[0].id;
    act(() => result.current.rehearse());
    fromExtension('forge:rehearse:response', first, { rehearsal: VERDICTS });
    expect(useForgeStore.getState().gaps.rehearsal).toEqual([]);
    expect(result.current.status).toBe('running');
  });

  it('tells a rehearsal declined at its question from one that failed', () => {
    const { result } = renderHook(() => useForgeRehearsal());
    act(() => result.current.rehearse());
    fromExtension('forge:rehearse:error', requests()[0].id, {
      message: 'cancelled',
      code: 'REHEARSAL_DECLINED',
      retryable: true,
    });
    expect(result.current.status).toBe('declined');
    act(() => result.current.rehearse());
    fromExtension('forge:rehearse:error', requests()[1].id, {
      message: 'composite refused',
      code: 'REHEARSAL_ERROR',
      retryable: true,
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('composite refused');
  });
});
