import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/** Shows active compliance framework badge, rules count, and PII fields detected. */
export const ComplianceStatus: React.FC = () => {
  const { t } = useTranslation();
  const framework = useAutopilotStore((s) => s.complianceFramework);
  const rules = useAutopilotStore((s) => s.rules);
  const graph = useAutopilotStore((s) => s.graph);

  const piiFieldCount = rules.length;
  const objectsWithPii = new Set(rules.map((r) => r.objectApiName)).size;
  const totalNodes = graph?.nodes.length ?? 0;

  /** Map framework type to i18n key. */
  const frameworkLabel =
    framework === 'none' ? t('autopilot.step3.none') : t(`autopilot.step3.${framework}`);

  return (
    <div className="flex flex-col gap-3" data-testid="compliance-status">
      {/* Framework badge */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
          {t('autopilot.report.framework')}:
        </span>
        <span
          className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-[var(--vscode-badge-background,#4d4d4d)] text-[var(--vscode-badge-foreground,#d4d4d4)]"
          data-testid="framework-badge"
        >
          {frameworkLabel}
        </span>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="flex flex-col gap-0.5 p-2 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {rules.length}
          </span>
          <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.report.rule')}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-2 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {piiFieldCount}
          </span>
          <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.control.piiFields')}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-2 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {objectsWithPii} / {totalNodes}
          </span>
          <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
            {t('common.object')}
          </span>
        </div>
      </div>
    </div>
  );
};
