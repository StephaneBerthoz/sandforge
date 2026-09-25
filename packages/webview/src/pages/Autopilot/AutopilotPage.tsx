import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  AutopilotGraph as AutopilotGraphType,
  AutopilotNodeStatus,
  AutopilotRefusal,
  ExecutionPlan,
} from '@sandforge/shared';
import { useAutopilotStore } from '../../stores/useAutopilotStore';
import type { AutopilotStep } from '../../stores/useAutopilotStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { useMessageListener } from '../../hooks/useMessageBus';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { AutopilotWizard } from './AutopilotWizard';
import { AutopilotGraph } from './AutopilotGraph';
import { ControlPanel } from './ControlPanel';
import { ComplianceReport } from './ComplianceReport';
import { GrappeProgressPanel } from '../../components/GrappeProgressPanel';
import { useGrappeStore } from '../../stores/useGrappeStore';

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

/** The steps the wizard shows; the others are the running view's. */
const WIZARD_STEPS: readonly AutopilotStep[] = ['connect', 'objects', 'compliance', 'review'];

/** Main Autopilot page layout. */
export const AutopilotPage: React.FC = () => {
  const { t } = useTranslation();
  const step = useAutopilotStore((s) => s.step);
  const [showReport, setShowReport] = useState(false);

  // Listen for push messages from the AutopilotHandler and update the store
  useMessageListener<BaseMessage & { payload: { graph: AutopilotGraphType } }>(
    'autopilot:schema-result',
    (msg) => {
      useAutopilotStore.getState().setGraph(msg.payload.graph);
    },
  );

  useMessageListener<BaseMessage & { payload: { plan: ExecutionPlan; graph: AutopilotGraphType } }>(
    'autopilot:plan-ready',
    (msg) => {
      useAutopilotStore.getState().setPlan(msg.payload.plan);
      useAutopilotStore.getState().setGraph(msg.payload.graph);
      useAutopilotStore.getState().setStep('review');
    },
  );

  useMessageListener<
    BaseMessage & {
      payload: {
        nodeId: string;
        objectName: string;
        status: string;
        wave: number;
        recordCount?: number;
        failureCount?: number;
        linkedCount?: number;
        refusals?: AutopilotRefusal[];
        statusesApplied?: number;
        statusRefusals?: AutopilotRefusal[];
        leftToThePlatform?: number;
        apiCallsUsed?: number;
        error?: string;
      };
    }
  >('autopilot:node-progress', (msg) => {
    const store = useAutopilotStore.getState();
    const statusMap: Record<string, AutopilotNodeStatus> = {
      processing: 'extracting',
      completed: 'completed',
      failed: 'failed',
    };
    const mappedStatus = statusMap[msg.payload.status] ?? 'pending';
    store.updateNodeStatus(msg.payload.objectName, mappedStatus);
    if (msg.payload.recordCount !== undefined) {
      store.updateNodeProgress(msg.payload.objectName, 100, msg.payload.recordCount);
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
      leftToThePlatform: msg.payload.leftToThePlatform,
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

  useMessageListener<
    BaseMessage & {
      payload: {
        totalRecords: number;
        totalSuccessCount: number;
        totalFailureCount: number;
        totalElapsedMs: number;
        totalApiCalls: number;
      };
    }
  >('autopilot:completed', (msg) => {
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
  // Executions run long: the timeout is 10 min, not the 30 s default.
  const executeMutation = useBridgeMutation<{
    totalRecords: number;
    totalSuccessCount: number;
    totalFailureCount: number;
    totalElapsedMs: number;
    totalApiCalls: number;
  }>('autopilot:execute', {
    responseType: 'autopilot:completed',
    errorType: 'autopilot:error',
    timeoutMs: 600_000,
  });

  /** Start execution: flip to the execution view and post `autopilot:execute`. */
  const handleExecute = useCallback((): void => {
    const store = useAutopilotStore.getState();
    const plan = store.plan;
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
    executeMutation.mutate({ grappeThreshold: 0 });
  }, [executeMutation]);

  // Execute rejected (validation, production guard declined, execution crash):
  // surface the error back on the review step — the store keeps the wizard state.
  useEffect(() => {
    if (!executeMutation.error) return;
    const store = useAutopilotStore.getState();
    store.setExecutionStatus('failed');
    store.addError(executeMutation.error);
    store.setStep('review');
  }, [executeMutation.error]);

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
        description={t('autopilot.emptyState.description')}
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
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--sf-border)]">
          <button
            className="px-3 py-1 text-xs rounded bg-[var(--sf-bg-input)] text-text-primary hover:bg-[var(--sf-bg-hover)] transition-colors"
            onClick={() => setShowReport(false)}
            data-testid="back-from-report"
          >
            {t('common.back')}
          </button>
          <h2 className="text-sm font-semibold text-text-primary">{t('autopilot.report.title')}</h2>
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
        {/* Header with title and optional report button */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--sf-border)]">
          <h2
            ref={executionHeading}
            tabIndex={-1}
            className="text-sm font-semibold text-text-primary"
          >
            {t('autopilot.title')}
          </h2>
          {step === 'completed' && (
            <button
              className="px-3 py-1.5 text-xs font-medium rounded bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] hover:bg-[var(--sf-button-hover)] transition-colors"
              onClick={() => setShowReport(true)}
              data-testid="view-compliance-report"
            >
              {t('autopilot.report.title')}
            </button>
          )}
        </div>
        {/* Grappe progress panel — shown when grappe mode is active */}
        <AutopilotGrappePanel />
        {/* Split view: graph placeholder (left 60%) + control panel (right 40%) */}
        <div className="flex flex-1 overflow-hidden">
          <div
            className="w-[60%] overflow-hidden border-r border-[var(--sf-border)]"
            data-testid="autopilot-graph-area"
          >
            <AutopilotGraph />
          </div>
          <div className="w-[40%] overflow-hidden">
            <ControlPanel />
          </div>
        </div>
      </div>
    );
  }

  return null;
};
