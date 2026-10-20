import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

const mutationState = {
  loading: false,
  requestId: null as string | null,
  reset: vi.fn(),
};

// Mock useBridgeMutation before importing
vi.mock('./useBridgeMutation', () => ({
  useBridgeMutation: vi.fn(() => ({
    mutate: vi.fn(),
    data: null,
    loading: mutationState.loading,
    error: null,
    errorCode: null,
    reset: mutationState.reset,
    requestId: mutationState.requestId,
  })),
}));

import { useBridgeMutation } from './useBridgeMutation';
import { useSchemaAdvice, useAnomalyScan, usePipelineGenerator } from './useAIFeatures';

/** The messages the hooks posted, as the panel's bridge sends them. */
function sent(): Array<{ type: string; payload?: unknown }> {
  // The bridge posts each message inside an envelope, under `payload`.
  return mockPostMessage.mock.calls.map(
    ([envelope]) => (envelope as { payload: { type: string; payload?: unknown } }).payload,
  );
}

describe('useAIFeatures', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    mutationState.loading = false;
    mutationState.requestId = null;
    mutationState.reset.mockClear();
  });

  it('useSchemaAdvice calls useBridgeMutation with ai:schema-advice', () => {
    renderHook(() => useSchemaAdvice());
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:schema-advice');
  });

  it('useAnomalyScan calls useBridgeMutation with ai:anomaly-scan', () => {
    renderHook(() => useAnomalyScan());
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:anomaly-scan');
  });

  it('usePipelineGenerator calls useBridgeMutation with ai:generate-pipeline', () => {
    renderHook(() => usePipelineGenerator());
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:generate-pipeline');
  });

  describe('Stop', () => {
    it.each([['the pipeline generator', usePipelineGenerator]])(
      'asks the extension to stop %s’s request by its id, and is back to idle at once',
      (_name, hook) => {
        mutationState.loading = true;
        mutationState.requestId = 'req-42';
        const { result } = renderHook(() => hook());

        act(() => {
          result.current.stop();
        });

        expect(sent()).toEqual([
          expect.objectContaining({ type: 'ai:tool:cancel', payload: { requestId: 'req-42' } }),
        ]);
        expect(mutationState.reset).toHaveBeenCalledTimes(1);
      },
    );

    it('sends nothing while no draft is waiting', () => {
      mutationState.requestId = 'req-answered';
      const { result } = renderHook(() => usePipelineGenerator());

      act(() => {
        result.current.stop();
      });

      expect(sent()).toEqual([]);
      expect(mutationState.reset).not.toHaveBeenCalled();
    });
  });
});
