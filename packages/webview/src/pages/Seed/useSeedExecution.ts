import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { SeedExecutionResult, SeedTemplate, SeedObjectConfig } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { ObjectProgress } from './Step7_Execute';

/** Return type for the useSeedExecution hook. */
export interface SeedExecutionState {
  /** Whether the seed execution mutation is in flight. */
  isRunning: boolean;
  /** Execution result returned by the backend. */
  executionResult: SeedExecutionResult | undefined;
  /** Trigger seed execution with the current configuration. */
  handleExecute: () => void;
  /** Per-object progress entries derived from selected objects and volumes. */
  objectProgress: ObjectProgress[];
  /** Overall completion, 0-100, from the live `operation:progress` stream. */
  overallPercent: number;
  /** Wall-clock since the run started, or 0 when idle. */
  elapsedMs: number;
  /** Step label reported by the extension, e.g. "Bulk insert Contact". */
  progressLabel: string | null;
  /** Error from the execution mutation, if any. */
  executionError: string | undefined;
  /** Step to navigate to when execution completes (3), or null. */
  executionCompletedStep: number | null;
  /**
   * Id of the running seed once the extension has reported progress for it,
   * which is when it can be stopped; null otherwise. It is the id of the
   * seed:execute request this hook sent.
   */
  operationId: string | null;
}

/**
 * Hook managing seed execution and progress tracking for the Seed wizard.
 *
 * Handles the execute mutation and tracks per-object progress.
 */
export function useSeedExecution(
  selectedOrgId: string,
  selectedObjects: string[],
  volumes: Record<string, { count: number; batchSize: number }>,
  fieldConfigs: ObjectFieldConfig[],
  t: TFunction,
): SeedExecutionState {
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [executionResult, setExecutionResult] = useState<SeedExecutionResult | undefined>();
  const [executionCompletedStep, setExecutionCompletedStep] = useState<number | null>(null);
  /** Set when the run is fired, so elapsed time is real rather than hardcoded 0. */
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const executeSeedMutation = useBridgeMutation<SeedExecutionResult>('seed:execute', {
    responseType: 'seed:execute:response',
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  const isRunning = executeSeedMutation.loading;

  /* Navigate to results step on completion */
  useEffect(() => {
    if (executeSeedMutation.data) {
      setExecutionResult(executeSeedMutation.data);
      setExecutionCompletedStep(3);
    }
  }, [executeSeedMutation.data]);

  /* Surface bridge errors as notifications */
  useEffect(() => {
    const bridgeError = executeSeedMutation.error;
    if (bridgeError) {
      addNotification({
        level: 'error',
        title: t('seed.title'),
        message: bridgeError,
        autoDismissMs: 5000,
      });
    }
  }, [executeSeedMutation.error, addNotification, t]);

  const handleExecute = useCallback(() => {
    if (!selectedOrgId) return;

    const template: SeedTemplate = {
      id: crypto.randomUUID(),
      name: 'seed-from-ui',
      description: 'Seed from SandForge UI',
      version: 1,
      strategy: 'faker',
      objects: selectedObjects.map((apiName, index): SeedObjectConfig => {
        const vol = volumes[apiName] ?? { count: 100, batchSize: 200 };
        const objConfig = fieldConfigs.find((c) => c.objectApiName === apiName);
        return {
          objectApiName: apiName,
          recordCount: vol.count,
          batchSize: vol.batchSize,
          insertOrder: index,
          excludedFields: [],
          fieldRules: (objConfig?.fields ?? [])
            // A lookup points at records this run inserts: an optional one to
            // an object the run does not seed, such as OwnerId to User, made
            // the run refuse the whole template. It is left for the org to
            // default. A required one is still sent, so the run is refused
            // before it writes anything rather than failing every record of
            // the object on REQUIRED_FIELD_MISSING.
            .filter(
              (f) =>
                f.ruleType !== 'reference' ||
                f.required ||
                typeof f.config['referenceObject'] !== 'string' ||
                selectedObjects.includes(f.config['referenceObject']),
            )
            .map((f) => ({
              fieldApiName: f.fieldApiName,
              fieldType: f.type,
              ruleType: f.ruleType,
              config: f.config as import('@sandforge/shared').FieldRuleConfig,
            })),
        };
      }),
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setStartedAt(Date.now());
    executeSeedMutation.mutate({
      orgId: selectedOrgId,
      template: template as unknown as Record<string, unknown>,
    });
  }, [selectedOrgId, selectedObjects, volumes, fieldConfigs, executeSeedMutation]);

  // Live figures from the extension, for this run only: SeedOpsHandler uses the
  // request id as the operationId, and every panel receives every run's events.
  const { getProgress } = useOperationProgress();
  const runId = executeSeedMutation.requestId;
  const progress = (isRunning && runId !== null ? getProgress(runId) : undefined) ?? null;
  const elapsedMs = useElapsedSince(isRunning ? startedAt : null);

  const objectProgress: ObjectProgress[] = useMemo(() => {
    // The stream reports one overall figure plus the step it is on, not a
    // per-object breakdown. Deriving position from the step name states what
    // the extension actually knows, instead of inventing a number per row —
    // every row previously read "0/N · running" for the whole run.
    const currentIndex = progress?.currentStep
      ? selectedObjects.findIndex((name) => progress.currentStep.includes(name))
      : -1;

    return selectedObjects.map((o, index): ObjectProgress => {
      const total = volumes[o]?.count ?? 100;
      let status: ObjectProgress['status'];
      if (currentIndex === -1) {
        status = isRunning ? 'running' : 'pending';
      } else if (index < currentIndex) {
        status = 'done';
      } else if (index === currentIndex) {
        status = 'running';
      } else {
        status = 'pending';
      }
      return {
        objectApiName: o,
        total,
        completed:
          status === 'done' ? total : status === 'running' ? (progress?.processedRecords ?? 0) : 0,
        failed: 0,
        status,
      };
    });
  }, [selectedObjects, volumes, isRunning, progress]);

  return {
    isRunning,
    executionResult,
    handleExecute,
    objectProgress,
    overallPercent: progress?.percentage ?? 0,
    elapsedMs,
    progressLabel: progress?.currentStep ?? null,
    executionError: executeSeedMutation.error ?? undefined,
    executionCompletedStep,
    operationId: progress ? runId : null,
  };
}
