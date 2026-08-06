import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
  SeedTemplate,
  SeedExecutionResult,
  SeedObjectConfig,
  FieldRuleConfig,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
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

/**
 * Hook managing the Quick Seed state machine.
 *
 * Phases: idle -> selectOrg -> executing -> results.
 * Uses the template's field rules directly as Smart Suggest defaults (QSEED-02).
 */
export function useQuickSeed(): QuickSeedState {
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

  const startQuickSeed = useCallback((template: SeedTemplate, counts: Record<string, number>) => {
    setSelectedTemplate(template);
    setCustomizedCounts(counts);
    setPhase('selectOrg');
    setError(null);
    setExecutionResult(undefined);
    setElapsedMs(0);
  }, []);

  const selectOrg = useCallback((orgId: string) => {
    setSelectedOrgId(orgId);
  }, []);

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

  /* Derive object progress from template */
  const objectProgress: ObjectProgress[] = useMemo(() => {
    if (!selectedTemplate) return [];
    return selectedTemplate.objects.map(
      (obj): ObjectProgress => ({
        objectApiName: obj.objectApiName,
        total: customizedCounts[obj.objectApiName] ?? obj.recordCount,
        completed: 0,
        failed: 0,
        status: isRunning ? 'running' : 'pending',
      }),
    );
  }, [selectedTemplate, customizedCounts, isRunning]);

  const overallPercent = isRunning ? 50 : executionResult ? 100 : 0;

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
