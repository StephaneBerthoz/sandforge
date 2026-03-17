import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineTrigger } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';

/** Scheduled pipeline entry. */
export interface ScheduledPipeline {
  pipelineId: string;
  pipelineName: string;
  trigger: PipelineTrigger;
  nextFireTime?: string;
}

/** SchedulerCalendar component props. */
export interface SchedulerCalendarProps {
  scheduled?: ScheduledPipeline[];
}

/** Calendar-like view of scheduled pipeline executions. */
export const SchedulerCalendar: React.FC<SchedulerCalendarProps> = ({
  scheduled = [],
}) => {
  const { t } = useTranslation();

  if (scheduled.length === 0) {
    return (
      <div data-testid="scheduler-calendar">
        <EmptyState
          icon="calendar"
          title={t('automation.scheduler')}
          description={t('automation.noPipelines')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="scheduler-calendar">
      <h3 className="text-xs font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('automation.scheduler')}
      </h3>
      {scheduled.map((item) => (
        <div key={item.pipelineId} data-testid={`scheduled-${item.pipelineId}`}>
        <Card>
          <CardHeader
            title={item.pipelineName}
            subtitle={item.trigger.config.cron ?? ''}
            action={
              <Badge variant={item.trigger.enabled ? 'success' : 'default'}>
                {item.trigger.enabled ? t('common.active') : t('common.disabled')}
              </Badge>
            }
          />
          <CardBody>
            <div className="flex gap-4 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              <span>{t('automation.triggerTypes.' + item.trigger.type)}</span>
              {item.nextFireTime && (
                <span>{t('automation.nextRun')}: {item.nextFireTime}</span>
              )}
              {item.trigger.config.timezone && (
                <span>{t('automation.timezone')}: {item.trigger.config.timezone}</span>
              )}
            </div>
          </CardBody>
        </Card>
        </div>
      ))}
    </div>
  );
};
