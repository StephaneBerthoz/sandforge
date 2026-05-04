import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/** Timeline entry for a compliance event. */
interface TimelineEntry {
  timestamp: string;
  objectName: string;
  event: string;
  fieldsAnonymized: number;
}

/** Timeline of compliance events during execution (scan, anonymization per object). */
export const ComplianceTimeline: React.FC = () => {
  const { t } = useTranslation();
  const graph = useAutopilotStore((s) => s.graph);
  const rules = useAutopilotStore((s) => s.rules);

  /** Build timeline entries from graph nodes and rules. */
  const entries: TimelineEntry[] = React.useMemo(() => {
    if (!graph) return [];
    return graph.nodes
      .filter(
        (n) => n.status === 'completed' || n.status === 'loading' || n.status === 'anonymizing',
      )
      .map((node) => {
        const nodeRuleCount = rules.filter((r) => r.objectApiName === node.objectApiName).length;
        return {
          timestamp: new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(new Date()),
          objectName: node.objectApiName,
          event:
            node.status === 'anonymizing'
              ? t('autopilot.graph.anonymizing')
              : t('autopilot.graph.completed'),
          fieldsAnonymized: nodeRuleCount,
        };
      });
  }, [graph, rules, t]);

  if (entries.length === 0) {
    return (
      <div
        className="flex items-center justify-center py-8 text-sm text-[var(--vscode-descriptionForeground,#868686)]"
        data-testid="compliance-timeline-empty"
      >
        {t('common.noData')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="compliance-timeline">
      {entries.map((entry, idx) => (
        <div
          key={`${entry.objectName}-${idx}`}
          className="flex items-start gap-3 px-3 py-2 rounded bg-[var(--vscode-editor-background,#1e1e1e)]"
        >
          <div className="w-2 h-2 mt-1.5 rounded-full bg-[var(--vscode-progressBar-background,#0e70c0)] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {entry.objectName}
              </span>
              <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                {entry.timestamp}
              </span>
            </div>
            <div className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
              {entry.event} — {entry.fieldsAnonymized}{' '}
              {t('autopilot.control.piiFields').toLowerCase()}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
