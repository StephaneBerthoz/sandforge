import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuickSyncPreview, SyncExecutionResult } from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { useWebviewPersistedState } from '../../../hooks/useWebviewPersistedState';

/** Step in the Quick Sync 3-screen flow. */
export type QuickSyncStep = 'orgs' | 'objects' | 'preview' | 'executing' | 'results';

/** Central state for the Quick Sync flow. */
export interface QuickSyncFlowState {
  /** Current step in the flow. */
  step: QuickSyncStep;
  /** Source org identifier. */
  sourceOrgId: string;
  /** Target org identifier. */
  targetOrgId: string;
  /** Objects explicitly selected by the user. */
  selectedObjects: string[];
  /** Auto-detected parent objects via relationship detection. */
  parentObjects: string[];
  /** Preview data from the backend. */
  preview: QuickSyncPreview | null;
  /** Execution result after sync completes. */
  result: SyncExecutionResult | null;
  /** Whether sync is currently executing. */
  isExecuting: boolean;
  /** Error message if any step failed. */
  error: string | null;
}

/** Draft state persisted across webview reloads. */
interface QuickSyncDraft {
  sourceOrgId: string;
  targetOrgId: string;
  selectedObjects: string[];
  parentObjects: string[];
}

/** Return type for the useQuickSyncFlow hook. */
export interface QuickSyncFlowActions {
  /** Current flow state. */
  state: QuickSyncFlowState;
  /** Set the source org. */
  setSourceOrg: (orgId: string) => void;
  /** Set the target org. */
  setTargetOrg: (orgId: string) => void;
  /** Add an object to the selection. */
  addObject: (apiName: string) => void;
  /** Remove an object from the selection. */
  removeObject: (apiName: string) => void;
  /** Add a parent object dependency. */
  addParentObject: (apiName: string) => void;
  /** Navigate to the objects step. */
  goToObjects: () => void;
  /** Navigate to the preview step and fetch preview data. */
  goToPreview: () => void;
  /** Execute the Quick Sync. */
  execute: () => void;
  /** Reset all state to initial. */
  reset: () => void;
  /** Whether navigation to objects step is allowed. */
  canGoToObjects: boolean;
  /** Whether navigation to preview step is allowed. */
  canGoToPreview: boolean;
}

const INITIAL_DRAFT: QuickSyncDraft = {
  sourceOrgId: '',
  targetOrgId: '',
  selectedObjects: [],
  parentObjects: [],
};

/**
 * Central state management hook for the Quick Sync 3-screen flow.
 *
 * Manages org selection, object picking, preview fetching, execution,
 * and persists draft state across webview reloads.
 */
export function useQuickSyncFlow(): QuickSyncFlowActions {
  const [draft, setDraft] = useWebviewPersistedState<QuickSyncDraft>(
    'quickSyncDraft',
    INITIAL_DRAFT,
  );
  const [step, setStep] = useWebviewPersistedState<QuickSyncStep>('quickSyncStep', 'orgs');
  const [preview, setPreview] = useWebviewPersistedState<QuickSyncPreview | null>(
    'quickSyncPreview',
    null,
  );
  const [result, setResult] = useWebviewPersistedState<SyncExecutionResult | null>(
    'quickSyncResult',
    null,
  );
  /**
   * Transient execution state is deliberately NOT persisted: restoring
   * `isExecuting=true` (or a stale error) after a webview reload revived a
   * permanent spinner on the preview screen while no operation was running.
   */
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewMutation = useBridgeMutation<{ preview: QuickSyncPreview }>('quicksync:preview');
  // `quicksync:execute` prepares the run: the extension auto-maps fields and
  // answers with a full SyncConfig. The actual execution is delegated to the
  // existing SyncOpsHandler flow by relaying that config to `sync:execute`.
  const prepareMutation = useBridgeMutation<{
    syncConfig: Record<string, unknown>;
    objectCount: number;
  }>('quicksync:execute');
  const syncMutation = useBridgeMutation<SyncExecutionResult>('sync:execute', {
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  // Sync preview mutation response into state (handler wraps it in { preview })
  useEffect(() => {
    if (previewMutation.data) {
      setPreview(previewMutation.data.preview);
    }
    if (previewMutation.error) {
      setError(previewMutation.error);
    }
  }, [previewMutation.data, previewMutation.error, setPreview, setError]);

  // Keep the latest sync mutate in a ref: `useBridgeMutation`'s mutate is not
  // guaranteed stable, and the relay effect must fire only when the prepared
  // config arrives — not on every render.
  const syncMutateRef = useRef(syncMutation.mutate);
  syncMutateRef.current = syncMutation.mutate;

  // Relay the prepared SyncConfig to the real execution flow
  useEffect(() => {
    if (prepareMutation.data) {
      syncMutateRef.current({ config: prepareMutation.data.syncConfig });
    }
  }, [prepareMutation.data]);

  // Prepare-step failures surface on quicksync:error
  useEffect(() => {
    if (prepareMutation.error) {
      setError(prepareMutation.error);
      setIsExecuting(false);
    }
  }, [prepareMutation.error, setError, setIsExecuting]);

  // Sync execution mutation response into state
  useEffect(() => {
    if (syncMutation.data) {
      setResult(syncMutation.data);
      setIsExecuting(false);
      setStep('results');
    }
    if (syncMutation.error) {
      setError(syncMutation.error);
      setIsExecuting(false);
    }
  }, [syncMutation.data, syncMutation.error, setResult, setIsExecuting, setStep, setError]);

  const setSourceOrg = useCallback(
    (orgId: string) => {
      setDraft({ ...draft, sourceOrgId: orgId });
      setError(null);
    },
    [draft, setDraft, setError],
  );

  const setTargetOrg = useCallback(
    (orgId: string) => {
      setDraft({ ...draft, targetOrgId: orgId });
      setError(null);
    },
    [draft, setDraft, setError],
  );

  const addObject = useCallback(
    (apiName: string) => {
      if (!draft.selectedObjects.includes(apiName)) {
        setDraft({ ...draft, selectedObjects: [...draft.selectedObjects, apiName] });
      }
    },
    [draft, setDraft],
  );

  const removeObject = useCallback(
    (apiName: string) => {
      setDraft({
        ...draft,
        selectedObjects: draft.selectedObjects.filter((o) => o !== apiName),
        parentObjects: draft.parentObjects.filter((o) => o !== apiName),
      });
    },
    [draft, setDraft],
  );

  const addParentObject = useCallback(
    (apiName: string) => {
      if (!draft.parentObjects.includes(apiName) && !draft.selectedObjects.includes(apiName)) {
        setDraft({
          ...draft,
          parentObjects: [...draft.parentObjects, apiName],
          selectedObjects: [...draft.selectedObjects, apiName],
        });
      }
    },
    [draft, setDraft],
  );

  const canGoToObjects =
    draft.sourceOrgId !== '' && draft.targetOrgId !== '' && draft.sourceOrgId !== draft.targetOrgId;
  const canGoToPreview = draft.selectedObjects.length > 0;

  const goToObjects = useCallback(() => {
    if (canGoToObjects) {
      setStep('objects');
      setError(null);
    }
  }, [canGoToObjects, setStep, setError]);

  const goToPreview = useCallback(() => {
    if (canGoToPreview) {
      previewMutation.mutate({
        sourceOrgId: draft.sourceOrgId,
        targetOrgId: draft.targetOrgId,
        selectedObjects: draft.selectedObjects,
        parentObjects: draft.parentObjects,
      });
      setStep('preview');
      setError(null);
    }
  }, [canGoToPreview, draft, previewMutation, setStep, setError]);

  const execute = useCallback(() => {
    setIsExecuting(true);
    setError(null);
    setStep('executing');
    prepareMutation.mutate({
      config: {
        sourceOrgId: draft.sourceOrgId,
        targetOrgId: draft.targetOrgId,
        selectedObjects: draft.selectedObjects,
        parentObjects: draft.parentObjects,
      },
    });
  }, [draft, prepareMutation, setIsExecuting, setError, setStep]);

  const reset = useCallback(() => {
    setDraft(INITIAL_DRAFT);
    setStep('orgs');
    setPreview(null);
    setResult(null);
    setIsExecuting(false);
    setError(null);
    previewMutation.reset();
    prepareMutation.reset();
    syncMutation.reset();
  }, [
    setDraft,
    setStep,
    setPreview,
    setResult,
    setIsExecuting,
    setError,
    previewMutation,
    prepareMutation,
    syncMutation,
  ]);

  const state: QuickSyncFlowState = {
    step,
    sourceOrgId: draft.sourceOrgId,
    targetOrgId: draft.targetOrgId,
    selectedObjects: draft.selectedObjects,
    parentObjects: draft.parentObjects,
    preview,
    result,
    isExecuting,
    error,
  };

  return {
    state,
    setSourceOrg,
    setTargetOrg,
    addObject,
    removeObject,
    addParentObject,
    goToObjects,
    goToPreview,
    execute,
    reset,
    canGoToObjects,
    canGoToPreview,
  };
}
