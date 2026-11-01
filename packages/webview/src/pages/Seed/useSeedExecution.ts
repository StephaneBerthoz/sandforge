import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type {
  FieldRule,
  RunCheckpointInfo,
  SeedExecutionResult,
  SeedFitProposal,
  SeedTemplate,
  SeedObjectConfig,
} from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import { useStoppedRunCheckpoint } from '../../hooks/useStoppedRunCheckpoint';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { ObjectProgress } from './Step7_Execute';
import type { CheckedRelation } from './seedRelationDrafts';
import { lookupsClosingACycle } from './seedLookupCycles';
import type { RunLookup } from './seedLookupCycles';
import { fieldsForAccountKind, recordTypeFieldRule } from './seedRecordTypeChoices';
import { fittedRunOf, useSeedFitRefusal, type FittedSeedRun } from './SeedFitProposal';

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
  /**
   * Whether the run mutes the target's automation through its own bypass, as
   * the box beside what the org runs is left: off unless ticked.
   */
  muteAutomation: boolean;
  setMuteAutomation: (mute: boolean) => void;
  /**
   * Whether the run takes a checkpoint of what it writes before its first
   * write, as its box on the Execute step is left: off unless ticked.
   */
  checkpointFirst: boolean;
  setCheckpointFirst: (first: boolean) => void;
  /** What became of the checkpoint the last run took first, when its error says. */
  stoppedCheckpoint: RunCheckpointInfo | undefined;
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
  /**
   * The counts that fit, as the refusal of the last run for the storage or
   * the API requests its org has left carried them; null otherwise, and once
   * the org, the objects, their counts, fields, relations, record types or
   * locale the refused run was built from change.
   */
  fitProposal: SeedFitProposal | null;
  /** The fit the last run's counts came from; null for a run whose counts were not fitted. */
  fitApplied: FittedSeedRun | null;
  /**
   * Send the refused run again at the counts of {@link fitProposal}, saying
   * the fit in its request: its gate is met again. Nothing when there is no
   * proposal, or nothing fits.
   */
  seedFitted: () => void;
}

/** No relations, and no record types chosen: one of each, so a run's sources compare by reference. */
const NO_RELATIONS: readonly CheckedRelation[] = [];
const NO_CHOICES: Readonly<Record<string, readonly string[]>> = {};

/** What a run was built from, by reference: a proposal for it holds while none changes. */
interface SentFrom {
  orgId: string;
  objects: readonly string[];
  volumes: Readonly<Record<string, { count: number; batchSize: number }>>;
  fieldConfigs: readonly ObjectFieldConfig[];
  relations: readonly CheckedRelation[];
  recordTypeChoices: Readonly<Record<string, readonly string[]>>;
  locale: string;
}

/**
 * Hook managing seed execution and progress tracking for the Seed wizard.
 *
 * Handles the execute mutation and tracks per-object progress. A relation
 * row that can be sent decides the record count of its child and fills the
 * lookup it names; a row with a problem is not sent, and the wizard does not
 * let the run start while there is one. The record types chosen for an object
 * go as a `RecordTypeId` rule, as the command line sends them.
 */
export function useSeedExecution(
  selectedOrgId: string,
  selectedObjects: string[],
  volumes: Record<string, { count: number; batchSize: number }>,
  fieldConfigs: ObjectFieldConfig[],
  t: TFunction,
  relations: readonly CheckedRelation[] = NO_RELATIONS,
  recordTypeChoices: Readonly<Record<string, readonly string[]>> = NO_CHOICES,
  locale = '',
): SeedExecutionState {
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [executionResult, setExecutionResult] = useState<SeedExecutionResult | undefined>();
  const [lastTemplate, setLastTemplate] = useState<SeedTemplate | null>(null);
  const [executionCompletedStep, setExecutionCompletedStep] = useState<number | null>(null);
  /** Set when the run is fired, so elapsed time is real rather than hardcoded 0. */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [muteAutomation, setMuteAutomation] = useState(false);
  const [checkpointFirst, setCheckpointFirst] = useState(false);
  const [sentFrom, setSentFrom] = useState<SentFrom | null>(null);
  const [fitApplied, setFitApplied] = useState<FittedSeedRun | null>(null);

  const executeSeedMutation = useBridgeMutation<SeedExecutionResult>('seed:execute', {
    responseType: 'seed:execute:response',
    // The run goes on in the extension until it ends, and answers then: held
    // to two minutes, a long seed lost its page and said "Try again" while
    // it went on writing.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  const isRunning = executeSeedMutation.loading;
  const stoppedCheckpoint = useStoppedRunCheckpoint('seed:error', executeSeedMutation.requestId);

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

    // The lookups between the run's objects, but the ones the relations fill.
    const runLookups = selectedObjects.flatMap((apiName): RunLookup[] => {
      const related = sent.find((s) => s.relation.childObject === apiName);
      const fields = fieldConfigs.find((c) => c.objectApiName === apiName)?.fields ?? [];
      return fields.flatMap((f) => {
        const target = f.config['referenceObject'];
        return f.ruleType === 'reference' &&
          f.fieldApiName !== related?.relation.lookupField &&
          typeof target === 'string' &&
          target !== apiName &&
          selectedObjects.includes(target)
          ? [{ objectApiName: apiName, fieldApiName: f.fieldApiName, target, required: f.required }]
          : [];
      });
    });
    const leftOut = lookupsClosingACycle(
      selectedObjects,
      runLookups,
      sent.map((s) => s.relation),
    );

    const template: SeedTemplate = {
      id: crypto.randomUUID(),
      name: 'seed-from-ui',
      description: 'Seed from SandForge UI',
      version: 1,
      strategy: 'faker',
      objects: selectedObjects.map((apiName, index): SeedObjectConfig => {
        const vol = volumes[apiName] ?? { count: 100, batchSize: 200 };
        const related = sent.find((s) => s.relation.childObject === apiName);
        const recordTypes = recordTypeChoices[apiName] ?? [];
        // The fields the Configure step listed: an account's for the kind of
        // account its record types write.
        const described = fieldConfigs.find((c) => c.objectApiName === apiName);
        const objConfig = described && fieldsForAccountKind(described, recordTypes);
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
            // The record types chosen give it below.
            .filter((f) => recordTypes.length === 0 || f.fieldApiName !== 'RecordTypeId')
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
            // Two of the run's objects looking each other up would each wait
            // for the other, and the run refused the template as a circular
            // dependency; one of the two optional lookups is left to the org.
            .filter((f) => !leftOut.has(`${apiName}.${f.fieldApiName}`))
            .map((f): FieldRule => ({
              fieldApiName: f.fieldApiName,
              fieldType: f.type,
              ruleType: f.ruleType,
              config: f.config as import('@sandforge/shared').FieldRuleConfig,
            }))
            .concat(recordTypes.length > 0 ? [recordTypeFieldRule(recordTypes)] : []),
        };
      }),
      ...(sent.length > 0 ? { relations: sent.map((s) => s.relation) } : {}),
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setStartedAt(Date.now());
    setLastTemplate(template);
    setFitApplied(null);
    setSentFrom({
      orgId: selectedOrgId,
      objects: selectedObjects,
      volumes,
      fieldConfigs,
      relations,
      recordTypeChoices,
      locale,
    });
    executeSeedMutation.mutate({
      orgId: selectedOrgId,
      template: template as unknown as Record<string, unknown>,
      // The org's own locale unless one was chosen: the extension reads it.
      ...(locale ? { locale } : {}),
      ...(muteAutomation ? { muteAutomation: true } : {}),
      ...(checkpointFirst ? { checkpointFirst: {} } : {}),
    });
  }, [
    selectedOrgId,
    selectedObjects,
    volumes,
    fieldConfigs,
    relations,
    sent,
    recordTypeChoices,
    locale,
    muteAutomation,
    checkpointFirst,
    executeSeedMutation,
  ]);

  // The counts that fit, as the refusal of the last run carried them: for
  // the run as it was built. Once the wizard is changed, they are of a run
  // it would no longer send, and are not offered.
  const refused = useSeedFitRefusal(executeSeedMutation.requestId);
  const fitProposal =
    refused !== null &&
    sentFrom !== null &&
    sentFrom.orgId === selectedOrgId &&
    sentFrom.objects === selectedObjects &&
    sentFrom.volumes === volumes &&
    sentFrom.fieldConfigs === fieldConfigs &&
    sentFrom.relations === relations &&
    sentFrom.recordTypeChoices === recordTypeChoices &&
    sentFrom.locale === locale
      ? refused
      : null;

  /*
   * The refused run sent again at the counts that fit, and nothing else
   * changed: the template it was built from, its locale, and the mute and
   * the checkpoint as their boxes are left. Its request says the fit, for the
   * audit trail; the gate is met again by the counts, as for any run.
   */
  const seedFitted = useCallback(() => {
    if (!selectedOrgId || !lastTemplate || !fitProposal || fitProposal.cannotFit !== undefined) {
      return;
    }
    const fitted = fittedRunOf(fitProposal);
    const template: SeedTemplate = {
      ...lastTemplate,
      objects: lastTemplate.objects.map((object) => ({
        ...object,
        recordCount: Math.min(
          object.recordCount,
          fitted.counts[object.objectApiName] ?? object.recordCount,
        ),
      })),
      updatedAt: new Date().toISOString(),
    };
    setStartedAt(Date.now());
    setLastTemplate(template);
    setFitApplied(fitted);
    executeSeedMutation.mutate({
      orgId: selectedOrgId,
      template: template as unknown as Record<string, unknown>,
      ...(locale ? { locale } : {}),
      ...(muteAutomation ? { muteAutomation: true } : {}),
      ...(checkpointFirst ? { checkpointFirst: {} } : {}),
      fit: fitted.fit,
    });
  }, [
    selectedOrgId,
    lastTemplate,
    fitProposal,
    locale,
    muteAutomation,
    checkpointFirst,
    executeSeedMutation,
  ]);

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

    // A fitted run writes the counts of its fit, not those set in the wizard.
    const fittedCounts = isRunning ? fitApplied?.counts : undefined;
    return selectedObjects.map((o, index): ObjectProgress => {
      const total =
        fittedCounts?.[o] ??
        sent.find((s) => s.relation.childObject === o)?.children ??
        volumes[o]?.count ??
        100;
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
  }, [selectedObjects, volumes, sent, isRunning, progress, fitApplied]);

  return {
    isRunning,
    executionResult,
    lastTemplate,
    muteAutomation,
    setMuteAutomation,
    checkpointFirst,
    setCheckpointFirst,
    stoppedCheckpoint,
    handleExecute,
    objectProgress,
    overallPercent: progress?.percentage ?? 0,
    elapsedMs,
    progressLabel: progress?.currentStep ?? null,
    executionError: executeSeedMutation.error ?? undefined,
    executionCompletedStep,
    operationId: progress ? runId : null,
    fitProposal,
    fitApplied,
    seedFitted,
  };
}
