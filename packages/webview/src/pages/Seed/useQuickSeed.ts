import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
  RunCheckpointInfo,
  SalesforceOrg,
  SeedTemplate,
  SeedExecutionResult,
  SeedFitProposal,
  SeedObjectConfig,
  FieldRuleConfig,
} from '@sandforge/shared';
import { isDevelopmentOrg } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { RUN_OUTLIVED_WAIT } from '../../hooks/useMessageResponse';
import { useStoppedRunCheckpoint } from '../../hooks/useStoppedRunCheckpoint';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { useOrgStore } from '../../stores/useOrgStore';
import type { ObjectProgress } from './Step7_Execute';
import { templateWithCounts, withCount } from './templateCounts';
import type { TemplateCounts } from './templateCounts';
import { fittedRunOf, useSeedFitRefusal, type FittedSeedRun } from './SeedFitProposal';

/**
 * Phase of the Quick Seed state machine: the gallery, then one confirmation —
 * the counts, the org, Start — then the run and its results.
 */
export type QuickSeedPhase = 'idle' | 'confirm' | 'executing' | 'results';

/**
 * Whether an org is one a seed may be aimed at without being asked for: it is
 * connected, and it is not a production org by the rule every guard reads
 * (`isDevelopmentOrg`): a sandbox, a scratch org or a Developer Edition.
 */
export function isSeedTargetCandidate(org: SalesforceOrg): boolean {
  return org.status === 'connected' && isDevelopmentOrg(org);
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
  /**
   * The locale the run draws its people, companies and addresses in, as
   * Salesforce writes one (`fr_FR`): '' for the org's own, the default.
   */
  locale: string;
  /**
   * Whether the run mutes the org's automation through its own bypass, as
   * the confirmation's box is left: off unless ticked, unticked again for
   * every template.
   */
  muteAutomation: boolean;
  /**
   * Whether the run takes a checkpoint of what it writes before its first
   * write, as the confirmation's box is left: off unless ticked, unticked
   * again for every template.
   */
  checkpointFirst: boolean;
  /** What became of the checkpoint the last run took first, when its error says. */
  stoppedCheckpoint: RunCheckpointInfo | undefined;
  /**
   * Whether the last run stopped on its error and can be set up again: not
   * while it may still be writing, past the wait for its answer.
   */
  canSetUpAgain: boolean;
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
  /** Choose the locale the run draws in; '' for the org's own. Kept for the next template. */
  setLocale: (locale: string) => void;
  /** Tick or untick the box that mutes the org's automation for the run. */
  setMuteAutomation: (mute: boolean) => void;
  /** Tick or untick the box that takes a checkpoint before the run's first write. */
  setCheckpointFirst: (first: boolean) => void;
  /**
   * The counts that fit, as the refusal of the last run for the storage or
   * the API requests its org has left carried them; null otherwise.
   */
  fitProposal: SeedFitProposal | null;
  /** The fit the last run's counts came from; null for a run whose counts were not fitted. */
  fitApplied: FittedSeedRun | null;
  /** Trigger seed execution. */
  execute: () => void;
  /**
   * Send the refused run again at the counts of {@link fitProposal}, which
   * become the confirmation's counts, saying the fit in its request: its
   * gate is met again. Nothing when there is no proposal, or nothing fits.
   */
  seedFitted: () => void;
  /**
   * Stop the running seed, as the wizard's Cancel does: before its next
   * object or batch, what it wrote staying in the org. Nothing is sent before
   * the run has reported progress, as it is not registered until then.
   */
  cancel: () => void;
  /**
   * From the results, back to the confirmation of the same template, its
   * counts, org and locale kept and the box that mutes unticked: nothing is
   * written before its Start.
   */
  seedAgain: () => void;
  /**
   * From a run stopped on its error, back to its confirmation with everything
   * as it was set, the boxes too: a refusal says what to change there, and a
   * box stays ticked until the person unticks it.
   */
  backToConfirm: () => void;
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
 * Phases: idle -> confirm -> executing -> results, and from the results back
 * to confirm for another run of the template.
 * Uses the template's field rules directly as Smart Suggest defaults.
 */
export function useQuickSeed(options: QuickSeedOptions = {}): QuickSeedState {
  const [phase, setPhase] = useState<QuickSeedPhase>('idle');
  const [selectedTemplate, setSelectedTemplate] = useState<SeedTemplate | null>(null);
  const [customizedCounts, setCustomizedCounts] = useState<Record<string, number>>({});
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [locale, setLocale] = useState('');
  const [muteAutomation, setMuteAutomation] = useState(false);
  const [checkpointFirst, setCheckpointFirst] = useState(false);
  const [executionResult, setExecutionResult] = useState<SeedExecutionResult | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [fitApplied, setFitApplied] = useState<FittedSeedRun | null>(null);

  const executeMutation = useBridgeMutation<SeedExecutionResult>('seed:execute', {
    responseType: 'seed:execute:response',
    // The run goes on in the extension until it ends, and answers then: held
    // to two minutes, a long seed lost its page and said "Try again" while
    // it went on writing.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  const isRunning = executeMutation.loading;
  const stoppedCheckpoint = useStoppedRunCheckpoint('seed:error', executeMutation.requestId);

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
      setMuteAutomation(false);
      setCheckpointFirst(false);
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
      setFitApplied(null);
    },
    [initialOrgId],
  );

  // An object can be set to 0 and left out: the count stopped at 1, and an
  // object the org lacks, or one not wanted, could not be taken off a
  // template. The objects a relation places under another follow it.
  const setCount = useCallback(
    (objectApiName: string, count: number) => {
      setCustomizedCounts((prev) =>
        selectedTemplate
          ? withCount(selectedTemplate, prev, objectApiName, Math.max(0, count))
          : { ...prev, [objectApiName]: Math.max(0, count) },
      );
    },
    [selectedTemplate],
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

  /** Send the template at `counts`, and the fit they came from when they did. */
  const run = useCallback(
    (counts: TemplateCounts, fitted?: FittedSeedRun): void => {
      if (!selectedTemplate || !selectedOrgId) return;
      // An object set to 0 is not sent, nor what cannot be written without it.
      const kept = templateWithCounts(selectedTemplate, counts);
      if (kept.objects.length === 0) return;

      const objects: SeedObjectConfig[] = kept.objects.map((obj) => ({
        objectApiName: obj.objectApiName,
        recordCount: counts[obj.objectApiName] ?? obj.recordCount,
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
        ...kept,
        objects,
      };

      setPhase('executing');
      setElapsedMs(0);
      // A run sent again from a refusal no longer stands under it.
      setError(null);
      setFitApplied(fitted ?? null);

      executeMutation.mutate({
        orgId: selectedOrgId,
        template: template as unknown as Record<string, unknown>,
        // The org's own locale unless one was chosen: the extension reads it.
        ...(locale ? { locale } : {}),
        ...(muteAutomation ? { muteAutomation: true } : {}),
        ...(checkpointFirst ? { checkpointFirst: {} } : {}),
        ...(fitted ? { fit: fitted.fit } : {}),
      });
    },
    [selectedTemplate, selectedOrgId, locale, muteAutomation, checkpointFirst, executeMutation],
  );

  const execute = useCallback(() => run(customizedCounts), [run, customizedCounts]);

  // The counts that fit, as the refusal of the last run carried them.
  const fitProposal = useSeedFitRefusal(executeMutation.requestId);

  /*
   * The refused run sent again at the counts that fit: they become the
   * confirmation's, so the run says them as it goes and Seed again comes
   * back to them; the objects left out stay out, and the org, the locale and
   * the mute stay as they were. Its request says the fit, for the audit
   * trail; the gate is met again by the counts, as for any run.
   */
  const seedFitted = useCallback(() => {
    if (!fitProposal || fitProposal.cannotFit !== undefined) return;
    const fitted = fittedRunOf(fitProposal);
    const counts = { ...customizedCounts, ...fitted.counts };
    setCustomizedCounts(counts);
    run(counts, fitted);
  }, [fitProposal, customizedCounts, run]);

  const sendMessage = useSendMessage();
  const operationId = progress ? runId : null;
  const cancel = useCallback(() => {
    if (!operationId) return;
    sendMessage(buildMessage<{ operationId: string }>('execution:abort', { operationId }));
  }, [operationId, sendMessage]);

  /*
   * Seed again on the results ran the template again at once: another full
   * copy written with no confirmation, the emails the first run had used not
   * counted again, and after a partial run what had succeeded doubled. It
   * goes back to the confirmation instead, which reads the org's automation
   * and emails again before its Start. The mute and the checkpoint are a
   * choice of each run, made on its confirmation; the org stays only while it
   * is still connected.
   */
  const seedAgain = useCallback(() => {
    if (!selectedTemplate) return;
    const orgs = useOrgStore.getState().orgs;
    setSelectedOrgId((chosen) =>
      orgs.some((org) => org.id === chosen && org.status === 'connected') ? chosen : '',
    );
    setMuteAutomation(false);
    setCheckpointFirst(false);
    setExecutionResult(undefined);
    setError(null);
    setElapsedMs(0);
    setFitApplied(null);
    executeMutation.reset();
    setPhase('confirm');
  }, [selectedTemplate, executeMutation]);

  const backToConfirm = useCallback(() => {
    setError(null);
    setElapsedMs(0);
    setFitApplied(null);
    executeMutation.reset();
    setPhase('confirm');
  }, [executeMutation]);

  const reset = useCallback(() => {
    setPhase('idle');
    setSelectedTemplate(null);
    setCustomizedCounts({});
    setExecutionResult(undefined);
    setError(null);
    setElapsedMs(0);
    setFitApplied(null);
    executeMutation.reset();
  }, [executeMutation]);

  /* Derive object progress from the template and the live figures */
  const objectProgress: ObjectProgress[] = useMemo(() => {
    if (!selectedTemplate) return [];
    // The objects the run writes: one set to 0 is not among them.
    const { objects: written } = templateWithCounts(selectedTemplate, customizedCounts);
    const totals = written.map((obj) => customizedCounts[obj.objectApiName] ?? obj.recordCount);
    const currentIndex = progress
      ? written.findIndex((obj) => progress.currentStep.endsWith(` ${obj.objectApiName}`))
      : -1;
    let before = 0;
    return written.map((obj, index): ObjectProgress => {
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
    locale,
    muteAutomation,
    checkpointFirst,
    stoppedCheckpoint,
    canSetUpAgain: error !== null && !isRunning && executeMutation.errorCode !== RUN_OUTLIVED_WAIT,
    isRunning,
    executionResult,
    objectProgress,
    overallPercent,
    elapsedMs,
    error,
    operationId,
    fitProposal,
    fitApplied,
    startQuickSeed,
    setCount,
    selectOrg,
    setLocale,
    setMuteAutomation,
    setCheckpointFirst,
    execute,
    seedFitted,
    cancel,
    seedAgain,
    backToConfirm,
    reset,
    setError,
  };
}
