import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, CheckCircle, Eye, EyeOff, ChevronDown } from 'lucide-react';
import type { AlertInstance, AlertStatus, AlertSeverity } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import type { BadgeVariant } from '../../components/ui/Badge';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';

/** Payload returned by monitor:alerts:result (includes history). */
interface AlertsWithHistoryPayload {
  alerts: AlertInstance[];
  history: AlertInstance[];
}

/** AlertHistoryPanel component props. */
export interface AlertHistoryPanelProps {
  /** Additional CSS class names. */
  className?: string;
}

/** Maximum number of history entries to display initially. */
const INITIAL_DISPLAY_LIMIT = 100;

/** Map alert status to badge variant. */
function statusBadgeVariant(status: AlertStatus): BadgeVariant {
  switch (status) {
    case 'active':
      return 'error';
    case 'acknowledged':
      return 'warning';
    case 'resolved':
      return 'success';
    case 'dismissed':
      return 'default';
  }
}

/** Map alert severity to badge variant. */
function severityBadgeVariant(severity: AlertSeverity): BadgeVariant {
  switch (severity) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
  }
}

/** Status icon for the timeline. */
function StatusIcon({ status }: { status: AlertStatus }): React.ReactElement {
  switch (status) {
    case 'active':
      return (
        <span className="relative flex h-3 w-3" data-testid="status-icon-active">
          <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
        </span>
      );
    case 'acknowledged':
      return <Eye className="h-3.5 w-3.5 text-amber-400" />;
    case 'resolved':
      return <CheckCircle className="h-3.5 w-3.5 text-green-400" />;
    case 'dismissed':
      return <EyeOff className="h-3.5 w-3.5 text-gray-400" />;
  }
}

/** Date formatter for group headers (medium date). */
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** Time formatter for timestamps. */
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Group alerts by date string. */
function groupByDate(alerts: AlertInstance[]): Map<string, AlertInstance[]> {
  const groups = new Map<string, AlertInstance[]>();
  for (const alert of alerts) {
    const dateKey = dateFmt.format(new Date(alert.triggeredAt));
    const group = groups.get(dateKey);
    if (group) {
      group.push(alert);
    } else {
      groups.set(dateKey, [alert]);
    }
  }
  return groups;
}

/**
 * Panel displaying the full alert history as a timeline.
 *
 * Shows triggered, acknowledged, resolved, and dismissed alerts
 * grouped by date with status badges and timestamps.
 */
export const AlertHistoryPanel: React.FC<AlertHistoryPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const [displayLimit, setDisplayLimit] = useState(INITIAL_DISPLAY_LIMIT);

  const alertsQuery = useBridgeQuery<AlertsWithHistoryPayload>('monitor:alerts', undefined, {
    responseType: 'monitor:alerts:result',
  });

  const history = useMemo(() => alertsQuery.data?.history ?? [], [alertsQuery.data?.history]);

  /** Sorted history descending by triggeredAt. */
  const sortedHistory = useMemo(
    () =>
      [...history].sort(
        (a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime(),
      ),
    [history],
  );

  /** Visible entries capped at displayLimit. */
  const visibleEntries = useMemo(
    () => sortedHistory.slice(0, displayLimit),
    [sortedHistory, displayLimit],
  );

  /** Grouped by date for the timeline display. */
  const dateGroups = useMemo(() => groupByDate(visibleEntries), [visibleEntries]);

  const hasMore = sortedHistory.length > displayLimit;

  return (
    <Card
      className={cn('border-0 bg-transparent shadow-none', className)}
      data-testid="alert-history-panel"
    >
      <CardHeader
        title={t('monitor.alertHistory', 'Alert History')}
        subtitle={t('monitor.alertHistoryCount', {
          count: history.length,
          defaultValue: '{{count}} events',
        })}
        action={
          <div className="flex items-center gap-1 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
            <Clock className="h-3 w-3" />
            <span>{t('monitor.alertHistoryTimeline', 'Timeline')}</span>
          </div>
        }
      />
      <CardBody
        className="flex flex-col gap-3 max-h-96 overflow-y-auto"
        data-testid="alert-history-body"
      >
        {history.length === 0 ? (
          <p
            className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-6"
            data-testid="alert-history-empty"
          >
            {t('monitor.noAlertHistory', 'No alert history yet')}
          </p>
        ) : (
          <>
            {Array.from(dateGroups.entries()).map(([dateKey, alerts]) => (
              <div
                key={dateKey}
                className="flex flex-col gap-1.5"
                data-testid={`date-group-${dateKey}`}
              >
                {/* Date group header */}
                <div className="flex items-center gap-2 mt-1 mb-0.5">
                  <span className="text-[10px] font-semibold text-[var(--vscode-descriptionForeground,#868686)] uppercase tracking-wider">
                    {dateKey}
                  </span>
                  <div className="flex-1 h-px bg-[var(--vscode-panel-border,#3c3c3c)]" />
                </div>

                {/* Alert entries for this date */}
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-start gap-2 p-2 rounded bg-[var(--vscode-editorWidget-background,#252526)] border border-[var(--vscode-panel-border,#3c3c3c)]"
                    data-testid={`history-entry-${alert.id}`}
                  >
                    {/* Left: Status icon */}
                    <div className="mt-0.5 shrink-0">
                      <StatusIcon status={alert.status} />
                    </div>

                    {/* Center: Alert details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span data-testid={`status-badge-${alert.id}`}>
                          <Badge variant={statusBadgeVariant(alert.status)}>{alert.status}</Badge>
                        </span>
                        <span data-testid={`severity-badge-${alert.id}`}>
                          <Badge variant={severityBadgeVariant(alert.severity)}>
                            {alert.severity}
                          </Badge>
                        </span>
                      </div>
                      <p className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)] mt-1 leading-snug">
                        {alert.message}
                      </p>
                      <p className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] mt-0.5 font-mono">
                        {t('monitor.alertValue', 'Value')}: {alert.currentValue} (
                        {t('monitor.alertThreshold', 'threshold')}: {alert.threshold})
                      </p>
                    </div>

                    {/* Right: Timestamps */}
                    <div className="shrink-0 text-right flex flex-col gap-0.5">
                      <span
                        className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]"
                        data-testid={`triggered-time-${alert.id}`}
                      >
                        {timeFmt.format(new Date(alert.triggeredAt))}
                      </span>
                      {alert.acknowledgedAt && (
                        <span
                          className="text-[10px] text-amber-400"
                          data-testid={`acknowledged-time-${alert.id}`}
                        >
                          {t('monitor.ack', 'Ack')}:{' '}
                          {timeFmt.format(new Date(alert.acknowledgedAt))}
                        </span>
                      )}
                      {alert.resolvedAt && (
                        <span
                          className="text-[10px] text-green-400"
                          data-testid={`resolved-time-${alert.id}`}
                        >
                          {t('monitor.resolved', 'Resolved')}:{' '}
                          {timeFmt.format(new Date(alert.resolvedAt))}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {/* Show more button */}
            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="self-center mt-1"
                onClick={() => setDisplayLimit((prev) => prev + INITIAL_DISPLAY_LIMIT)}
                data-testid="show-more-btn"
              >
                <ChevronDown className="w-3 h-3 mr-1" />
                {t('monitor.showMore', 'Show more')} ({sortedHistory.length - displayLimit}{' '}
                {t('monitor.remaining', 'remaining')})
              </Button>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
};
