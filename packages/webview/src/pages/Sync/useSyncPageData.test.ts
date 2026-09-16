import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useSyncPageData } from './useSyncPageData';
import { useAppStore } from '../../stores/useAppStore';
import { SYNC_ACCOUNT_HIERARCHY } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addNotification: vi.fn() }),
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

/**
 * State of the sync:execute mutation, set by the tests that need a run going.
 * `mutate` is kept so a test can read the configuration that went out.
 */
const execution = vi.hoisted(() => ({
  loading: false,
  requestId: null as string | null,
  mutate: vi.fn(),
}));

/**
 * Calls of the sync:describe-fields mutation. The mock hands out a new `mutate`
 * on every render, so an effect that listed the mutation among its triggers
 * would fire again on each render.
 */
const describeFields = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string) => ({
    mutate:
      requestType === 'sync:execute'
        ? execution.mutate
        : requestType === 'sync:describe-fields'
          ? (payload?: Record<string, unknown>) => describeFields.mutate(payload)
          : vi.fn(),
    data: null,
    loading: requestType === 'sync:execute' ? execution.loading : false,
    error: null,
    reset: vi.fn(),
    requestId: requestType === 'sync:execute' ? execution.requestId : null,
  }),
}));

/** The stored draft the page reopens on; a test that needs one sets it. */
const draft = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock('../../hooks/useWebviewPersistedState', () => ({
  useWebviewPersistedState: (_key: string, defaultValue: unknown) => {
    const state = { current: draft.value ?? defaultValue };
    return [state.current, vi.fn()];
  },
}));

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('useSyncPageData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draft.value = null;
    execution.loading = false;
    execution.requestId = null;
    execution.mutate.mockClear();
  });

  it('shows the progress of the sync it started, not of another run reporting at the same time', () => {
    // Every open panel receives every operation:progress, and the sync
    // handler uses the request id as the operationId.
    execution.loading = true;
    execution.requestId = 'wv-own-sync';
    const report = (operationId: string, percentage: number): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: `ext-${operationId}-${percentage}`,
            type: 'operation:progress',
            timestamp: Date.now(),
            payload: {
              operationId,
              percentage,
              processedRecords: percentage,
              totalRecords: 100,
              currentStep: 'Account',
            },
          },
        }),
      );
    };

    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      report('wv-own-sync', 25);
      report('wv-other-sync', 80);
    });

    expect(result.current.overallPercent).toBe(25);
  });

  it('sends the transform rule with the settings typed for it', () => {
    // TransformBuilder's inputs were handed a no-op, so a prefix, a replacement
    // or a truncate length never left the page: every value-based rule reached
    // the run with an empty config and changed nothing.
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
      result.current.handleAddTransform('prefix');
    });
    act(() => {
      result.current.handleChangeTransformConfig(0, 'prefix', 'X-');
    });
    act(() => {
      result.current.handleExecute();
    });

    const sent = execution.mutate.mock.calls[0][0] as {
      config: { objects: { transformRules: { type: string; config: { prefix?: string } }[] }[] };
    };
    expect(sent.config.objects[0].transformRules[0].type).toBe('prefix');
    expect(sent.config.objects[0].transformRules[0].config.prefix).toBe('X-');
  });

  it('sends a truncate length as the number the schema expects', () => {
    // The length box is text, and `length` is a number at the boundary: sent as
    // '5' the whole configuration would be refused before the run.
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
      result.current.handleAddTransform('truncate');
    });
    act(() => {
      result.current.handleChangeTransformConfig(0, 'length', '5');
    });
    act(() => {
      result.current.handleExecute();
    });

    const sent = execution.mutate.mock.calls[0][0] as {
      config: { objects: { transformRules: { config: { length?: number } }[] }[] };
    };
    expect(sent.config.objects[0].transformRules[0].config.length).toBe(5);
  });

  it('leaves out a truncate length whose text is not a whole number', () => {
    // The box is text and `length` is a positive integer at the boundary:
    // '5.7' must not silently become 5 characters.
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleSourceOrgChange('org-1');
      result.current.handleTargetOrgChange('org-2');
      result.current.handleAddObject('Account');
      result.current.handleAddTransform('truncate');
    });
    act(() => {
      result.current.handleChangeTransformConfig(0, 'length', '5.7');
    });
    act(() => {
      result.current.handleExecute();
    });

    const sent = execution.mutate.mock.calls[0][0] as {
      config: { objects: { transformRules: { config: { length?: number } }[] }[] };
    };
    expect(sent.config.objects[0].transformRules[0].config.length).toBeUndefined();
  });

  it('reopens a draft naming a conflict strategy the page no longer offers on source wins', () => {
    // A draft saved while 'manual' was still offered would otherwise put the
    // select on a value with no option and print its raw label key on the
    // review step.
    draft.value = {
      currentStep: 0,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'manual',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [],
    };

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.conflictStrategy).toBe('source_wins');
  });

  it('should start at step 0', () => {
    const { result } = renderHook(() => useSyncPageData());
    expect(result.current.currentStep).toBe(0);
  });

  it('canGoNext at step 0 should require both orgs AND at least 1 object', () => {
    const { result } = renderHook(() => useSyncPageData());
    // No orgs, no objects => false
    expect(result.current.canGoNext()).toBe(false);
  });

  it('isFinished should be true when currentStep is 5 and result exists', () => {
    const { result } = renderHook(() => useSyncPageData());
    // At step 0 with no result, isFinished should be false
    expect(result.current.isFinished).toBe(false);
  });

  it('handleApplyTemplate should populate direction, mode, conflictStrategy and objectEntries', () => {
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleApplyTemplate(SYNC_ACCOUNT_HIERARCHY);
    });

    expect(result.current.direction).toBe('source_to_target');
    expect(result.current.mode).toBe('full');
    expect(result.current.conflictStrategy).toBe('source_wins');
    expect(result.current.objectEntries).toHaveLength(5);
    expect(result.current.objectEntries[0].objectApiName).toBe('Account');
    expect(result.current.objectEntries[4].objectApiName).toBe('Note');
  });

  it('handleApplyTemplate should clear mappings and transforms', () => {
    const { result } = renderHook(() => useSyncPageData());

    // Add a mapping first
    act(() => {
      result.current.handleAddMapping('Name', 'Name');
    });
    expect(result.current.mappings).toHaveLength(1);

    // Apply template should clear it
    act(() => {
      result.current.handleApplyTemplate(SYNC_ACCOUNT_HIERARCHY);
    });
    expect(result.current.mappings).toHaveLength(0);
    expect(result.current.transforms).toHaveLength(0);
  });

  it('should expose handleApplyTemplate in the return object', () => {
    const { result } = renderHook(() => useSyncPageData());
    expect(typeof result.current.handleApplyTemplate).toBe('function');
  });

  it("asks for the first object's fields on entering the mapping step, and not on every render", () => {
    const { result, rerender } = renderHook(() => useSyncPageData());
    act(() => {
      result.current.handleSourceOrgChange('org-src');
      result.current.handleTargetOrgChange('org-tgt');
      result.current.handleAddObject('Account');
    });
    expect(describeFields.mutate).not.toHaveBeenCalled();

    act(() => {
      result.current.setCurrentStep(1);
    });
    rerender();
    rerender();

    expect(describeFields.mutate).toHaveBeenCalledTimes(1);
    expect(describeFields.mutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      objectApiName: 'Account',
    });
  });

  it('starts from the source and target orgs Home recommended syncing, once', () => {
    useAppStore.setState({
      navigationIntent: { route: 'sync', sourceOrgId: 'org-src', targetOrgId: 'org-tgt' },
    });

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.sourceOrgId).toBe('org-src');
    expect(result.current.targetOrgId).toBe('org-tgt');
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });
});
