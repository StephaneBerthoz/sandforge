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

/**
 * Calendar-like view of scheduled pipeline executions.
 *
 * Scheduler is a planned feature (v1.2). The component renders with a
 * "Coming Soon" badge and all interactive controls disabled.
 */
export const SchedulerCalendar: React.FC<SchedulerCalendarProps> = ({ scheduled = [] }) => {
  const { t } = useTranslation();

  if (scheduled.length === 0) {
    return (
      <div className="relative" data-testid="scheduler-calendar">
        <span data-testid="scheduler-coming-soon">
          <Badge variant="info">{t('scheduler.comingSoon')}</Badge>
        </span>
        <div className="opacity-50 pointer-events-none mt-2">
          <EmptyState
            icon="calendar"
            title={t('automation.scheduler')}
            description={t('automation.noPipelines')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative" data-testid="scheduler-calendar">
      <span data-testid="scheduler-coming-soon">
        <Badge variant="info">{t('scheduler.comingSoon')}</Badge>
      </span>
      <div className="opacity-50 pointer-events-none mt-2">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-[var(--sf-text-primary)]">
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
                  <div className="flex gap-4 text-xs text-[var(--sf-text-secondary)]">
                    <span>{t('automation.triggerTypes.' + item.trigger.type)}</span>
                    {item.nextFireTime && (
                      <span>
                        {t('automation.nextRun')}: {item.nextFireTime}
                      </span>
                    )}
                    {item.trigger.config.timezone && (
                      <span>
                        {t('automation.timezone')}: {item.trigger.config.timezone}
                      </span>
                    )}
                  </div>
                </CardBody>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
