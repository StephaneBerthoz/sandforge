import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiLimit } from '@sandforge/shared';
import { cn } from '../../theme';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

/** LimitsPanel component props. */
export interface LimitsPanelProps {
  limits: ApiLimit[];
  className?: string;
}

/** Determine variant based on usage percentage. */
function limitVariant(usedPercent: number): 'default' | 'success' | 'warning' | 'error' {
  if (usedPercent >= 90) return 'error';
  if (usedPercent >= 70) return 'warning';
  return 'default';
}

/** Panel displaying Salesforce API limits as gauges. */
export const LimitsPanel: React.FC<LimitsPanelProps> = ({ limits, className }) => {
  const { t } = useTranslation();
  const sorted = [...limits].sort((a, b) => b.usedPercent - a.usedPercent);

  return (
    <Card className={className}>
      <CardHeader title={t('monitor.limits')} subtitle={`${limits.length} limits tracked`} />
      <CardBody className="flex flex-col gap-3 max-h-80 overflow-y-auto">
        {sorted.length === 0 ? (
          <p className="text-xs text-text-secondary text-center py-4">{t('common.noData')}</p>
        ) : (
          sorted.map((limit) => (
            <div key={limit.name} data-testid={`limit-${limit.name}`}>
              <div className="flex justify-between items-center mb-0.5">
                <span className="text-xs text-text-primary truncate">{limit.name}</span>
                <span
                  className={cn(
                    'text-[10px] font-mono',
                    limit.usedPercent >= 90
                      ? 'text-[var(--sf-error)]'
                      : limit.usedPercent >= 70
                        ? 'text-[var(--sf-warning)]'
                        : 'text-text-secondary',
                  )}
                >
                  {limit.remaining.toLocaleString()} / {limit.max.toLocaleString()}
                </span>
              </div>
              <ProgressBar
                value={limit.usedPercent}
                variant={limitVariant(limit.usedPercent)}
                size="sm"
              />
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
};
