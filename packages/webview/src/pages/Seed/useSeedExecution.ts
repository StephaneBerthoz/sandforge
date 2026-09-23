import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { SeedExecutionResult, SeedTemplate, SeedObjectConfig } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { ObjectProgress } from './Step7_Execute';
import type { CheckedRelation } from './seedRelationDrafts';

/** Return type for the useSeedExecution hook. */
export interface SeedExecutionState {
  /** Whether the seed execution mutation is in flight. */
  isRunning: boolean;
  /** Execution result returned by the backend. */
  executionResult: SeedExecutionResult | undefined;
  /**
   * The template the last run was built from, or null before a run. It is not
   * persisted by the run itself — it is what "Save as template" stores, so the
   * saved template is exactly what was seeded rather than a second reading of
   * the wizard.
   */
  lastTemplate: SeedTemplate | null;
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
 * Handles the execute mutation and tracks per-object progress. A relation
 * row that can be sent decides the record count of its child and fills the
 * lookup it names; a row with a problem is not sent, and the wizard does not
 * let the run start while there is one.
 */
export function useSeedExecution(
  selectedOrgId: string,
  selectedObjects: string[],
  volumes: Record<string, { count: number; batchSize: number }>,
  fieldConfigs: ObjectFieldConfig[],
  t: TFunction,
  relations: readonly CheckedRelation[] = [],
): SeedExecutionState {
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [executionResult, setExecutionResult] = useState<SeedExecutionResult | undefined>();
  const [lastTemplate, setLastTemplate] = useState<SeedTemplate | null>(null);
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

  const sent = useMemo(
    () =>
      relations.flatMap((checked) =>
        checked.relation ? [{ relation: checked.relation, children: checked.children }] : [],
      ),
    [relations],
  );

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
        const related = sent.find((s) => s.relation.childObject === apiName);
        return {
          objectApiName: apiName,
          // A relation plans its child's records from the parents it finds;
          // the count set for the child on the first step does not apply.
          recordCount: related ? related.children : vol.count,
          batchSize: vol.batchSize,
          insertOrder: index,
          excludedFields: [],
          fieldRules: (objConfig?.fields ?? [])
            // The relation fills its lookup; the field's own rule would draw
            // a parent at random.
            .filter((f) => f.fieldApiName !== related?.relation.lookupField)
            // A lookup points at records this run inserts: an optional one to
            // an object the run does not seed, such as OwnerId to User, made
            // the run refuse the whole template. It is left for the org to
            // default, and so is an optional one to the object itself, such
            // as ParentId on Account or ReportsToId on Contact: the insert
            // that writes the object has no id of its own records to give,
            // and the run refused every such template as a circular
            // dependency. A required one is still sent, so the run is refused
            // before it writes anything rather than failing every record of
            // the object on REQUIRED_FIELD_MISSING.
            .filter(
              (f) =>
                f.ruleType !== 'reference' ||
                f.required ||
                typeof f.config['referenceObject'] !== 'string' ||
                (f.config['referenceObject'] !== apiName &&
                  selectedObjects.includes(f.config['referenceObject'])),
            )
            .map((f) => ({
              fieldApiName: f.fieldApiName,
              fieldType: f.type,
              ruleType: f.ruleType,
              config: f.config as import('@sandforge/shared').FieldRuleConfig,
            })),
        };
      }),
      ...(sent.length > 0 ? { relations: sent.map((s) => s.relation) } : {}),
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setStartedAt(Date.now());
    setLastTemplate(template);
    executeSeedMutation.mutate({
      orgId: selectedOrgId,
      template: template as unknown as Record<string, unknown>,
    });
  }, [selectedOrgId, selectedObjects, volumes, fieldConfigs, sent, executeSeedMutation]);

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
      const total =
        sent.find((s) => s.relation.childObject === o)?.children ?? volumes[o]?.count ?? 100;
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
  }, [selectedObjects, volumes, sent, isRunning, progress]);

  return {
    isRunning,
    executionResult,
    lastTemplate,
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
