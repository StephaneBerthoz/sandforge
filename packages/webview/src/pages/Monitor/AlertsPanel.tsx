import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AlertInstance, AlertSeverity } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import type { BadgeVariant } from '../../components/ui/Badge';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';

/** Payload returned by monitor:alerts:result. */
interface AlertsPayload {
  alerts: AlertInstance[];
}

/** AlertsPanel component props. */
export interface AlertsPanelProps {
  /** Pre-fetched alerts to display. When provided, skips the bridge query. */
  alerts?: AlertInstance[];
  /** External acknowledge handler (overrides bridge mutation). */
  onAcknowledge?: (id: string) => void;
  /** External dismiss handler (overrides bridge mutation). */
  onDismiss?: (id: string) => void;
  className?: string;
}

const severityVariant: Record<AlertSeverity, BadgeVariant> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

const severityIcon: Record<AlertSeverity, string> = {
  info: '\u2139',
  warning: '\u26A0',
  critical: '\u2716',
};

/** Panel displaying active alerts with severity indicators. */
export const AlertsPanel: React.FC<AlertsPanelProps> = React.memo(
  ({
    alerts: alertsProp,
    onAcknowledge: onAcknowledgeProp,
    onDismiss: onDismissProp,
    className,
  }) => {
    const { t } = useTranslation();

    /** Bridge query for alerts — skipped when alerts are provided via props. */
    const alertsQuery = useBridgeQuery<AlertsPayload>('monitor:alerts', undefined, {
      responseType: 'monitor:alerts:result',
      skip: alertsProp !== undefined,
    });

    /** Bridge mutation for acknowledging an alert. */
    const acknowledgeMutation = useBridgeMutation<{ success: boolean }>(
      'monitor:alert:acknowledge',
      {
        responseType: 'monitor:alert:acknowledge:response',
      },
    );

    /** Bridge mutation for dismissing an alert. */
    const dismissMutation = useBridgeMutation<{ success: boolean }>('monitor:alert:dismiss', {
      responseType: 'monitor:alert:dismiss:response',
    });

    /** Refetch alerts after a successful acknowledge or dismiss. */
    useEffect(() => {
      if (acknowledgeMutation.data || dismissMutation.data) {
        alertsQuery.refetch();
      }
    }, [acknowledgeMutation.data, dismissMutation.data, alertsQuery]);

    /** Resolve alerts from props or bridge query. */
    const alerts = alertsProp ?? alertsQuery.data?.alerts ?? [];

    /** Handle acknowledge — use prop callback or bridge mutation. */
    const handleAcknowledge = useCallback(
      (id: string) => {
        if (onAcknowledgeProp) {
          onAcknowledgeProp(id);
        } else {
          acknowledgeMutation.mutate({ alertId: id });
        }
      },
      [onAcknowledgeProp, acknowledgeMutation],
    );

    /** Handle dismiss — use prop callback or bridge mutation. */
    const handleDismiss = useCallback(
      (id: string) => {
        if (onDismissProp) {
          onDismissProp(id);
        } else {
          dismissMutation.mutate({ alertId: id });
        }
      },
      [onDismissProp, dismissMutation],
    );

    const activeAlerts = alerts.filter((a) => a.status === 'active' || a.status === 'acknowledged');

    return (
      <Card className={cn('border-0 bg-transparent shadow-none', className)}>
        <CardHeader
          title={t('monitor.alerts')}
          subtitle={t('monitor.activeAlertCount', {
            count: activeAlerts.length,
            defaultValue: '{{count}} active',
          })}
        />
        <CardBody className="flex flex-col gap-2 max-h-60 overflow-y-auto">
          {activeAlerts.length === 0 ? (
            <p className="text-xs text-text-secondary text-center py-4">{t('monitor.noAlerts')}</p>
          ) : (
            activeAlerts.map((alert) => (
              <div
                key={alert.id}
                className={cn(
                  'flex items-start gap-2 p-2 rounded border-l-3',
                  'bg-[var(--sf-bg-card)]',
                  'border border-[var(--sf-border)]',
                  alert.severity === 'critical' && 'border-l-[var(--sf-error)]',
                  alert.severity === 'warning' && 'border-l-[var(--sf-warning)]',
                  alert.severity === 'info' && 'border-l-[var(--sf-info)]',
                )}
                data-testid={`alert-${alert.id}`}
              >
                <span className="text-sm shrink-0">{severityIcon[alert.severity]}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={severityVariant[alert.severity]}>{alert.severity}</Badge>
                    <span className="text-xs text-text-secondary">
                      {new Intl.DateTimeFormat(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }).format(new Date(alert.triggeredAt))}
                    </span>
                  </div>
                  <p className="text-xs text-text-primary mt-1">{alert.message}</p>
                  <p className="text-[10px] text-text-secondary mt-0.5 font-mono">
                    Value: {alert.currentValue} (threshold: {alert.threshold})
                  </p>
                  <div className="flex gap-2 mt-1.5">
                    {alert.status === 'active' && (
                      <Button variant="ghost" size="sm" onClick={() => handleAcknowledge(alert.id)}>
                        {t('monitor.acknowledge')}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleDismiss(alert.id)}>
                      {t('monitor.dismiss')}
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardBody>
      </Card>
    );
  },
);

AlertsPanel.displayName = 'AlertsPanel';
