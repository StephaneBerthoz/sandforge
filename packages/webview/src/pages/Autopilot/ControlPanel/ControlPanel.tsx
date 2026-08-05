import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { LiveStats } from './LiveStats';
import { NodeDetail } from './NodeDetail';
import { AnonymizationPreview } from './AnonymizationPreview';
import { ComplianceStatus } from './ComplianceStatus';

/** Tab identifiers for the control panel. */
type ControlTab = 'stats' | 'node' | 'anonymization' | 'compliance';

/** Tesla-style side panel with live stats, node detail, anonymization preview, and compliance. */
export const ControlPanel: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ControlTab>('stats');
  const executionStatus = useAutopilotStore((s) => s.executionStatus);
  const setExecutionStatus = useAutopilotStore((s) => s.setExecutionStatus);
  const selectedNodeName = useAutopilotStore((s) => s.selectedNodeName);
  const updateNodeStatus = useAutopilotStore((s) => s.updateNodeStatus);
  const failedCount = useAutopilotStore((s) => s.failedCount());

  const isPaused = executionStatus === 'paused';
  const isExecuting = executionStatus === 'executing' || executionStatus === 'paused';

  const tabs: { id: ControlTab; label: string }[] = [
    { id: 'stats', label: t('autopilot.control.liveStats') },
    { id: 'node', label: t('autopilot.control.nodeDetail') },
    { id: 'anonymization', label: t('autopilot.control.anonymization') },
    { id: 'compliance', label: t('autopilot.control.compliance') },
  ];

  /** Handle pause/resume toggle. */
  const handlePauseResume = (): void => {
    setExecutionStatus(isPaused ? 'executing' : 'paused');
  };

  /** Handle skip node action. */
  const handleSkipNode = (): void => {
    if (selectedNodeName) {
      updateNodeStatus(selectedNodeName, 'skipped');
    }
  };

  /** Handle retry failed nodes. */
  const handleRetryFailed = (): void => {
    const graph = useAutopilotStore.getState().graph;
    if (!graph) return;
    graph.nodes
      .filter((n) => n.status === 'failed')
      .forEach((n) => updateNodeStatus(n.objectApiName, 'pending', 0));
  };

  return (
    <div className="flex flex-col h-full" data-testid="control-panel">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--sf-border)]">
        <h3 className="text-sm font-semibold text-text-primary">{t('autopilot.control.title')}</h3>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--sf-border)]" data-testid="control-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-text-primary border-b-2 border-[var(--sf-accent)]'
                : 'text-text-secondary hover:text-text-primary'
            }`}
            onClick={() => setActiveTab(tab.id)}
            data-testid={`control-tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'stats' && <LiveStats />}
        {activeTab === 'node' && <NodeDetail />}
        {activeTab === 'anonymization' && <AnonymizationPreview />}
        {activeTab === 'compliance' && <ComplianceStatus />}
      </div>

      {/* Action Buttons */}
      {isExecuting && (
        <div
          className="flex gap-2 px-4 py-3 border-t border-[var(--sf-border)]"
          data-testid="control-actions"
        >
          <button
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] hover:bg-[var(--sf-button-hover)] transition-colors"
            onClick={handlePauseResume}
            data-testid="control-pause-resume"
          >
            {isPaused ? t('autopilot.control.resume') : t('autopilot.control.pause')}
          </button>
          <button
            className="px-3 py-1.5 text-xs font-medium rounded bg-[var(--sf-bg-input)] text-text-primary hover:bg-[var(--sf-bg-hover)] transition-colors disabled:opacity-50"
            onClick={handleSkipNode}
            disabled={!selectedNodeName}
            data-testid="control-skip"
          >
            {t('autopilot.control.skip')}
          </button>
          <button
            className="px-3 py-1.5 text-xs font-medium rounded bg-[var(--sf-bg-input)] text-text-primary hover:bg-[var(--sf-bg-hover)] transition-colors disabled:opacity-50"
            onClick={handleRetryFailed}
            disabled={failedCount === 0}
            data-testid="control-retry"
          >
            {t('autopilot.control.retry')}
          </button>
        </div>
      )}
    </div>
  );
};
