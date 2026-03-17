import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GeneratedReport } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';

/** ExecutionReportView component props. */
export interface ExecutionReportViewProps {
  reports?: GeneratedReport[];
  selectedReportId?: string;
  onSelectReport?: (id: string) => void;
  onExport?: (id: string) => void;
  className?: string;
}

/** Formats a report type into a human-readable label. */
function formatReportType(type: string): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** View for displaying execution reports with detail panel. */
export const ExecutionReportView: React.FC<ExecutionReportViewProps> = ({
  reports,
  selectedReportId,
  onSelectReport,
  onExport,
  className,
}) => {
  const { t } = useTranslation();
  const selectedReport = reports?.find((r) => r.id === selectedReportId);

  return (
    <div data-testid="execution-report-view" className={className}>
      {!reports || reports.length === 0 ? (
        <EmptyState title={t('reports.noReports')} />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Report list */}
          <div className="flex flex-col gap-2">
            {reports.map((report) => (
              <div key={report.id} data-testid={`report-${report.id}`}>
                <Card
                  hoverable
                  onClick={() => onSelectReport?.(report.id)}
                  className={selectedReportId === report.id ? 'ring-1 ring-[var(--vscode-focusBorder,#007fd4)]' : ''}
                >
                  <CardBody>
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                          {report.title}
                        </span>
                        <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                          {report.summary}
                        </span>
                      </div>
                      <Badge variant="info">{formatReportType(report.type)}</Badge>
                    </div>
                  </CardBody>
                </Card>
              </div>
            ))}
          </div>

          {/* Detail panel */}
          {selectedReport && (
            <div data-testid="report-detail">
              <Card>
                <CardHeader title={selectedReport.title} />
                <CardBody>
                  <div className="flex flex-col gap-3">
                    {/* Metadata */}
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="default">{selectedReport.metadata.module}</Badge>
                      {selectedReport.metadata.recordCount !== undefined && (
                        <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                          {selectedReport.metadata.recordCount} {t('reports.recordCount').toLowerCase()}
                        </span>
                      )}
                      {selectedReport.metadata.duration !== undefined && (
                        <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                          {(selectedReport.metadata.duration / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>

                    {/* Sections */}
                    {selectedReport.sections.map((section, i) => (
                      <div key={i} className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                          {section.title}
                        </span>
                        {section.type === 'table' && Array.isArray(section.content['rows']) && (
                          <div data-testid="report-table" className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                            {(section.content['rows'] as Record<string, unknown>[]).map((row, ri) => (
                              <div key={ri} className="flex gap-2 py-0.5 border-b border-[var(--vscode-panel-border,#3c3c3c)]">
                                {Object.entries(row).map(([k, v]) => (
                                  <span key={k}>{k}: {String(v as string)}</span>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                        {section.type === 'text' && section.content['text'] != null && (
                          <p className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                            {String(section.content['text'])}
                          </p>
                        )}
                        {section.type === 'summary' && (
                          <div className="flex flex-wrap gap-2">
                            {Object.entries(section.content).map(([k, v]) => (
                              <Badge key={k} variant="default">{k}: {String(v)}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Export button */}
                    {onExport && (
                      <button
                        data-testid="export-report-btn"
                        onClick={() => onExport(selectedReport.id)}
                        className="self-start px-3 py-1 text-xs rounded bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#ffffff)] hover:bg-[var(--vscode-button-hoverBackground,#1177bb)]"
                      >
                        {t('reports.exportReport')}
                      </button>
                    )}
                  </div>
                </CardBody>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
