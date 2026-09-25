import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { renderHook, act, type RenderHookResult } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '../../../i18n/locales/en.json';
import fr from '../../../i18n/locales/fr.json';
import { useClone, type UseCloneReturn } from './useClone';

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
  requestId: null as string | null,
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

/** Deliver a `seed:clone:error` the way the extension posts it, correlated to its request. */
function cloneError(correlationId: string, message: string, code: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: 'host-error',
        type: 'seed:clone:error',
        timestamp: Date.now(),
        correlationId,
        payload: { message, code, retryable: false },
      },
    }),
  );
}

/** What the bridge answers a request it refuses with: its own check, in English. */
const REFUSED =
  'Invalid payload — objects.0.whereClause: A WHERE clause may only filter: no LIMIT, OFFSET, ' +
  'ORDER BY, GROUP BY, HAVING, FOR, WITH, ALL ROWS, subquery or DML keyword, no semicolon or ' +
  'comment, and every parenthesis and quote closed.';

/** What `seed:clone:preview` answers for one Account. */
const ACCOUNT_PREVIEW = {
  objects: [{ objectApiName: 'Account', recordCount: 3, sampleRecords: [], relationships: [] }],
  insertOrder: ['Account'],
};

/** The org selected in SandForge, which the hook is rendered with: a test may select another. */
let selectedTarget = 'target-1';

/**
 * The hook at its preview of Account, from source-1 into the selected org:
 * picked, asked as request `wv-preview`, and answered.
 */
function previewed(): RenderHookResult<UseCloneReturn, unknown> {
  const hook = renderHook(() => useClone(selectedTarget));
  act(() => {
    hook.result.current.handleSourceOrgSelected('source-1');
  });
  act(() => {
    hook.result.current.handleObjectToggle('Account');
  });
  act(() => {
    hook.result.current.handlePreview();
  });
  mockPreviewState = { ...mockPreviewState, data: ACCOUNT_PREVIEW, requestId: 'wv-preview' };
  hook.rerender();
  return hook;
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
      requestId: null,
    };
    mockExecuteState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteReset,
      requestId: null,
    };
    // A reset drops what the request was answered with, as the mutation's own does.
    mockDescribeReset.mockImplementation(() => {
      mockDescribeState = { ...mockDescribeState, data: null, error: null };
    });
    mockPreviewReset.mockImplementation(() => {
      mockPreviewState = { ...mockPreviewState, data: null, error: null, requestId: null };
    });
    mockExecuteReset.mockImplementation(() => {
      mockExecuteState = { ...mockExecuteState, data: null, error: null, requestId: null };
    });
    selectedTarget = 'target-1';
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

  it('sends no preview without a target org, and says why in words', () => {
    // Sent with an empty target, the preview was refused by the bridge, and
    // the wizard showed its check: "Invalid payload — targetOrgId: …".
    const { result } = renderHook(() => useClone(''));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handlePreview();
    });

    expect(mockPreviewMutate).not.toHaveBeenCalled();
    expect(result.current.executionStatus).toBe('idle');
    expect(result.current.error).toBe(en.seed.clone.wizard.needsBothOrgs);
  });

  describe('a request the bridge refuses', () => {
    /** Select a source and an object, and send the preview, as request `wv-preview`. */
    function previewSent(): RenderHookResult<UseCloneReturn, unknown> {
      const hook = renderHook(() => useClone('target-1'));
      act(() => {
        hook.result.current.handleSourceOrgSelected('source-1');
      });
      act(() => {
        hook.result.current.handleObjectToggle('Account');
      });
      act(() => {
        hook.result.current.handlePreview();
      });
      mockPreviewState = { ...mockPreviewState, loading: true, requestId: 'wv-preview' };
      hook.rerender();
      return hook;
    }

    it('is shown in words, not in the English of the check that refused it', () => {
      const { result, rerender } = previewSent();

      // The mutation takes the message as it came, from the same dispatch,
      // and renders the page with it.
      act(() => {
        mockPreviewState = { ...mockPreviewState, loading: false, error: REFUSED };
        cloneError('wv-preview', REFUSED, 'INVALID_PAYLOAD');
      });
      rerender();

      expect(result.current.executionStatus).toBe('error');
      expect(result.current.error).toBe(en.seed.clone.error.INVALID_PAYLOAD);
    });

    it('is shown in the language the panel is set to', async () => {
      await i18nInstance.changeLanguage('fr');
      const { result, rerender } = previewSent();

      act(() => {
        mockPreviewState = { ...mockPreviewState, loading: false, error: REFUSED };
        cloneError('wv-preview', REFUSED, 'INVALID_PAYLOAD');
      });
      rerender();

      expect(result.current.error).toBe(fr.seed.clone.error.INVALID_PAYLOAD);
      expect(result.current.error).not.toContain('Invalid payload');
    });

    it('is shown in words for a run too', () => {
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
      rerender();

      act(() => {
        mockExecuteState = { ...mockExecuteState, loading: false, error: REFUSED };
        cloneError('wv-clone-run', REFUSED, 'INVALID_PAYLOAD');
      });
      rerender();

      expect(result.current.executionStatus).toBe('error');
      expect(result.current.error).toBe(en.seed.clone.error.INVALID_PAYLOAD);
    });

    it('leaves a failure the org answered as the extension words it', () => {
      // What the org said is the reason, and the only one the page has.
      const { result, rerender } = previewSent();
      const failed =
        'Invoice__c could not be described in the target org: NOT_FOUND: The requested resource does not exist';

      act(() => {
        mockPreviewState = { ...mockPreviewState, loading: false, error: failed };
        cloneError('wv-preview', failed, 'UNKNOWN');
      });
      rerender();

      expect(result.current.error).toBe(failed);
    });

    it('is not taken for a refusal of another request', () => {
      const { result } = previewSent();

      act(() => {
        cloneError('wv-another-preview', REFUSED, 'INVALID_PAYLOAD');
      });

      expect(result.current.executionStatus).toBe('previewing');
      expect(result.current.error).toBeNull();
    });
  });

  describe('a preview, while it is prepared', () => {
    /** Select a source and an object, and send the preview, as request `wv-preview`. */
    function previewAskedFor(): RenderHookResult<UseCloneReturn, unknown> {
      const hook = renderHook(() => useClone('target-1'));
      act(() => {
        hook.result.current.handleSourceOrgSelected('source-1');
      });
      act(() => {
        hook.result.current.handleObjectToggle('Account');
      });
      act(() => {
        hook.result.current.handlePreview();
      });
      mockPreviewState = { ...mockPreviewState, loading: true, requestId: 'wv-preview' };
      hook.rerender();
      return hook;
    }

    it('is shown on the preview step from the moment it is asked for', () => {
      // The wizard stayed on the objects until the answer came, and the
      // preview step's own loading state was never drawn.
      const { result } = previewAskedFor();

      expect(result.current.step).toBe('preview');
      expect(result.current.executionStatus).toBe('previewing');
    });

    it('goes back to the objects when it fails, where the banner says why', () => {
      const { result, rerender } = previewAskedFor();
      const failed =
        'Invoice__c could not be described in the target org: NOT_FOUND: The requested resource does not exist';

      act(() => {
        mockPreviewState = { ...mockPreviewState, loading: false, error: failed };
        cloneError('wv-preview', failed, 'UNKNOWN');
      });
      rerender();

      expect(result.current.step).toBe('objects');
      expect(result.current.error).toBe(failed);
      expect(result.current.selectedObjects).toEqual([{ objectApiName: 'Account' }]);
    });

    it('goes back to the objects when the bridge refuses it', () => {
      const { result, rerender } = previewAskedFor();

      act(() => {
        mockPreviewState = { ...mockPreviewState, loading: false, error: REFUSED };
        cloneError('wv-preview', REFUSED, 'INVALID_PAYLOAD');
      });
      rerender();

      expect(result.current.step).toBe('objects');
      expect(result.current.error).toBe(en.seed.clone.error.INVALID_PAYLOAD);
    });

    it('is set aside when another step is gone to, so its answer cannot bring the wizard back', () => {
      const { result } = previewAskedFor();
      mockPreviewReset.mockClear();

      act(() => {
        result.current.setStep('objects');
      });

      expect(mockPreviewReset).toHaveBeenCalled();
      expect(result.current.step).toBe('objects');
      expect(result.current.executionStatus).toBe('idle');
      expect(result.current.selectedObjects).toEqual([{ objectApiName: 'Account' }]);
    });
  });

  describe('a run, which goes by its preview', () => {
    it('runs the clone of the orgs and objects its preview was made for, naming that preview', () => {
      const { result } = previewed();
      // Picked after the preview, and never previewed.
      act(() => {
        result.current.handleObjectToggle('Contact');
      });

      act(() => {
        result.current.handleExecute();
      });

      expect(result.current.executionStatus).toBe('executing');
      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      expect(mockExecuteMutate).toHaveBeenCalledWith({
        sourceOrgId: 'source-1',
        targetOrgId: 'target-1',
        objects: [{ objectApiName: 'Account' }],
        previewId: 'wv-preview',
      });
    });

    it('sends no run that does not name its preview', () => {
      // The extension refuses a run that names none: the page never sends one.
      const { result, rerender } = previewed();
      mockPreviewState = { ...mockPreviewState, requestId: null };
      rerender();

      act(() => {
        result.current.handleExecute();
      });

      expect(mockExecuteMutate).not.toHaveBeenCalled();
    });

    it('says in words that the extension refused a run naming no preview, and drops the preview it had', () => {
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
      rerender();
      const refused = 'Clone refused: it names no preview. Preview it, then run the preview shown.';

      act(() => {
        mockExecuteState = { ...mockExecuteState, loading: false, error: refused };
        cloneError('wv-clone-run', refused, 'NOT_PREVIEWED');
      });
      rerender();

      expect(result.current.error).toBe(en.seed.clone.error.NOT_PREVIEWED);
      expect(result.current.previewResult).toBeNull();
      expect(result.current.step).toBe('objects');
      expect(result.current.selectedObjects).toEqual([{ objectApiName: 'Account' }]);
    });

    it('sends no run without a preview', () => {
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

      expect(mockExecuteMutate).not.toHaveBeenCalled();
      expect(result.current.executionStatus).toBe('idle');
    });

    it('keeps its preview while the org it was made for stays selected, and drops it, saying why, once another is', () => {
      // The target is the org selected in SandForge, read again on every
      // render: selected after the preview, another org became the one the
      // run wrote to.
      const { result, rerender } = previewed();
      rerender();
      expect(result.current.previewResult).toEqual(ACCOUNT_PREVIEW);
      expect(result.current.error).toBeNull();

      selectedTarget = 'target-2';
      rerender();

      expect(result.current.previewResult).toBeNull();
      expect(result.current.step).toBe('objects');
      expect(result.current.error).toBe(en.seed.clone.wizard.targetChanged);
      expect(result.current.selectedObjects).toEqual([{ objectApiName: 'Account' }]);
      expect(mockPreviewReset).toHaveBeenCalled();
      act(() => {
        result.current.handleExecute();
      });
      expect(mockExecuteMutate).not.toHaveBeenCalled();
    });

    it('drops a preview still to come when another org is selected meanwhile', () => {
      const { result, rerender } = renderHook(() => useClone(selectedTarget));
      act(() => {
        result.current.handleSourceOrgSelected('source-1');
      });
      act(() => {
        result.current.handleObjectToggle('Account');
      });
      act(() => {
        result.current.handlePreview();
      });
      mockPreviewReset.mockClear();

      selectedTarget = 'target-2';
      rerender();

      expect(mockPreviewReset).toHaveBeenCalled();
      expect(result.current.executionStatus).toBe('idle');
      expect(result.current.error).toBe(en.seed.clone.wizard.targetChanged);
    });

    it('refuses to run a finished clone again into an org selected since, and says why', () => {
      // Its results stay on screen when another org is selected; back on its
      // preview, Execute would have written to the org selected now.
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, data: { status: 'success' } };
      rerender();
      expect(result.current.executionStatus).toBe('complete');
      selectedTarget = 'target-2';
      rerender();
      expect(result.current.executionResult).toEqual({ status: 'success' });
      act(() => {
        result.current.setStep('preview');
      });

      act(() => {
        result.current.handleExecute();
      });

      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBe(en.seed.clone.wizard.targetChanged);
      expect(result.current.previewResult).toBeNull();
      expect(result.current.step).toBe('objects');
    });

    it('says in words that the extension refused a run its preview was not made for, and drops that preview', () => {
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
      rerender();
      const refused =
        'This clone was refused: its preview was made for another source or target org. Preview it again.';

      act(() => {
        mockExecuteState = { ...mockExecuteState, loading: false, error: refused };
        cloneError('wv-clone-run', refused, 'PREVIEWED_FOR_OTHER_ORGS');
      });
      rerender();

      expect(result.current.error).toBe(en.seed.clone.error.PREVIEWED_FOR_OTHER_ORGS);
      expect(result.current.previewResult).toBeNull();
      expect(result.current.step).toBe('objects');
      expect(result.current.selectedObjects).toEqual([{ objectApiName: 'Account' }]);
    });

    it('moves to the execute step as soon as the run is sent', () => {
      const { result } = previewed();

      act(() => {
        result.current.handleExecute();
      });

      expect(result.current.step).toBe('execute');
      expect(result.current.executionStatus).toBe('executing');
    });

    it('sends no second run while one is in flight', () => {
      const { result } = previewed();
      act(() => {
        result.current.handleExecute();
      });

      act(() => {
        result.current.handleExecute();
      });

      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      expect(result.current.step).toBe('execute');
    });

    it('goes back to its preview when the run ends without a result', () => {
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
      rerender();

      operationFailed('wv-clone-run', 'Bulk job failed', 'CLONE_FAILED');

      expect(result.current.step).toBe('preview');
      expect(result.current.previewResult).toEqual(ACCOUNT_PREVIEW);
    });

    it('sets aside the result of the last run when a new preview is asked for', () => {
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, data: { status: 'success' } };
      rerender();
      expect(result.current.executionResult).toEqual({ status: 'success' });
      mockExecuteReset.mockClear();

      act(() => {
        result.current.handlePreview();
      });

      expect(result.current.executionResult).toBeNull();
      expect(mockExecuteReset).toHaveBeenCalled();
      expect(result.current.executionStatus).toBe('previewing');
    });
  });

  describe('the error banner, dismissed', () => {
    it('clears the error and nothing else: the orgs, the objects and the preview stay', () => {
      const { result, rerender } = previewed();
      act(() => {
        result.current.handleExecute();
      });
      mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
      rerender();
      operationFailed('wv-clone-run', 'Bulk job failed', 'CLONE_FAILED');
      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.dismissError();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.sourceOrgId).toBe('source-1');
      expect(result.current.selectedObjects).toEqual([{ objectApiName: 'Account' }]);
      expect(result.current.previewResult).toEqual(ACCOUNT_PREVIEW);
      expect(result.current.step).toBe('preview');
    });

    it('does not bring back a describe failure once dismissed', () => {
      mockDescribeState = { ...mockDescribeState, error: 'Describe exploded' };
      const { result, rerender } = renderHook(() => useClone('target-1'));
      expect(result.current.error).toBe('Describe exploded');

      act(() => {
        result.current.dismissError();
      });
      rerender();

      expect(result.current.error).toBeNull();
    });
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
      result.current.setStep('source');
    });
    expect(result.current.step).toBe('source');
  });

  it('leaves a preview step with no preview to show for the objects', () => {
    // Neither prepared nor answered, the preview step stood empty.
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.setStep('preview');
    });

    expect(result.current.step).toBe('objects');
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
    const { result, rerender } = previewed();

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
    const { result, rerender } = previewed();
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
    const { result, rerender } = previewed();
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
    const { result, rerender } = previewed();
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
    const { result, rerender } = previewed();
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
    const { result, rerender } = previewed();
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
    const { result, rerender } = previewed();
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
    const { result, rerender } = previewed();
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
