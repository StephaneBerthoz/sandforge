import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineHistoryEntry, PipelineRunStatus } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDuration } from '../../utils/formatters';

/** PipelineHistoryView component props. */
export interface PipelineHistoryViewProps {
  entries?: PipelineHistoryEntry[];
  onSelectRun?: (runId: string) => void;
}

const STATUS_VARIANT: Record<
  PipelineRunStatus,
  'default' | 'success' | 'warning' | 'error' | 'info'
> = {
  idle: 'default',
  queued: 'info',
  running: 'info',
  paused: 'warning',
  waiting_approval: 'warning',
  completed: 'success',
  completed_with_warnings: 'warning',
  failed: 'error',
  cancelled: 'default',
};

/** View of pipeline execution history. */
export const PipelineHistoryView: React.FC<PipelineHistoryViewProps> = ({
  entries = [],
  onSelectRun,
}) => {
  const { t } = useTranslation();

  if (entries.length === 0) {
    return (
      <div data-testid="pipeline-history">
        <EmptyState
          icon="📜"
          title={t('automation.noHistory')}
          description={t('automation.history')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="pipeline-history">
      <h3 className="text-xs font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('automation.history')}
      </h3>
      {entries.map((entry) => (
        <div key={entry.runId} data-testid={`history-${entry.runId}`}>
          <Card hoverable onClick={() => onSelectRun?.(entry.runId)}>
            <CardHeader
              title={entry.pipelineName}
              subtitle={entry.startTime}
              action={
                <Badge variant={STATUS_VARIANT[entry.status]}>
                  {t(`automation.runStatuses.${entry.status}`)}
                </Badge>
              }
            />
            <CardBody>
              <div className="flex gap-4 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                <span>
                  {t('automation.triggeredBy')}: {t(`automation.triggerTypes.${entry.triggeredBy}`)}
                </span>
                <span>
                  {t('automation.duration')}: {formatDuration(entry.duration)}
                </span>
                <span>
                  {entry.stepCount} {t('automation.steps')}
                </span>
                {entry.errorCount > 0 && (
                  <span className="text-red-400">
                    {entry.errorCount} {t('automation.errors')}
                  </span>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
