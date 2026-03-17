import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../stores/useAutopilotStore';
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
  return <div className="px-4 py-2"><GrappeProgressPanel /></div>;
};

/** Main Autopilot page layout. */
export const AutopilotPage: React.FC = () => {
  const { t } = useTranslation();
  const step = useAutopilotStore((s) => s.step);
  const [showReport, setShowReport] = useState(false);

  const isWizardStep = step === 'connect' || step === 'objects' || step === 'compliance' || step === 'review';
  const isExecutionStep = step === 'executing' || step === 'completed';

  if (showReport) {
    return (
      <div className="flex flex-col h-full" data-testid="autopilot-page">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--vscode-panel-border,#3c3c3c)]">
          <button
            className="px-3 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-editor-foreground,#d4d4d4)] hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors"
            onClick={() => setShowReport(false)}
            data-testid="back-from-report"
          >
            {t('common.back')}
          </button>
          <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('autopilot.report.title')}
          </h2>
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
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--vscode-panel-border,#3c3c3c)]">
          <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('autopilot.title')}
          </h2>
          {step === 'completed' && (
            <button
              className="px-3 py-1.5 text-xs font-medium rounded bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)] hover:bg-[var(--vscode-button-hoverBackground,#1177bb)] transition-colors"
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
          <div className="w-[60%] overflow-hidden border-r border-[var(--vscode-panel-border,#3c3c3c)]" data-testid="autopilot-graph-area">
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
