import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/** Placeholder preview of anonymized data for the selected node. */
export const AnonymizationPreview: React.FC = () => {
  const { t } = useTranslation();
  const selectedNode = useAutopilotStore((s) => s.selectedNode());
  const rules = useAutopilotStore((s) => s.rules);

  if (!selectedNode) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-[var(--vscode-descriptionForeground,#868686)]" data-testid="anonymization-preview-empty">
        {t('autopilot.control.noNodeSelected')}
      </div>
    );
  }

  const nodeRules = rules.filter((r) => r.objectApiName === selectedNode.objectApiName);

  if (nodeRules.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-[var(--vscode-descriptionForeground,#868686)]" data-testid="anonymization-preview-no-rules">
        {t('autopilot.step3.none')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="anonymization-preview">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[var(--vscode-descriptionForeground,#868686)]">
            <th className="py-1 px-2 font-medium">{t('autopilot.report.field')}</th>
            <th className="py-1 px-2 font-medium">{t('autopilot.report.method')}</th>
            <th className="py-1 px-2 font-medium">{t('autopilot.report.category')}</th>
          </tr>
        </thead>
        <tbody>
          {nodeRules.map((rule) => (
            <tr
              key={`${rule.objectApiName}-${rule.fieldApiName}`}
              className="border-t border-[var(--vscode-panel-border,#3c3c3c)]"
            >
              <td className="py-1 px-2 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.fieldApiName}</td>
              <td className="py-1 px-2 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.method}</td>
              <td className="py-1 px-2 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.piiCategory}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
