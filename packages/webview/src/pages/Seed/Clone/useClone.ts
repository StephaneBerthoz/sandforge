import { useState, useCallback } from 'react';
import type { TFunction } from 'i18next';
import type {
  CloneObjectConfig,
  ClonePreviewResult,
  CloneExecutionResult,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';

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
 * @param _t - i18next translation function for error messages (reserved for future use).
 * @param targetOrgId - The current target org ID from the org store.
 */
export function useClone(_t: TFunction, targetOrgId: string): UseCloneReturn {
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
  }>('seed:clone:describe-source');

  const previewMutation = useBridgeMutation<ClonePreviewResult>('seed:clone:preview');

  const executeMutation = useBridgeMutation<CloneExecutionResult>('seed:clone:execute');

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
