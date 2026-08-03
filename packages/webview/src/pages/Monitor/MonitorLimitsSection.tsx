import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import type { ApiLimit } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { useOrgStore } from '../../stores/useOrgStore';
import type { useAnomalyScan } from '../../hooks/useAIFeatures';
import { SectionHeader } from './SectionHeader';
import { PanelOverlay } from './PanelOverlay';
import { usageVariant, usageBadge } from './monitorUtils';
import { formatNumber } from '../../utils/formatters';

/** Props for the MonitorLimitsSection section. */
export interface MonitorLimitsSectionProps {
  /** Limits sorted by usage percentage descending. */
  sortedLimits: ApiLimit[];
  /** Limits at or above 60% usage (shown as header count). */
  criticalLimits: ApiLimit[];
  /** Whether a background refresh is in progress. */
  isRefreshing: boolean;
  /** AI anomaly scan mutation (trigger + loading state). */
  anomalyScan: ReturnType<typeof useAnomalyScan>;
}

/**
 * Governor limits panel with collapsible rows and the anomaly scan action.
 * Subscribes to the selected org itself and owns its expanded state.
 * Memoized — re-renders only when its own slices change.
 */
export const MonitorLimitsSection: React.FC<MonitorLimitsSectionProps> = React.memo(
  ({ sortedLimits, criticalLimits, isRefreshing, anomalyScan }) => {
    const { t } = useTranslation();
    const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
    const [limitsExpanded, setLimitsExpanded] = useState(false);

    return (
      <PanelOverlay isRefreshing={isRefreshing}>
        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <SectionHeader
            title={t('monitor.governorLimits', 'Governor Limits')}
            count={criticalLimits.length > 0 ? criticalLimits.length : undefined}
            collapsed={!limitsExpanded}
            onToggle={() => setLimitsExpanded(!limitsExpanded)}
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => anomalyScan.mutate({ orgId: selectedOrgId, objectName: 'Account' })}
                disabled={anomalyScan.loading}
                loading={anomalyScan.loading}
                data-testid="anomaly-scan-btn"
              >
                <Search className="w-3.5 h-3.5 mr-1" />
                {t('monitor.scanAnomalies', 'Scan')}
              </Button>
            }
          />

          {limitsExpanded && (
            <div className="flex flex-col gap-1.5">
              {sortedLimits.length === 0 ? (
                <p className="text-xs text-text-muted text-center py-4">
                  {t('monitor.noLimits', 'No limits data available')}
                </p>
              ) : (
                sortedLimits.map((l) => {
                  const used = l.max - l.remaining;
                  return (
                    <div
                      key={l.name}
                      className="flex items-center gap-3 px-3 py-1.5 rounded hover:bg-surface-2 transition-colors"
                      data-testid={`limit-${l.name}`}
                    >
                      <span className="text-xs font-medium text-text-primary w-48 truncate shrink-0">
                        {l.name}
                      </span>
                      <div className="flex-1">
                        <ProgressBar
                          value={l.usedPercent}
                          variant={usageVariant(l.usedPercent)}
                          size="sm"
                        />
                      </div>
                      <span className="text-xs tabular-nums text-text-secondary w-24 text-right shrink-0">
                        {formatNumber(used)} / {formatNumber(l.max)}
                      </span>
                      <span className="w-12 text-right shrink-0">
                        <Badge variant={usageBadge(l.usedPercent)}>
                          {Math.round(l.usedPercent)}%
                        </Badge>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </PanelOverlay>
    );
  },
);

MonitorLimitsSection.displayName = 'MonitorLimitsSection';
