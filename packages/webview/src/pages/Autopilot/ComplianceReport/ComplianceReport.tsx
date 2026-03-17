import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { ComplianceTimeline } from './ComplianceTimeline';

/** Compliance report table showing all anonymized fields. */
export const ComplianceReport: React.FC = () => {
  const { t } = useTranslation();
  const framework = useAutopilotStore((s) => s.complianceFramework);
  const rules = useAutopilotStore((s) => s.rules);
  const graph = useAutopilotStore((s) => s.graph);
  const executionStatus = useAutopilotStore((s) => s.executionStatus);

  const piiDetected = rules.length;
  const piiAnonymized = graph
    ? rules.filter((r) =>
        graph.nodes.find(
          (n) => n.objectApiName === r.objectApiName && n.status === 'completed',
        ),
      ).length
    : 0;

  /** Overall status indicator. */
  const overallStatus =
    executionStatus === 'completed' && piiAnonymized === piiDetected
      ? 'pass'
      : executionStatus === 'completed' && piiAnonymized > 0
        ? 'partial'
        : executionStatus === 'failed'
          ? 'fail'
          : 'partial';

  /** Map framework type to display label. */
  const frameworkLabel = framework === 'none'
    ? t('autopilot.step3.none')
    : t(`autopilot.step3.${framework}`);

  /** Export rules as JSON. */
  const handleExportJson = useCallback((): void => {
    const data = {
      framework,
      status: overallStatus,
      piiDetected,
      piiAnonymized,
      rules: rules.map((r) => ({
        object: r.objectApiName,
        field: r.fieldApiName,
        category: r.piiCategory,
        method: r.method,
      })),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compliance-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [framework, overallStatus, piiDetected, piiAnonymized, rules]);

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="compliance-report">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('autopilot.report.title')}
        </h3>
        <button
          className="px-3 py-1.5 text-xs font-medium rounded bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)] hover:bg-[var(--vscode-button-hoverBackground,#1177bb)] transition-colors"
          onClick={handleExportJson}
          data-testid="compliance-export-json"
        >
          {t('autopilot.report.exportJson')}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="flex flex-col gap-0.5 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.report.framework')}
          </span>
          <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]" data-testid="report-framework">
            {frameworkLabel}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.report.status')}
          </span>
          <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]" data-testid="report-status">
            {t(`autopilot.report.${overallStatus}`)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.report.piiDetected')}
          </span>
          <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {piiDetected}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
          <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
            {t('autopilot.report.piiAnonymized')}
          </span>
          <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {piiAnonymized}
          </span>
        </div>
      </div>

      {/* Rules table */}
      <div className="rounded border border-[var(--vscode-panel-border,#3c3c3c)] overflow-hidden">
        <table className="w-full text-xs" data-testid="compliance-rules-table">
          <thead>
            <tr className="bg-[var(--vscode-editor-background,#1e1e1e)] text-left text-[var(--vscode-descriptionForeground,#868686)]">
              <th className="py-2 px-3 font-medium">{t('autopilot.report.object')}</th>
              <th className="py-2 px-3 font-medium">{t('autopilot.report.field')}</th>
              <th className="py-2 px-3 font-medium">{t('autopilot.report.category')}</th>
              <th className="py-2 px-3 font-medium">{t('autopilot.report.method')}</th>
              <th className="py-2 px-3 font-medium">{t('autopilot.report.rule')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-center text-[var(--vscode-descriptionForeground,#868686)]">
                  {t('common.noData')}
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr
                  key={`${rule.objectApiName}-${rule.fieldApiName}`}
                  className="border-t border-[var(--vscode-panel-border,#3c3c3c)]"
                >
                  <td className="py-1.5 px-3 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.objectApiName}</td>
                  <td className="py-1.5 px-3 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.fieldApiName}</td>
                  <td className="py-1.5 px-3 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.piiCategory}</td>
                  <td className="py-1.5 px-3 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.method}</td>
                  <td className="py-1.5 px-3 text-[var(--vscode-editor-foreground,#d4d4d4)]">{rule.method}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Timeline */}
      <div>
        <h4 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)] mb-2">
          {t('autopilot.report.title')} — Timeline
        </h4>
        <ComplianceTimeline />
      </div>
    </div>
  );
};
