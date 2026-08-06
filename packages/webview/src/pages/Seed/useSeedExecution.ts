import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { SeedExecutionResult, SeedTemplate, SeedObjectConfig } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
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
  /** Error from the execution mutation, if any. */
  executionError: string | undefined;
  /** Step to navigate to when execution completes (3), or null. */
  executionCompletedStep: number | null;
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
          fieldRules: (objConfig?.fields ?? []).map((f) => ({
            fieldApiName: f.fieldApiName,
            ruleType: f.ruleType,
            config: f.config as import('@sandforge/shared').FieldRuleConfig,
          })),
        };
      }),
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    executeSeedMutation.mutate({
      orgId: selectedOrgId,
      template: template as unknown as Record<string, unknown>,
    });
  }, [selectedOrgId, selectedObjects, volumes, fieldConfigs, executeSeedMutation]);

  const objectProgress: ObjectProgress[] = useMemo(
    () =>
      selectedObjects.map(
        (o): ObjectProgress => ({
          objectApiName: o,
          total: volumes[o]?.count ?? 100,
          completed: 0,
          failed: 0,
          status: isRunning ? 'running' : 'pending',
        }),
      ),
    [selectedObjects, volumes, isRunning],
  );

  return {
    isRunning,
    executionResult,
    handleExecute,
    objectProgress,
    executionError: executeSeedMutation.error ?? undefined,
    executionCompletedStep,
  };
}
