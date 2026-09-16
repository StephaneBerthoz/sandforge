import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '../../../i18n/locales/en.json';
import fr from '../../../i18n/locales/fr.json';
import { useClone } from './useClone';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const mockDescribeMutate = vi.fn();
const mockDescribeReset = vi.fn();
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();

let mockDescribeState = {
  mutate: mockDescribeMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockDescribeReset,
};

let mockPreviewState = {
  mutate: mockPreviewMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockPreviewReset,
};

let mockExecuteState = {
  mutate: mockExecuteMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteReset,
  requestId: null as string | null,
};

/** Every mutation the hook creates, with the error channel it asked for. */
const mutationCalls: Array<{ type: string; errorType?: string }> = [];

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { errorType?: string }) => {
    mutationCalls.push({ type, errorType: options?.errorType });
    if (type === 'seed:clone:describe-source') return mockDescribeState;
    if (type === 'seed:clone:preview') return mockPreviewState;
    if (type === 'seed:clone:execute') return mockExecuteState;
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/** Deliver an `operation:failed` the way the extension posts it. */
function operationFailed(operationId: string, error: string, code?: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-failed',
          type: 'operation:failed',
          timestamp: Date.now(),
          payload: { operationId, error, retryable: false, ...(code ? { code } : {}) },
        },
      }),
    );
  });
}

/**
 * A real i18next instance, not a key-echoing stub: what the wizard shows for a
 * failed clone is the translation of the code the host sent, so only a loaded
 * catalogue can tell a translated sentence from a key or from English prose.
 */
let i18nInstance: I18n;

describe('useClone', () => {
  beforeAll(async () => {
    i18nInstance = createInstance();
    await i18nInstance.use(initReactI18next).init({
      resources: { en: { translation: en }, fr: { translation: fr } },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(async () => {
    await i18nInstance.changeLanguage('en');
    mockDescribeMutate.mockClear();
    mutationCalls.length = 0;
    mockDescribeReset.mockClear();
    mockPreviewMutate.mockClear();
    mockPreviewReset.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();

    mockDescribeState = {
      mutate: mockDescribeMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockDescribeReset,
    };
    mockPreviewState = {
      mutate: mockPreviewMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockPreviewReset,
    };
    mockExecuteState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteReset,
      requestId: null,
    };
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useClone('target-1'));

    expect(result.current.sourceOrgId).toBe('');
    expect(result.current.targetOrgId).toBe('target-1');
    expect(result.current.sourceObjects).toEqual([]);
    expect(result.current.selectedObjects).toEqual([]);
    expect(result.current.previewResult).toBeNull();
    expect(result.current.executionStatus).toBe('idle');
    expect(result.current.executionResult).toBeNull();
    expect(result.current.step).toBe('source');
    expect(result.current.error).toBeNull();
  });

  it('should set sourceOrgId and send describe-source message on handleSourceOrgSelected', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });

    expect(result.current.sourceOrgId).toBe('source-1');
    expect(mockDescribeMutate).toHaveBeenCalledWith({ sourceOrgId: 'source-1' });
  });

  it('should add and remove objects via handleObjectToggle', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    expect(result.current.selectedObjects).toHaveLength(1);
    expect(result.current.selectedObjects[0].objectApiName).toBe('Account');

    act(() => {
      result.current.handleObjectToggle('Contact');
    });
    expect(result.current.selectedObjects).toHaveLength(2);

    // Toggle off Account
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    expect(result.current.selectedObjects).toHaveLength(1);
    expect(result.current.selectedObjects[0].objectApiName).toBe('Contact');
  });

  it('should update WHERE clause via handleWhereClauseChange', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', "Industry = 'Technology'");
    });

    expect(result.current.selectedObjects[0].whereClause).toBe("Industry = 'Technology'");
  });

  it('should clear WHERE clause when set to empty string', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', "Industry = 'Tech'");
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', '');
    });

    expect(result.current.selectedObjects[0].whereClause).toBeUndefined();
  });

  it('should send preview mutation on handlePreview', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handlePreview();
    });

    expect(result.current.executionStatus).toBe('previewing');
    expect(mockPreviewMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOrgId: 'source-1',
        targetOrgId: 'target-1',
        objects: [{ objectApiName: 'Account' }],
      }),
    );
  });

  it('should send execute mutation on handleExecute', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleExecute();
    });

    expect(result.current.executionStatus).toBe('executing');
    expect(mockExecuteMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOrgId: 'source-1',
        targetOrgId: 'target-1',
      }),
    );
  });

  it('should reset all state on reset()', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.sourceOrgId).toBe('');
    expect(result.current.selectedObjects).toEqual([]);
    expect(result.current.step).toBe('source');
    expect(result.current.executionStatus).toBe('idle');
    expect(mockDescribeReset).toHaveBeenCalled();
    expect(mockPreviewReset).toHaveBeenCalled();
    expect(mockExecuteReset).toHaveBeenCalled();
  });

  it('should allow manual step navigation via setStep', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.setStep('objects');
    });
    expect(result.current.step).toBe('objects');

    act(() => {
      result.current.setStep('preview');
    });
    expect(result.current.step).toBe('preview');
  });

  /* ------------------------------------------------------------------ */
  /* seed:clone:error channel (fail fast, no 30 s timeout)               */
  /* ------------------------------------------------------------------ */

  it('listens for describe, preview and execute failures on seed:clone:error', () => {
    // The handler posts its failures on this channel, correlated to the
    // request, and the mutations listen there themselves. A separate
    // type-only listener used to catch them instead and hand each one to
    // whichever mutation happened to be loading.
    renderHook(() => useClone('target-1'));

    expect(mutationCalls).toEqual(
      expect.arrayContaining([
        { type: 'seed:clone:describe-source', errorType: 'seed:clone:error' },
        { type: 'seed:clone:preview', errorType: 'seed:clone:error' },
        { type: 'seed:clone:execute', errorType: 'seed:clone:error' },
      ]),
    );
  });

  it('unsticks the executing status when the execute mutation errors', () => {
    const { result, rerender } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleExecute();
    });
    expect(result.current.executionStatus).toBe('executing');

    mockExecuteState = { ...mockExecuteState, loading: false, error: 'Execute exploded' };
    act(() => {
      rerender();
    });

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe('Execute exploded');
  });

  it('surfaces a describe-source failure without touching the status', () => {
    mockDescribeState = { ...mockDescribeState, loading: false, error: 'Describe exploded' };
    const { result } = renderHook(() => useClone('target-1'));

    expect(result.current.error).toBe('Describe exploded');
    expect(result.current.executionStatus).toBe('idle');
  });

  /* ------------------------------------------------------------------ */
  /* Execute failures arrive on operation:failed                         */
  /* ------------------------------------------------------------------ */

  it('ends the run as soon as the extension reports its clone failed, without waiting out the timeout', () => {
    // The execute handler reports a failure — a declined production
    // confirmation included — only on operation:failed, which nothing here
    // listened to: the wizard sat on "executing" for 120 s, then showed a raw
    // timeout.
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();
    mockExecuteReset.mockClear();

    operationFailed(
      'wv-clone-run',
      'Operation cancelled by user (production confirmation declined).',
      'PRODUCTION_CONFIRMATION_DECLINED',
    );

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe(en.seed.clone.error.PRODUCTION_CONFIRMATION_DECLINED);
    expect(mockExecuteReset).toHaveBeenCalled();
  });

  it('shows the declined production confirmation in French, not the English the host logged', async () => {
    // The host keeps writing the failure in English for the output channel and
    // the fix-suggestion table; the wizard showed that same English sentence to
    // a French user. The code is what it translates now.
    await i18nInstance.changeLanguage('fr');
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();

    operationFailed(
      'wv-clone-run',
      'Operation cancelled by user (production confirmation declined).',
      'PRODUCTION_CONFIRMATION_DECLINED',
    );

    expect(result.current.error).toBe(fr.seed.clone.error.PRODUCTION_CONFIRMATION_DECLINED);
    expect(result.current.error).not.toContain('Operation cancelled by user');
  });

  it('shows the production guard refusal in French, with no English detail under it', async () => {
    await i18nInstance.changeLanguage('fr');
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();

    operationFailed(
      'wv-clone-run',
      'Operation blocked by Production Guard: insert is not allowed on production org tgt',
      'PRODUCTION_GUARD_BLOCKED',
    );

    expect(result.current.error).toBe(fr.seed.clone.error.PRODUCTION_GUARD_BLOCKED);
    expect(result.current.error).not.toContain('Operation blocked');
  });

  it('falls back to the translated generic failure on a code it does not know', async () => {
    await i18nInstance.changeLanguage('fr');
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();

    operationFailed('wv-clone-run', 'Bulk job failed', 'SOMETHING_NEW');

    expect(result.current.error).toContain(fr.seed.clone.error.generic);
    // The raw mutation fallback is what the wizard used to show.
    expect(result.current.error).not.toContain("Bridge mutation 'seed:clone:execute' failed");
    expect(result.current.error).not.toBe('Bulk job failed');
    // The host text survives as a detail, so the org's own words are not lost.
    expect(result.current.error).toContain('Bulk job failed');
  });

  it('keeps the org failure as a detail under the translated CLONE_FAILED sentence', async () => {
    await i18nInstance.changeLanguage('fr');
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();

    operationFailed(
      'wv-clone-run',
      'STORAGE_LIMIT_EXCEEDED: storage limit exceeded',
      'CLONE_FAILED',
    );

    expect(result.current.error).toContain(fr.seed.clone.error.CLONE_FAILED);
    expect(result.current.error).toContain('STORAGE_LIMIT_EXCEEDED: storage limit exceeded');
  });

  it('ignores a failure reported for another operation', () => {
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();

    operationFailed('wv-some-other-run', 'Bulk job failed');

    expect(result.current.executionStatus).toBe('executing');
    expect(result.current.error).toBeNull();
  });

  it('keeps a finished clone complete when a failure for it is reported afterwards', () => {
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = {
      ...mockExecuteState,
      loading: false,
      requestId: 'wv-clone-run',
      data: { success: true },
    };
    rerender();
    expect(result.current.executionStatus).toBe('complete');

    operationFailed('wv-clone-run', 'Bulk job failed');

    expect(result.current.executionStatus).toBe('complete');
    expect(result.current.error).toBeNull();
  });

  it('selects the source org it is opened with and describes it, without previewing or running anything', () => {
    const { result } = renderHook(() => useClone('target-1', 'source-9'));

    expect(result.current.sourceOrgId).toBe('source-9');
    expect(mockDescribeMutate).toHaveBeenCalledWith({ sourceOrgId: 'source-9' });
    expect(mockPreviewMutate).not.toHaveBeenCalled();
    expect(mockExecuteMutate).not.toHaveBeenCalled();
  });
});
