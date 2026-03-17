import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/** Shows details of the selected node in the dependency graph. */
export const NodeDetail: React.FC = () => {
  const { t } = useTranslation();
  const selectedNode = useAutopilotStore((s) => s.selectedNode());
  const rules = useAutopilotStore((s) => s.rules);

  if (!selectedNode) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-[var(--vscode-descriptionForeground,#868686)]" data-testid="node-detail-empty">
        {t('autopilot.control.noNodeSelected')}
      </div>
    );
  }

  const nodeRules = rules.filter((r) => r.objectApiName === selectedNode.objectApiName);
  const piiFields = nodeRules.map((r) => r.fieldApiName);

  return (
    <div className="flex flex-col gap-3" data-testid="node-detail">
      {/* Object Name */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {selectedNode.objectApiName}
        </h4>
        <span
          className="px-2 py-0.5 text-[10px] rounded-full font-medium uppercase"
          data-testid="node-status-badge"
        >
          {t(`autopilot.graph.${selectedNode.status}`)}
        </span>
      </div>

      {/* Progress */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-[var(--vscode-descriptionForeground,#868686)]">
          <span>{t('common.progress')}</span>
          <span>{selectedNode.progress}%</span>
        </div>
        <div className="w-full h-2 rounded bg-[var(--vscode-input-background,#3c3c3c)]">
          <div
            className="h-full rounded bg-[var(--vscode-progressBar-background,#0e70c0)] transition-all duration-300"
            style={{ width: `${selectedNode.progress}%` }}
          />
        </div>
      </div>

      {/* Record Count */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.control.recordsProcessed')}
          </span>
          <span className="font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {selectedNode.successCount?.toLocaleString() ?? 0} / {selectedNode.recordCount.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.control.errors')}
          </span>
          <span className="font-medium text-[var(--vscode-errorForeground,#f48771)]">
            {selectedNode.failureCount ?? 0}
          </span>
        </div>
      </div>

      {/* PII Fields */}
      {piiFields.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.control.piiFields')} ({piiFields.length})
          </span>
          <div className="flex flex-wrap gap-1">
            {piiFields.map((field) => (
              <span
                key={field}
                className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--vscode-badge-background,#4d4d4d)] text-[var(--vscode-badge-foreground,#d4d4d4)]"
              >
                {field}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
