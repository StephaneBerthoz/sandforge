import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutopilotStopLeftover } from '@sandforge/shared';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { useSendMessage } from '../../../hooks/useMessageBus';
import { buildMessage } from '../../../bridge/messageHelpers';
import { LiveStats } from './LiveStats';
import { NodeDetail } from './NodeDetail';
import { AnonymizationPreview } from './AnonymizationPreview';
import { ComplianceStatus } from './ComplianceStatus';

/** Tab identifiers for the control panel. */
type ControlTab = 'stats' | 'node' | 'anonymization' | 'compliance';

/** ControlPanel component props. */
export interface ControlPanelProps {
  /**
   * The id of the run's `autopilot:execute` request, under which the
   * extension registers the run: what `execution:abort` names to stop it.
   */
  runOperationId?: string | null;
  /** Set once a stopped run has ended: the objects it did not write whole. */
  notWritten?: string[];
  /**
   * What a stopped run wrote and left unfinished, per object: records that
   * keep a lookup empty, records left a draft.
   */
  leftByStop?: readonly AutopilotStopLeftover[];
}

/** Tesla-style side panel with live stats, node detail, anonymization preview, and compliance. */
export const ControlPanel: React.FC<ControlPanelProps> = ({
  runOperationId,
  notWritten,
  leftByStop = [],
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ControlTab>('stats');
  /** The run Stop was sent for: its button waits for the run to end. */
  const [stopSentFor, setStopSentFor] = useState<string | null>(null);
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

  /**
   * Stop the run. The run had pause and skip and no way to end it: a run
   * started on the wrong objects wrote wave after wave until it was done.
   * `execution:abort` reaches the run through the registry, as Live
   * Operations' Cancel does; the batch in flight is answered, and nothing is
   * written after it.
   */
  const handleStop = (): void => {
    if (!runOperationId) return;
    sendMessage(
      buildMessage<{ operationId: string }>('execution:abort', { operationId: runOperationId }),
    );
    setStopSentFor(runOperationId);
  };
  const stopping = runOperationId !== undefined && stopSentFor === runOperationId;

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
      <div className="px-4 py-3 border-b border-(--sf-border)">
        <h3 className="text-sm font-semibold text-text-primary">{t('autopilot.control.title')}</h3>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-(--sf-border)" data-testid="control-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-text-primary border-b-2 border-(--sf-accent)'
                : 'text-text-secondary hover:text-text-primary'
            }`}
            onClick={() => setActiveTab(tab.id)}
            data-testid={`control-tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {notWritten !== undefined && (
        <div
          className="px-4 py-2 text-xs text-text-primary border-b border-(--sf-border)"
          role="status"
        >
          <p data-testid="control-stopped">
            {notWritten.length > 0
              ? t('autopilot.control.stoppedNotWritten', { list: notWritten.join(', ') })
              : t('autopilot.control.stoppedAllWritten')}
          </p>
          {/* The stop sends neither the second pass nor the statuses set
              aside at insert: records it wrote keep a lookup empty, or stay
              drafts. Said here, with what was not written, so the user
              knows what is left to fix. */}
          {leftByStop.length > 0 && (
            <>
              <p className="mt-1">{t('autopilot.control.stoppedLeftTitle')}</p>
              <ul className="list-disc pl-4" data-testid="control-stopped-left">
                {leftByStop.flatMap((left) => [
                  ...(left.lookupsLeftEmpty
                    ? [
                        <li key={`${left.objectApiName}-lookups`}>
                          {t('autopilot.control.stoppedLookupsLeftEmpty', {
                            object: left.objectApiName,
                            count: left.lookupsLeftEmpty,
                          })}
                        </li>,
                      ]
                    : []),
                  ...(left.statusesNotGivenBack
                    ? [
                        <li key={`${left.objectApiName}-statuses`}>
                          {t('autopilot.control.stoppedStatusesNotGivenBack', {
                            object: left.objectApiName,
                            count: left.statusesNotGivenBack,
                          })}
                        </li>,
                      ]
                    : []),
                ])}
              </ul>
            </>
          )}
        </div>
      )}

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
          className="flex gap-2 px-4 py-3 border-t border-(--sf-border)"
          data-testid="control-actions"
        >
          <button
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-sm bg-(--sf-button-bg) text-(--sf-button-fg) hover:bg-(--sf-button-hover) transition-colors"
            onClick={handlePauseResume}
            data-testid="control-pause-resume"
          >
            {isPaused ? t('autopilot.control.resume') : t('autopilot.control.pause')}
          </button>
          <button
            className="px-3 py-1.5 text-xs font-medium rounded-sm bg-(--sf-bg-input) text-text-primary hover:bg-(--sf-bg-hover) transition-colors disabled:opacity-50"
            onClick={handleSkipNode}
            disabled={!selectedNodeName}
            data-testid="control-skip"
          >
            {t('autopilot.control.skip')}
          </button>
          {runOperationId && (
            <button
              className="px-3 py-1.5 text-xs font-medium rounded-sm bg-(--sf-bg-input) text-status-error hover:bg-(--sf-bg-hover) transition-colors disabled:opacity-50"
              onClick={handleStop}
              disabled={stopping}
              data-testid="control-stop"
            >
              {stopping ? t('autopilot.control.stopping') : t('autopilot.control.stop')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
