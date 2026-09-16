import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  CloneObjectConfig,
  ClonePreviewResult,
  CloneExecutionResult,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { useMessageListener } from '../../../hooks/useMessageBus';

/** Clone wizard step identifiers. */
export type CloneStep = 'source' | 'objects' | 'preview' | 'execute';

/** Source object descriptor returned by describe-source. */
export interface SourceObjectInfo {
  /** Salesforce object API name. */
  name: string;
  /** Human-readable label. */
  label: string;
}

/** Execution status for the clone pipeline. */
export type CloneExecutionStatus = 'idle' | 'previewing' | 'executing' | 'complete' | 'error';

/** `operation:failed` as the extension posts it; read defensively. */
type OperationFailedMessage = BaseMessage & {
  payload?: { operationId?: unknown; error?: unknown; code?: unknown };
};

/**
 * The failure codes SeedCloneHandler attaches to `operation:failed`.
 *
 * The message next to them stays English on purpose — the output channel and
 * the fix-suggestion table read it — so the code is what the wizard shows,
 * translated.
 */
const CLONE_ERROR_CODES = [
  'PRODUCTION_CONFIRMATION_DECLINED',
  'PRODUCTION_GUARD_BLOCKED',
  'CLONE_FAILED',
];

/** Return type for the useClone hook. */
export interface UseCloneReturn {
  /** Currently selected source org ID. */
  sourceOrgId: string;
  /** Target org ID (from context). */
  targetOrgId: string;
  /** Objects available on the source org. */
  sourceObjects: SourceObjectInfo[];
  /** Objects selected for cloning with optional WHERE clauses. */
  selectedObjects: CloneObjectConfig[];
  /** Preview result from seed:clone:preview. */
  previewResult: ClonePreviewResult | null;
  /** Current execution status. */
  executionStatus: CloneExecutionStatus;
  /** Final execution result after clone completes. */
  executionResult: CloneExecutionResult | null;
  /** Current wizard step. */
  step: CloneStep;
  /** Whether source objects are loading. */
  loadingSource: boolean;
  /** Whether preview is loading. */
  loadingPreview: boolean;
  /** Error message, if any. */
  error: string | null;
  /** Handle source org selection -- fetches available objects. */
  handleSourceOrgSelected: (orgId: string) => void;
  /** Toggle an object in the selection. */
  handleObjectToggle: (objectApiName: string) => void;
  /** Update the WHERE clause for a specific object. */
  handleWhereClauseChange: (objectApiName: string, whereClause: string) => void;
  /** Request a preview of the clone operation. */
  handlePreview: () => void;
  /** Execute the clone operation. */
  handleExecute: () => void;
  /** Set wizard step manually. */
  setStep: (step: CloneStep) => void;
  /** Reset all clone state. */
  reset: () => void;
}

/**
 * Hook managing all clone wizard state: source/target org selection,
 * object selection with optional WHERE filters, preview, execution,
 * and step navigation.
 *
 * @param targetOrgId - The current target org ID from the org store.
 * @param initialSourceOrgId - Source org to select on open (Home's clone
 *   recommendation). It is described, never previewed or run.
 */
export function useClone(targetOrgId: string, initialSourceOrgId?: string): UseCloneReturn {
  const { t } = useTranslation();
  const [sourceOrgId, setSourceOrgId] = useState('');
  const [sourceObjects, setSourceObjects] = useState<SourceObjectInfo[]>([]);
  const [selectedObjects, setSelectedObjects] = useState<CloneObjectConfig[]>([]);
  const [previewResult, setPreviewResult] = useState<ClonePreviewResult | null>(null);
  const [executionStatus, setExecutionStatus] = useState<CloneExecutionStatus>('idle');
  const [executionResult, setExecutionResult] = useState<CloneExecutionResult | null>(null);
  const [step, setStep] = useState<CloneStep>('source');
  const [error, setError] = useState<string | null>(null);

  const describeMutation = useBridgeMutation<{
    objects: Array<{ apiName: string; label: string; recordCount: number }>;
  }>('seed:clone:describe-source', { errorType: 'seed:clone:error' });

  const previewMutation = useBridgeMutation<ClonePreviewResult>('seed:clone:preview', {
    errorType: 'seed:clone:error',
  });

  const executeMutation = useBridgeMutation<CloneExecutionResult>('seed:clone:execute', {
    // Only a refused payload comes back here. Every later failure, the
    // production guard blocking or its confirmation being declined included,
    // is reported on operation:failed alone: see the listener below.
    errorType: 'seed:clone:error',
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  /* ------------------------------------------------------------------ */
  /* Sync mutation results into local state                              */
  /* ------------------------------------------------------------------ */
  if (
    describeMutation.data &&
    sourceObjects.length === 0 &&
    describeMutation.data.objects.length > 0
  ) {
    setSourceObjects(
      describeMutation.data.objects.map((o) => ({ name: o.apiName, label: o.label })),
    );
  }

  if (previewMutation.data && previewResult === null) {
    setPreviewResult(previewMutation.data);
    setExecutionStatus('idle');
    setStep('preview');
  }

  if (executeMutation.data && executionResult === null) {
    setExecutionResult(executeMutation.data);
    setExecutionStatus('complete');
    setStep('execute');
  }

  if (describeMutation.error && error === null) {
    setError(describeMutation.error);
  }
  if (previewMutation.error && executionStatus === 'previewing') {
    setExecutionStatus('error');
    if (error === null) setError(previewMutation.error);
  }
  if (executeMutation.error && executionStatus === 'executing') {
    setExecutionStatus('error');
    if (error === null) setError(executeMutation.error);
  }

  // SeedCloneHandler uses the execute request id as the operationId and reports
  // an execution failure on operation:failed only. Nothing listened here, so a
  // failed clone, or a declined production confirmation, left the wizard on
  // "executing" for 120 s and then showed the raw timeout.
  const executeRequestId = executeMutation.requestId;
  useMessageListener<OperationFailedMessage>('operation:failed', (message) => {
    if (executionStatus !== 'executing' || executeRequestId === null) return;
    const failed = message.payload;
    if (failed?.operationId !== executeRequestId) return;
    executeMutation.reset();
    setExecutionStatus('error');
    const code = typeof failed.code === 'string' ? failed.code : '';
    const known = CLONE_ERROR_CODES.includes(code);
    const headline = known ? t(`seed.clone.error.${code}`) : t('seed.clone.error.generic');
    // The host text is written in English for the logs. It is worth reading
    // only when it carries what the org said: the two guard refusals are
    // SandForge's own sentences and their translation already says all of it.
    const hostMessage = typeof failed.error === 'string' ? failed.error : '';
    setError(
      hostMessage && (!known || code === 'CLONE_FAILED')
        ? `${headline} ${t('seed.clone.error.detail', { detail: hostMessage })}`
        : headline,
    );
  });

  /* ------------------------------------------------------------------ */
  /* Handlers                                                            */
  /* ------------------------------------------------------------------ */

  /** Select a source org and fetch its describable objects. */
  const handleSourceOrgSelected = useCallback(
    (orgId: string) => {
      setSourceOrgId(orgId);
      setSourceObjects([]);
      setSelectedObjects([]);
      setPreviewResult(null);
      setExecutionResult(null);
      setExecutionStatus('idle');
      setError(null);
      describeMutation.reset();
      previewMutation.reset();
      executeMutation.reset();
      describeMutation.mutate({ sourceOrgId: orgId });
    },
    [describeMutation, previewMutation, executeMutation],
  );

  // Opened on a recommended source: select it once, which describes its
  // objects. The user still picks objects, previews, and passes the production
  // guard before anything is written.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !initialSourceOrgId) return;
    preselected.current = true;
    handleSourceOrgSelected(initialSourceOrgId);
  }, [initialSourceOrgId, handleSourceOrgSelected]);

  /** Toggle an object in/out of the selection. */
  const handleObjectToggle = useCallback((objectApiName: string) => {
    setSelectedObjects((prev) => {
      const exists = prev.find((o) => o.objectApiName === objectApiName);
      if (exists) {
        return prev.filter((o) => o.objectApiName !== objectApiName);
      }
      return [...prev, { objectApiName }];
    });
  }, []);

  /** Update the WHERE clause for a specific selected object. */
  const handleWhereClauseChange = useCallback((objectApiName: string, whereClause: string) => {
    setSelectedObjects((prev) =>
      prev.map((o) =>
        o.objectApiName === objectApiName ? { ...o, whereClause: whereClause || undefined } : o,
      ),
    );
  }, []);

  /** Request a preview of the clone operation. */
  const handlePreview = useCallback(() => {
    if (selectedObjects.length === 0) return;
    setPreviewResult(null);
    setExecutionStatus('previewing');
    setError(null);
    previewMutation.reset();
    previewMutation.mutate({
      sourceOrgId,
      targetOrgId,
      objects: selectedObjects,
    });
  }, [sourceOrgId, targetOrgId, selectedObjects, previewMutation]);

  /** Execute the clone operation. */
  const handleExecute = useCallback(() => {
    setExecutionResult(null);
    setExecutionStatus('executing');
    setError(null);
    executeMutation.reset();
    executeMutation.mutate({
      sourceOrgId,
      targetOrgId,
      objects: selectedObjects,
    });
  }, [sourceOrgId, targetOrgId, selectedObjects, executeMutation]);

  /** Reset all state back to initial. */
  const reset = useCallback(() => {
    setSourceOrgId('');
    setSourceObjects([]);
    setSelectedObjects([]);
    setPreviewResult(null);
    setExecutionStatus('idle');
    setExecutionResult(null);
    setStep('source');
    setError(null);
    describeMutation.reset();
    previewMutation.reset();
    executeMutation.reset();
  }, [describeMutation, previewMutation, executeMutation]);

  return {
    sourceOrgId,
    targetOrgId,
    sourceObjects,
    selectedObjects,
    previewResult,
    executionStatus,
    executionResult,
    step,
    loadingSource: describeMutation.loading,
    loadingPreview: previewMutation.loading,
    error,
    handleSourceOrgSelected,
    handleObjectToggle,
    handleWhereClauseChange,
    handlePreview,
    handleExecute,
    setStep,
    reset,
  };
}
