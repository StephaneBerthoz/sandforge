import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
  SalesforceOrg,
  SeedTemplate,
  SeedExecutionResult,
  SeedObjectConfig,
  FieldRuleConfig,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { useOrgStore } from '../../stores/useOrgStore';
import type { ObjectProgress } from './Step7_Execute';

/**
 * Phase of the Quick Seed state machine: the gallery, then one confirmation —
 * the counts, the org, Start — then the run and its results.
 */
export type QuickSeedPhase = 'idle' | 'confirm' | 'executing' | 'results';

/**
 * Whether an org is one a seed may be aimed at without being asked for: it is
 * connected, and it is not a production org. A Developer Edition is registered
 * as production, as the platform says it is not a sandbox, and holds nobody's
 * business: Seed is for it as for a sandbox, as Production Guard reads it.
 */
export function isSeedTargetCandidate(org: SalesforceOrg): boolean {
  if (org.status !== 'connected') return false;
  if (org.orgType !== 'Production') return true;
  return org.metadata?.edition?.trim().toLowerCase() === 'developer edition';
}

/** State and actions for the Quick Seed flow. */
export interface QuickSeedState {
  /** Current phase. */
  phase: QuickSeedPhase;
  /** Selected template (set after gallery confirm). */
  selectedTemplate: SeedTemplate | null;
  /** Customized record counts by object API name. */
  customizedCounts: Record<string, number>;
  /** Selected target org ID. */
  selectedOrgId: string;
  /** Whether execution is in flight. */
  isRunning: boolean;
  /** Execution result. */
  executionResult: SeedExecutionResult | undefined;
  /** Per-object progress entries. */
  objectProgress: ObjectProgress[];
  /** Overall percent complete. */
  overallPercent: number;
  /** Elapsed milliseconds since execution started. */
  elapsedMs: number;
  /** Error message, if any. */
  error: string | null;

  /**
   * Id of the running seed once the extension has reported progress for it,
   * which is when it can be stopped; null otherwise. It is the id of the
   * seed:execute request this hook sent.
   */
  operationId: string | null;

  /** Open the confirmation of a template, with the counts given or its own. */
  startQuickSeed: (template: SeedTemplate, counts?: Record<string, number>) => void;
  /** Set how many records of an object the run writes. */
  setCount: (objectApiName: string, count: number) => void;
  /** Set the target org ID. */
  selectOrg: (orgId: string) => void;
  /** Trigger seed execution. */
  execute: () => void;
  /**
   * Stop the running seed, as the wizard's Cancel does: before its next
   * object or batch, what it wrote staying in the org. Nothing is sent before
   * the run has reported progress, as it is not registered until then.
   */
  cancel: () => void;
  /** Back to the gallery. The org chosen stays chosen for the next template. */
  reset: () => void;
  /** Set or clear error. */
  setError: (e: string | null) => void;
}

/** Landing instructions for a Quick Seed opened from another page. */
export interface QuickSeedOptions {
  /** Org the caller already named, preselected on the confirmation. */
  initialOrgId?: string;
}

/**
 * Hook managing the Quick Seed state machine.
 *
 * Phases: idle -> confirm -> executing -> results.
 * Uses the template's field rules directly as Smart Suggest defaults.
 */
export function useQuickSeed(options: QuickSeedOptions = {}): QuickSeedState {
  const [phase, setPhase] = useState<QuickSeedPhase>('idle');
  const [selectedTemplate, setSelectedTemplate] = useState<SeedTemplate | null>(null);
  const [customizedCounts, setCustomizedCounts] = useState<Record<string, number>>({});
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [executionResult, setExecutionResult] = useState<SeedExecutionResult | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const executeMutation = useBridgeMutation<SeedExecutionResult>('seed:execute', {
    responseType: 'seed:execute:response',
    // The run goes on in the extension until it ends, and answers then: held
    // to two minutes, a long seed lost its page and said "Try again" while
    // it went on writing.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  const isRunning = executeMutation.loading;

  /* Track elapsed time while running */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (isRunning) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 250);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning]);

  /* Transition to results on execution complete */
  useEffect(() => {
    if (executeMutation.data) {
      setExecutionResult(executeMutation.data);
      setPhase('results');
    }
  }, [executeMutation.data]);

  /* Surface bridge errors */
  useEffect(() => {
    if (executeMutation.error) {
      setError(executeMutation.error);
    }
  }, [executeMutation.error]);

  const { initialOrgId } = options;
  /* The org named by the caller answers the first template pick only. After
     Back, the user has moved past that instruction, and reapplying it would
     override the org they chose in the meantime. */
  const initialOrgConsumedRef = useRef(false);

  const startQuickSeed = useCallback(
    (template: SeedTemplate, counts: Record<string, number> = {}) => {
      setSelectedTemplate(template);
      setCustomizedCounts(counts);
      /* The org is preselected, so that a first seed is a click on Start:
         the one whoever opened this flow named, on the first template only;
         else the one chosen for an earlier template; else the org selected in
         the panel, unless it is a production org. Each is read at this moment,
         and only while it is still connected: a stale id would aim the write
         at an org the confirmation no longer offers. The confirmation still
         shows, and the run still needs a click on Start. */
      const orgs = useOrgStore.getState().orgs;
      const connected = (id: string | null | undefined): boolean =>
        !!id && orgs.some((org) => org.id === id && org.status === 'connected');
      const named = initialOrgConsumedRef.current ? undefined : initialOrgId;
      initialOrgConsumedRef.current = true;
      setSelectedOrgId((chosen) => {
        if (named && connected(named)) return named;
        if (connected(chosen)) return chosen;
        const panelOrgId = useOrgStore.getState().selectedOrgId;
        const panelOrg = orgs.find((org) => org.id === panelOrgId);
        return panelOrg && isSeedTargetCandidate(panelOrg) ? panelOrg.id : '';
      });
      setPhase('confirm');
      setError(null);
      setExecutionResult(undefined);
      setElapsedMs(0);
    },
    [initialOrgId],
  );

  const setCount = useCallback((objectApiName: string, count: number) => {
    setCustomizedCounts((prev) => ({ ...prev, [objectApiName]: Math.max(1, count) }));
  }, []);

  const selectOrg = useCallback((orgId: string) => {
    setSelectedOrgId(orgId);
  }, []);

  // The extension reports each object as it starts and the records written so
  // far. The bar read a fixed 50% for the whole run and every row 0/N.
  // Read for this run only: the operationId is the id of the seed:execute
  // request, so a new run starts with no figure of its own, and another run's
  // events (every panel receives them) never move this bar.
  const { getProgress } = useOperationProgress();
  const runId = executeMutation.requestId;
  const progress = (isRunning && runId !== null ? getProgress(runId) : undefined) ?? null;

  const execute = useCallback(() => {
    if (!selectedTemplate || !selectedOrgId) return;

    const objects: SeedObjectConfig[] = selectedTemplate.objects.map((obj) => ({
      objectApiName: obj.objectApiName,
      recordCount: customizedCounts[obj.objectApiName] ?? obj.recordCount,
      fieldRules: obj.fieldRules.map((r) => ({
        fieldApiName: r.fieldApiName,
        ruleType: r.ruleType,
        config: r.config as FieldRuleConfig,
      })),
      excludedFields: obj.excludedFields,
      insertOrder: obj.insertOrder,
      batchSize: obj.batchSize,
    }));

    const template: SeedTemplate = {
      ...selectedTemplate,
      objects,
    };

    setPhase('executing');
    setElapsedMs(0);

    executeMutation.mutate({
      orgId: selectedOrgId,
      template: template as unknown as Record<string, unknown>,
    });
  }, [selectedTemplate, selectedOrgId, customizedCounts, executeMutation]);

  const sendMessage = useSendMessage();
  const operationId = progress ? runId : null;
  const cancel = useCallback(() => {
    if (!operationId) return;
    sendMessage(buildMessage<{ operationId: string }>('execution:abort', { operationId }));
  }, [operationId, sendMessage]);

  const reset = useCallback(() => {
    setPhase('idle');
    setSelectedTemplate(null);
    setCustomizedCounts({});
    setExecutionResult(undefined);
    setError(null);
    setElapsedMs(0);
    executeMutation.reset();
  }, [executeMutation]);

  /* Derive object progress from the template and the live figures */
  const objectProgress: ObjectProgress[] = useMemo(() => {
    if (!selectedTemplate) return [];
    const totals = selectedTemplate.objects.map(
      (obj) => customizedCounts[obj.objectApiName] ?? obj.recordCount,
    );
    const currentIndex = progress
      ? selectedTemplate.objects.findIndex((obj) =>
          progress.currentStep.endsWith(` ${obj.objectApiName}`),
        )
      : -1;
    let before = 0;
    return selectedTemplate.objects.map((obj, index): ObjectProgress => {
      const total = totals[index];
      let status: ObjectProgress['status'] = isRunning ? 'running' : 'pending';
      let completed = 0;
      if (currentIndex !== -1 && progress) {
        if (index < currentIndex) {
          status = 'done';
          completed = total;
        } else if (index === currentIndex) {
          completed = Math.min(total, Math.max(0, progress.processedRecords - before));
        } else {
          status = 'pending';
        }
      }
      before += total;
      return { objectApiName: obj.objectApiName, total, completed, failed: 0, status };
    });
  }, [selectedTemplate, customizedCounts, isRunning, progress]);

  const overallPercent = progress ? progress.percentage : executionResult ? 100 : 0;

  return {
    phase,
    selectedTemplate,
    customizedCounts,
    selectedOrgId,
    isRunning,
    executionResult,
    objectProgress,
    overallPercent,
    elapsedMs,
    error,
    operationId,
    startQuickSeed,
    setCount,
    selectOrg,
    execute,
    cancel,
    reset,
    setError,
  };
}
