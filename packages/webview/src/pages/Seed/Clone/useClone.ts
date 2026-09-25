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

/** `seed:clone:error` as the extension posts it; read defensively. */
type CloneErrorMessage = BaseMessage & { payload?: { code?: unknown } };

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

/**
 * The codes `seed:clone:error` carries for a request refused before either org
 * is read: by the bridge's check of the payload, or, for a run, because it
 * names no preview or is not for the orgs of the one it names.
 */
const REFUSAL_CODES = ['INVALID_PAYLOAD', 'NOT_PREVIEWED', 'PREVIEWED_FOR_OTHER_ORGS'];

/** The orgs and the objects a preview was asked for: what the run that follows it goes to. */
interface PreviewedFor {
  sourceOrgId: string;
  targetOrgId: string;
  objects: CloneObjectConfig[];
}

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
  /**
   * Run the clone the preview shown was made for, into the orgs it was made
   * for; while it runs, show it instead of sending another.
   */
  handleExecute: () => void;
  /** Go to a step; one left while its preview is prepared sets that preview aside. */
  setStep: (step: CloneStep) => void;
  /** Dismiss the error, and nothing else: the orgs, the objects and the preview stay. */
  dismissError: () => void;
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
  const [previewedFor, setPreviewedFor] = useState<PreviewedFor | null>(null);

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

  // The execute step shows a run: the one in flight, or its result. Reached
  // any other way it stood empty. A run that ended without a result —
  // refused, failed, out of time — goes back to the preview it was made
  // from, where the banner says why and Execute can be tried again.
  if (step === 'execute' && executionStatus !== 'executing' && executionResult === null) {
    setStep(previewResult ? 'preview' : 'objects');
  }
  // The preview step shows a preview: the one being prepared, or its answer.
  // One that ended without an answer — refused, failed, out of time — goes
  // back to the objects, where the banner says why and Next asks again.
  if (step === 'preview' && executionStatus !== 'previewing' && previewResult === null) {
    setStep('objects');
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

  /**
   * Set the preview aside, keeping what was picked for Next to preview again:
   * the orgs it was made for are no longer the ones the run would go to.
   */
  const dropPreview = useCallback(() => {
    previewMutation.reset();
    setPreviewedFor(null);
    setPreviewResult(null);
    setExecutionStatus('idle');
    setStep((current) => (current === 'preview' || current === 'execute' ? 'objects' : current));
  }, [previewMutation]);

  /**
   * Go to a step. Another step gone to while the preview is prepared sets that
   * preview aside: answered after the wizard went back, it would bring the
   * wizard forward again, to a preview of what was picked before.
   */
  const goToStep = useCallback(
    (next: CloneStep) => {
      if (executionStatus === 'previewing' && next !== 'preview') dropPreview();
      setStep(next);
    },
    [executionStatus, dropPreview],
  );

  // A preview or a run the bridge refuses comes back on seed:clone:error with
  // the check's own English — "Invalid payload — targetOrgId: String must
  // contain at least 1 character(s)" — which the mutation hands on as it is.
  // Its code is what the wizard shows, in words; any other failure there
  // carries what the org said, and stays as it came. A run the extension
  // refuses because it names no preview, or is not for the orgs of the one it
  // names, takes the preview shown with it: Next previews again.
  const previewRequestId = previewMutation.requestId;
  useMessageListener<CloneErrorMessage>('seed:clone:error', (message) => {
    const code = message.payload?.code;
    if (typeof code !== 'string' || !REFUSAL_CODES.includes(code)) return;
    const refused =
      (executionStatus === 'previewing' && message.correlationId === previewRequestId) ||
      (executionStatus === 'executing' && message.correlationId === executeRequestId);
    if (!refused) return;
    setError(t(`seed.clone.error.${code}`));
    if (code === 'INVALID_PAYLOAD') setExecutionStatus('error');
    else dropPreview();
  });

  // The target is the org selected in SandForge, which can change at any
  // time, and the run goes to the one its preview was made for: read on every
  // render, an org selected after the preview took the run. Set aside, the
  // preview says why. A run sent or ended keeps it: it went where the preview
  // said.
  useEffect(() => {
    if (!previewedFor || previewedFor.targetOrgId === targetOrgId) return;
    if (executionStatus === 'executing' || executionResult !== null) return;
    dropPreview();
    setError(t('seed.clone.wizard.targetChanged'));
  }, [targetOrgId, previewedFor, executionStatus, executionResult, dropPreview, t]);

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
      setPreviewedFor(null);
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
    // The wizard keeps Next off without both orgs; asked anyway, nothing is
    // sent that the bridge would refuse.
    if (!sourceOrgId || !targetOrgId) {
      setError(t('seed.clone.wizard.needsBothOrgs'));
      return;
    }
    // A new preview is a new clone: the last run's result is not its own.
    setExecutionResult(null);
    executeMutation.reset();
    setPreviewResult(null);
    setExecutionStatus('previewing');
    // Shown being prepared on its own step: left on the objects until the
    // answer came, the wizard said nothing of it, and Next sent it again.
    setStep('preview');
    setError(null);
    // What the run that follows goes to, whatever is selected by then.
    setPreviewedFor({ sourceOrgId, targetOrgId, objects: selectedObjects });
    previewMutation.reset();
    previewMutation.mutate({
      sourceOrgId,
      targetOrgId,
      objects: selectedObjects,
    });
  }, [sourceOrgId, targetOrgId, selectedObjects, previewMutation, executeMutation, t]);

  /** Run the clone of the preview shown, into the orgs it was made for. */
  const handleExecute = useCallback(() => {
    // One run at a time: asked for again while it runs, the wizard shows it.
    if (executionStatus === 'executing') {
      setStep('execute');
      return;
    }
    // Every run names the preview it follows: the extension refuses one that
    // names none.
    const previewId = previewMutation.requestId;
    if (!previewedFor || !previewResult || !previewId) return;
    // Its results stay on screen when another org is selected; back on its
    // preview, Execute would have written to the org selected now.
    if (previewedFor.targetOrgId !== targetOrgId) {
      dropPreview();
      setError(t('seed.clone.wizard.targetChanged'));
      return;
    }
    setExecutionResult(null);
    setExecutionStatus('executing');
    setError(null);
    setStep('execute');
    executeMutation.reset();
    // The extension refuses a run that is not for the orgs of the preview it names.
    executeMutation.mutate({
      sourceOrgId: previewedFor.sourceOrgId,
      targetOrgId: previewedFor.targetOrgId,
      objects: previewedFor.objects,
      previewId,
    });
  }, [
    executionStatus,
    previewedFor,
    previewResult,
    targetOrgId,
    dropPreview,
    executeMutation,
    previewMutation.requestId,
    t,
  ]);

  /** Dismiss the error, and nothing else. */
  const dismissError = useCallback(() => {
    setError(null);
    // A describe's failure is copied in whenever no error is shown: left on
    // the mutation, it came straight back.
    if (describeMutation.error) describeMutation.reset();
  }, [describeMutation]);

  /** Reset all state back to initial. */
  const reset = useCallback(() => {
    setSourceOrgId('');
    setSourceObjects([]);
    setSelectedObjects([]);
    setPreviewResult(null);
    setPreviewedFor(null);
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
    setStep: goToStep,
    dismissError,
    reset,
  };
}
