import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  AutopilotGraph as AutopilotGraphType,
  AutopilotNodeStatus,
  ExecutionPlan,
} from '@sandforge/shared';
import { useAutopilotStore } from '../../stores/useAutopilotStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { useMessageListener } from '../../hooks/useMessageBus';
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
    store.updateLiveStats({ currentWave: msg.payload.wave });
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

  const isWizardStep =
    step === 'connect' || step === 'objects' || step === 'compliance' || step === 'review';
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
        <AutopilotWizard />
      </div>
    );
  }

  if (isExecutionStep) {
    return (
      <div className="flex flex-col h-full" data-testid="autopilot-page">
        {/* Header with title and optional report button */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--sf-border)]">
          <h2 className="text-sm font-semibold text-text-primary">{t('autopilot.title')}</h2>
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
