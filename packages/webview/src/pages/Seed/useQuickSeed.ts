import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
  SeedTemplate,
  SeedExecutionResult,
  SeedObjectConfig,
  FieldRuleConfig,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useOrgStore } from '../../stores/useOrgStore';
import type { ObjectProgress } from './Step7_Execute';

/** Phase of the Quick Seed state machine. */
export type QuickSeedPhase = 'idle' | 'selectOrg' | 'executing' | 'results';

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

  /** Enter Quick Seed mode with a template and customized counts. */
  startQuickSeed: (template: SeedTemplate, counts: Record<string, number>) => void;
  /** Set the target org ID. */
  selectOrg: (orgId: string) => void;
  /** Trigger seed execution. */
  execute: () => void;
  /** Reset to idle. */
  reset: () => void;
  /** Set or clear error. */
  setError: (e: string | null) => void;
}

/** Landing instructions for a Quick Seed opened from another page. */
export interface QuickSeedOptions {
  /** Org the caller already named, preselected on the selection step. */
  initialOrgId?: string;
}

/**
 * Hook managing the Quick Seed state machine.
 *
 * Phases: idle -> selectOrg -> executing -> results.
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
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
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
    (template: SeedTemplate, counts: Record<string, number>) => {
      setSelectedTemplate(template);
      setCustomizedCounts(counts);
      /* Whoever opened this flow already named an org; preselecting it saves the
         user from naming it twice. Read at this moment, and only while it is
         still connected: a stale id would aim the write at an org the selection
         step no longer offers. The step still shows, and the run still needs a
         click on Start. */
      if (initialOrgId && !initialOrgConsumedRef.current) {
        initialOrgConsumedRef.current = true;
        const stillConnected = useOrgStore
          .getState()
          .orgs.some((org) => org.id === initialOrgId && org.status === 'connected');
        if (stillConnected) {
          setSelectedOrgId(initialOrgId);
        }
      }
      setPhase('selectOrg');
      setError(null);
      setExecutionResult(undefined);
      setElapsedMs(0);
    },
    [initialOrgId],
  );

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

  const reset = useCallback(() => {
    setPhase('idle');
    setSelectedTemplate(null);
    setCustomizedCounts({});
    setSelectedOrgId('');
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
    startQuickSeed,
    selectOrg,
    execute,
    reset,
    setError,
  };
}
