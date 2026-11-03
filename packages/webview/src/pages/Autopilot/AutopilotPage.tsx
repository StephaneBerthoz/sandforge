import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  AutopilotCompleted,
  AutopilotGraph as AutopilotGraphType,
  AutopilotLookupsNotFilled,
  AutopilotStatusesNotApplied,
  AutopilotNodeProgress,
  AutopilotNodeRunStatus,
  AutopilotNodeStatus,
  AutopilotRunStatus,
  AutopilotStopLeftover,
  AutopilotPlanWriteGate,
  ExecutionPlan,
  MutedAutomation,
} from '@sandforge/shared';
import { useAutopilotStore } from '../../stores/useAutopilotStore';
import type { AutopilotStep } from '../../stores/useAutopilotStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { OrgRibbon } from '../../components/ui/OrgRibbon';
import { useMessageListener } from '../../hooks/useMessageBus';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { RUN_OUTLIVED_WAIT } from '../../hooks/useMessageResponse';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { AutopilotWizard } from './AutopilotWizard';
import { ControlPanel } from './ControlPanel';
import { ComplianceReport } from './ComplianceReport';
import { GrappeProgressPanel } from '../../components/GrappeProgressPanel';
import { PartBoundary } from '../../components/ui/PartBoundary';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { withEnglish } from '../../i18n/englishNamespaces';
import { runCheckpointOf } from '../../utils/runCheckpoint';
import { isAutopilotPlanWriteGate } from './AutopilotWizard/AutopilotFitPanel';

/**
 * The run's graph, in a chunk of its own fetched once the run starts: React
 * Flow, 167 kB, was parsed before the wizard painted, which draws no graph,
 * and took the page past its first-paint budget. Its words are the page's.
 */
const AutopilotGraph = lazy(() =>
  withEnglish(() => import('./AutopilotGraph'), [])().then((module) => ({
    default: module.AutopilotGraph,
  })),
);

/** Wrapper that only mounts GrappeProgressPanel when grappe is active. */
const AutopilotGrappePanel: React.FC = () => {
  const { active, operationId } = useGrappeStore();
  if (!active && !operationId) return null;
  return (
    <div className="px-4 py-2">
      <GrappeProgressPanel />
    </div>
  );
};

/**
 * The sentence a run stopped before its first write is said in, by its code:
 * the extension words these in English, for its log and the command line.
 * Undefined for a code the page has no words of its own for.
 *
 * @param code - The code of the run's error.
 * @param checkpointAsked - Whether the run was to take a checkpoint first: a
 *   run past the day's API requests counts one among them only then.
 */
function refusalKeyOf(code: string | null, checkpointAsked: boolean): string | undefined {
  switch (code) {
    case 'CHECKPOINT_REFUSED':
      return 'autopilot.refusal.checkpointRefused';
    case 'API_BUDGET_EXCEEDED':
      return checkpointAsked
        ? 'autopilot.refusal.apiBudgetExceededWithCheckpoint'
        : 'autopilot.refusal.apiBudgetExceeded';
    case 'RUN_CANCELLED':
      return 'autopilot.refusal.runCancelled';
    default:
      return undefined;
  }
}

/** The steps the wizard shows; the others are the running view's. */
const WIZARD_STEPS: readonly AutopilotStep[] = ['connect', 'objects', 'review'];

/** Main Autopilot page layout. */
export const AutopilotPage: React.FC = () => {
  const { t } = useTranslation();
  const step = useAutopilotStore((s) => s.step);
  const sourceOrgId = useAutopilotStore((s) => s.sourceOrgId);
  const targetOrgId = useAutopilotStore((s) => s.targetOrgId);
  const [showReport, setShowReport] = useState(false);
  /** Set once a stopped run has ended: the objects it did not write whole. */
  const [notWritten, setNotWritten] = useState<string[] | undefined>();
  /** What a stopped run wrote and left unfinished, per object. */
  const [leftByStop, setLeftByStop] = useState<AutopilotStopLeftover[]>([]);
  /** The emails a stopped run held back for their task and never sent. */
  const [emailsHeldForTheirTask, setEmailsHeldForTheirTask] = useState(0);
  /** What the run muted of the target's automation, said once it ended. */
  const [mutedAutomation, setMutedAutomation] = useState<MutedAutomation | undefined>(undefined);
  /** Of a fitted plan's run, the records held back since the fit, once it ended. */
  const [cutSinceFit, setCutSinceFit] = useState<number | undefined>(undefined);
  /** How the run ended, once it has. */
  const [runStatus, setRunStatus] = useState<AutopilotRunStatus | undefined>(undefined);
  /** Per object, the records the run wrote that keep a lookup empty, once it ended. */
  const [lookupsNotFilled, setLookupsNotFilled] = useState<AutopilotLookupsNotFilled[]>([]);
  /** Per object, the records the run wrote that stay drafts, once it ended. */
  const [statusesNotApplied, setStatusesNotApplied] = useState<AutopilotStatusesNotApplied[]>([]);
  /** When the run was sent: an error carries no time of its own for it. */
  const runSentAt = useRef(0);
  /** Whether the review's option asked for a checkpoint: said of the run it sent. */
  const askedCheckpoint = useAutopilotStore((s) => s.checkpointFirst);

  // Listen for push messages from the AutopilotHandler and update the store
  useMessageListener<BaseMessage & { payload: { graph: AutopilotGraphType } }>(
    'autopilot:schema-result',
    (msg) => {
      useAutopilotStore.getState().setGraph(msg.payload.graph);
    },
  );

  // The plan made, fitted or given back by Undo fit, and what it comes to
  // against the target.
  useMessageListener<
    BaseMessage & {
      payload: {
        plan: ExecutionPlan;
        graph: AutopilotGraphType;
        writeGate?: AutopilotPlanWriteGate;
      };
    }
  >('autopilot:plan-ready', (msg) => {
    useAutopilotStore.getState().setPlan(msg.payload.plan);
    useAutopilotStore.getState().setGraph(msg.payload.graph);
    useAutopilotStore.getState().setWriteGate(msg.payload.writeGate ?? null);
    useAutopilotStore.getState().setStep('review');
  });

  useMessageListener<AutopilotNodeProgress>('autopilot:node-progress', (msg) => {
    const store = useAutopilotStore.getState();
    const statusMap: Record<AutopilotNodeRunStatus, AutopilotNodeStatus> = {
      processing: 'extracting',
      completed: 'completed',
      failed: 'failed',
      // Skipped by Skip Node: none of it sent. Unmapped, it fell to pending.
      skipped: 'skipped',
      // Cut short or never reached by a stop: not written whole.
      stopped: 'skipped',
    };
    const mappedStatus = statusMap[msg.payload.status] ?? 'pending';
    store.updateNodeStatus(msg.payload.objectName, mappedStatus);
    // When the node settled, as the host stamped the message: what the
    // compliance report's timeline says, and nothing else.
    if (mappedStatus === 'completed' || mappedStatus === 'failed' || mappedStatus === 'skipped') {
      store.recordNodeFinish(msg.payload.objectName, mappedStatus, msg.timestamp);
    }
    if (msg.payload.recordCount !== undefined) {
      // A node a skip or a stop cut short did not go through: a recordCount
      // alone drew a skipped node's bar full. Its bar says what it wrote of
      // what it had to.
      const written = msg.payload.recordCount;
      const toWrite = written + (msg.payload.notSent ?? 0);
      const went =
        mappedStatus !== 'skipped' ? 100 : toWrite > 0 ? Math.round((100 * written) / toWrite) : 0;
      store.updateNodeProgress(msg.payload.objectName, went, written);
    }
    // Why records were refused, by code and fields, what the target already
    // held, and what was left to the platform: what the node detail shows
    // once the node has settled.
    store.updateNodeOutcome(msg.payload.objectName, {
      failureCount: msg.payload.failureCount,
      linkedCount: msg.payload.linkedCount,
      refusals: msg.payload.refusals,
      statusesApplied: msg.payload.statusesApplied,
      statusRefusals: msg.payload.statusRefusals,
      lookupsFilled: msg.payload.lookupsFilled,
      lookupRefusals: msg.payload.lookupRefusals,
      leftToThePlatform: msg.payload.leftToThePlatform,
      currenciesReplaced: msg.payload.currenciesReplaced,
      pricesSettled: msg.payload.pricesSettled,
      cutSinceFit: msg.payload.cutSinceFit,
      recordTypeGiven: msg.payload.recordTypeGiven,
    });
    if (msg.payload.status === 'failed' && msg.payload.error) {
      store.addError(`${msg.payload.objectName}: ${msg.payload.error}`);
    }
    /*
     * Total what the run has done so far, rather than waiting for the end.
     *
     * These two numbers used to be written exactly twice: zeroed when the run
     * started and filled in by `autopilot:completed`. In between, a run of two
     * waves showed "0 / 243 records" and "0 / 131 API calls" for its whole
     * length, under a panel headed "live stats". Records are summed from the
     * nodes rather than accumulated, so a status a node reaches twice — the
     * handler reconciles every node once the run ends — cannot count twice.
     */
    const settled = useAutopilotStore.getState().graph?.nodes ?? [];
    const recordsProcessed = settled.reduce(
      // `successCount` is where the store records what a node wrote.
      (sum, node) => sum + (node.status === 'completed' ? (node.successCount ?? 0) : 0),
      0,
    );
    store.updateLiveStats({
      currentWave: msg.payload.wave,
      recordsProcessed,
      ...(msg.payload.apiCallsUsed !== undefined
        ? { apiCallsUsed: store.liveStats.apiCallsUsed + msg.payload.apiCallsUsed }
        : {}),
    });
  });

  useMessageListener<AutopilotCompleted>('autopilot:completed', (msg) => {
    const ended = useAutopilotStore.getState();
    if (ended.targetOrgId) {
      const checkpoint = runCheckpointOf(msg.payload.checkpoint);
      ended.setRunEnd({
        orgId: ended.targetOrgId,
        startedAt: new Date(msg.timestamp - msg.payload.totalElapsedMs).toISOString(),
        endedAt: new Date(msg.timestamp).toISOString(),
        objects: ended.plan?.waves.flatMap((wave) => wave.objects.map(String)) ?? [],
        ...(checkpoint ? { checkpoint } : {}),
      });
    }
    setMutedAutomation(msg.payload.mutedAutomation);
    setCutSinceFit(msg.payload.cutSinceFit);
    setRunStatus(msg.payload.status);
    setLookupsNotFilled(msg.payload.lookupsNotFilled ?? []);
    setStatusesNotApplied(msg.payload.statusesNotApplied ?? []);
    setNotWritten(msg.payload.stopped ? (msg.payload.notWritten ?? []) : undefined);
    setLeftByStop(msg.payload.stopped ? (msg.payload.leftByStop ?? []) : []);
    setEmailsHeldForTheirTask(msg.payload.stopped ? (msg.payload.emailsHeldForTheirTask ?? 0) : 0);
    useAutopilotStore.getState().setExecutionStatus('completed');
    useAutopilotStore.getState().setStep('completed');
    useAutopilotStore.getState().updateLiveStats({
      recordsProcessed: msg.payload.totalSuccessCount,
      recordsTotal: msg.payload.totalRecords,
      apiCallsUsed: msg.payload.totalApiCalls,
      elapsedMs: msg.payload.totalElapsedMs,
    });
  });

  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);

  // Execute request — owned by the page (not the wizard) so the response/error
  // listeners survive the wizard unmounting when the view flips to execution.
  // A run goes on in the extension until it ends, and answers then: held to
  // ten minutes — the Production Guard's and the gate's questions counted in
  // them — the page went back to the review saying "Try again" while the run
  // went on writing, and a second Execute wrote every table again.
  const executeMutation = useBridgeMutation<{
    totalRecords: number;
    totalSuccessCount: number;
    totalFailureCount: number;
    totalElapsedMs: number;
    totalApiCalls: number;
  }>('autopilot:execute', {
    responseType: 'autopilot:completed',
    errorType: 'autopilot:error',
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  /** Start execution: flip to the execution view and post `autopilot:execute`. */
  const handleExecute = useCallback((): void => {
    setNotWritten(undefined);
    setLeftByStop([]);
    setEmailsHeldForTheirTask(0);
    setMutedAutomation(undefined);
    setCutSinceFit(undefined);
    setRunStatus(undefined);
    setLookupsNotFilled([]);
    setStatusesNotApplied([]);
    runSentAt.current = Date.now();
    const store = useAutopilotStore.getState();
    const plan = store.plan;
    store.setRunEnd(null);
    store.clearNodeFinishes();
    store.setExecutionStatus('executing');
    store.setStep('executing');
    store.updateLiveStats({
      recordsProcessed: 0,
      recordsTotal: plan?.totalRecords ?? 0,
      apiCallsUsed: 0,
      apiCallsEstimated: plan?.estimatedApiCalls ?? 0,
      elapsedMs: 0,
      currentWave: 0,
      totalWaves: plan?.waves.length ?? 0,
    });
    // Emails and phone numbers neutralized unless the review's box was unticked.
    executeMutation.mutate({
      grappeThreshold: 0,
      ...(store.neutralizeContactPoints === false ? { keepContactPoints: true } : {}),
      // The target's automation muted through its own bypass, as ticked there too.
      ...(store.muteAutomation ? { muteAutomation: true } : {}),
      // A checkpoint of what it writes taken first, kept as the setting says.
      ...(store.checkpointFirst ? { checkpointFirst: {} } : {}),
    });
  }, [executeMutation]);

  // A run that died once its checkpoint was through says what became of it
  // beside its error: deleted, as it wrote nothing — its mute refused —, or
  // kept for what it wrote, the one way back of a run with no removal. The
  // mutation keeps the words and the code alone; the review says it.
  useMessageListener<BaseMessage & { payload: { checkpoint?: unknown; writeGate?: unknown } }>(
    'autopilot:error',
    (msg) => {
      if (msg.correlationId !== executeMutation.requestId) return;
      // A run refused for what its target has left says it in figures, read
      // again as it was refused: the review shows them, and Fit to storage.
      if (isAutopilotPlanWriteGate(msg.payload.writeGate)) {
        useAutopilotStore.getState().setWriteGate(msg.payload.writeGate);
      }
      const checkpoint = runCheckpointOf(msg.payload.checkpoint);
      const ended = useAutopilotStore.getState();
      if (!checkpoint || !ended.targetOrgId) return;
      ended.setRunEnd({
        orgId: ended.targetOrgId,
        startedAt: new Date(runSentAt.current).toISOString(),
        endedAt: new Date(msg.timestamp).toISOString(),
        objects: ended.plan?.waves.flatMap((wave) => wave.objects.map(String)) ?? [],
        checkpoint,
      });
    },
  );

  // Execute rejected (validation, production guard declined, execution crash):
  // surface the error back on the review step — the store keeps the wizard state.
  // A run refused because Production Guard is missing is said by its code:
  // the host words it in English, and a notification beside it said the
  // same in English.
  // A wait that ended before the run did is not a failed run: the page stays
  // on the run, which may still be writing, and says where to follow it.
  const outlivedWait = executeMutation.errorCode === RUN_OUTLIVED_WAIT;
  const refusal = refusalKeyOf(executeMutation.errorCode, askedCheckpoint);
  const executeError =
    executeMutation.errorCode === 'NOT_INITIALIZED'
      ? t('common.refusal.guardMissing')
      : refusal !== undefined
        ? t(refusal)
        : outlivedWait
          ? null
          : executeMutation.error;
  useEffect(() => {
    if (!executeError) return;
    const store = useAutopilotStore.getState();
    store.setExecutionStatus('failed');
    store.addError(executeError);
    store.setStep('review');
  }, [executeError]);

  // Execute leaves with the wizard, and the focus it held fell to the page:
  // the running view takes it, announced by its heading. A page opened on a
  // run already under way has nothing to hand on, and leaves the focus alone.
  const executionHeading = useRef<HTMLHeadingElement>(null);
  const stepBefore = useRef(step);
  useEffect(() => {
    const before = stepBefore.current;
    stepBefore.current = step;
    if (step !== 'executing' || !WIZARD_STEPS.includes(before)) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) executionHeading.current?.focus();
  }, [step]);

  if (!selectedOrgId || orgs.length === 0) {
    return (
      <EmptyState
        module="autopilot"
        title={t('autopilot.emptyState.title')}
        description={t('moduleSummary.autopilot')}
        actionLabel={t('autopilot.emptyState.cta')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  const isWizardStep = WIZARD_STEPS.includes(step);
  const isExecutionStep = step === 'executing' || step === 'completed';

  if (showReport) {
    return (
      <div className="flex flex-col h-full" data-testid="autopilot-page">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-(--sf-border)">
          <button
            className="px-3 py-1 text-xs rounded-sm bg-(--sf-bg-input) text-text-primary hover:bg-(--sf-bg-hover) transition-colors"
            onClick={() => setShowReport(false)}
            data-testid="back-from-report"
          >
            {t('common.back')}
          </button>
          <h1 tabIndex={-1} className="text-sm font-semibold text-text-primary">
            {t('autopilot.report.title')}
          </h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ComplianceReport />
        </div>
      </div>
    );
  }

  if (isWizardStep) {
    return (
      <div className="flex flex-col h-full" data-testid="autopilot-page">
        {/* The wizard comes back only on an Execute whose request failed —
            the guard refused the run, its confirmation was declined — and
            the running view's heading, which held the keyboard, went with the
            view: the review takes the keyboard. Drawn afresh, the page has
            no failed request, and the wizard leaves the focus alone. */}
        <AutopilotWizard
          onExecute={handleExecute}
          isExecuting={executeMutation.loading}
          returnedFromRun={executeMutation.error !== null}
        />
      </div>
    );
  }

  if (isExecutionStep) {
    return (
      <div className="flex flex-col h-full" data-testid="autopilot-page">
        {/* Header with title and optional report button. The page's heading:
            the panel's focus on a page change lands on it as Execute's does. */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-(--sf-border)">
          <h1
            ref={executionHeading}
            tabIndex={-1}
            className="text-sm font-semibold text-text-primary"
          >
            {t('autopilot.title')}
          </h1>
          {step === 'completed' && (
            <button
              className="px-3 py-1.5 text-xs font-medium rounded-sm bg-(--sf-button-bg) text-(--sf-button-fg) hover:bg-(--sf-button-hover) transition-colors"
              onClick={() => setShowReport(true)}
              data-testid="view-compliance-report"
            >
              {t('autopilot.report.title')}
            </button>
          )}
        </div>
        <OrgRibbon
          className="px-4 py-2 border-b border-(--sf-border)"
          source={orgs.find((org) => org.id === sourceOrgId) ?? sourceOrgId ?? undefined}
          target={orgs.find((org) => org.id === targetOrgId) ?? targetOrgId ?? undefined}
        />
        {outlivedWait && step === 'executing' && executeMutation.error && (
          <p
            role="status"
            className="px-4 py-2 text-xs text-text-secondary border-b border-(--sf-border)"
            data-testid="autopilot-outlived-wait"
          >
            {executeMutation.error}
          </p>
        )}
        {/* Grappe progress panel — shown when grappe mode is active */}
        <AutopilotGrappePanel />
        {/* Split view: graph placeholder (left 60%) + control panel (right 40%) */}
        <div className="flex flex-1 overflow-hidden">
          <div
            className="w-[60%] overflow-hidden border-r border-(--sf-border)"
            data-testid="autopilot-graph-area"
          >
            <PartBoundary className="h-full w-full" data-testid="autopilot-graph-failed">
              <Suspense
                fallback={
                  <div
                    className="h-full w-full"
                    aria-busy="true"
                    data-testid="autopilot-graph-loading"
                  />
                }
              >
                <AutopilotGraph />
              </Suspense>
            </PartBoundary>
          </div>
          <div className="w-[40%] overflow-hidden">
            <ControlPanel
              runOperationId={executeMutation.requestId}
              notWritten={notWritten}
              leftByStop={leftByStop}
              emailsHeldForTheirTask={emailsHeldForTheirTask}
              mutedAutomation={mutedAutomation}
              cutSinceFit={cutSinceFit}
              runStatus={runStatus}
              lookupsNotFilled={lookupsNotFilled}
              statusesNotApplied={statusesNotApplied}
            />
          </div>
        </div>
      </div>
    );
  }

  return null;
};
