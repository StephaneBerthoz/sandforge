import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { useSendMessage } from '../../../hooks/useMessageBus';
import { buildMessage } from '../../../bridge/messageHelpers';
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
  const sendMessage = useSendMessage();

  const isPaused = executionStatus === 'paused';
  const isExecuting = executionStatus === 'executing' || executionStatus === 'paused';

  const tabs: { id: ControlTab; label: string }[] = [
    { id: 'stats', label: t('autopilot.control.liveStats') },
    { id: 'node', label: t('autopilot.control.nodeDetail') },
    { id: 'anonymization', label: t('autopilot.control.anonymization') },
    { id: 'compliance', label: t('autopilot.control.compliance') },
  ];

  /** Pause/resume — fire-and-forget bridge commands, optimistic local status. */
  const handlePauseResume = (): void => {
    sendMessage(buildMessage(isPaused ? 'autopilot:resume' : 'autopilot:pause'));
    setExecutionStatus(isPaused ? 'executing' : 'paused');
  };

  /** Skip the selected node — bridge command, optimistic local status. */
  const handleSkipNode = (): void => {
    if (selectedNodeName) {
      sendMessage(buildMessage('autopilot:skip-node', { objectApiName: selectedNodeName }));
      updateNodeStatus(selectedNodeName, 'skipped');
    }
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
        </div>
      )}
    </div>
  );
};
