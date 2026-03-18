import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Badge } from '../../components/ui/Badge';
import { formatNumber } from '../../utils/formatters';
import type { ApiUsageCategory } from '@sandforge/shared';

/** Response shape from monitor:api-usage. */
interface ApiUsageData {
  success: boolean;
  categories: ApiUsageCategory[];
  error?: string;
}

/** Returns progress bar variant based on usage percentage. */
function usageVariant(pct: number): 'default' | 'warning' | 'error' {
  if (pct > 80) return 'error';
  if (pct >= 60) return 'warning';
  return 'default';
}

/** Formats an API limit category name into a human-readable label. */
function formatCategoryName(name: string): string {
  return name
    .replace(/^(Daily|Hourly)/, '')
    .replace(/([A-Z])/g, ' $1')
    .trim();
}

/**
 * Panel displaying per-category API usage breakdown with ProgressBar visualization.
 *
 * Fetches data via useBridgeQuery('monitor:api-usage') and renders
 * a sorted table showing each API category's usage percentage.
 */
export const ApiUsagePanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<ApiUsageData>(
    'monitor:api-usage',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:api-usage:response', skip: !selectedOrgId },
  );

  const categories = useMemo(() => data?.categories ?? [], [data?.categories]);

  if (loading) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="api-usage-panel-loading">
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="api-usage-panel-empty">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">{t('monitor.apiUsage.title', 'API Usage Breakdown')}</h3>
        </div>
        <p className="text-xs text-text-muted text-center py-6">
          {t('monitor.apiUsage.empty', 'No API usage data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="api-usage-panel">
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('monitor.apiUsage.title', 'API Usage Breakdown')}</h3>
      </div>

      {/* Table header */}
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-text-muted font-medium uppercase tracking-wider border-b border-subtle mb-1">
        <span className="flex-1">{t('monitor.apiUsage.category', 'Category')}</span>
        <span className="w-28">{t('monitor.apiUsage.usage', 'Usage')}</span>
        <span className="w-24 text-right">{t('monitor.apiUsage.used', 'Used')} / {t('monitor.apiUsage.max', 'Max')}</span>
        <span className="w-14 text-right">%</span>
      </div>

      {/* Table rows */}
      <div className="flex flex-col gap-1" data-testid="api-usage-table">
        {categories.map((cat) => (
          <div
            key={cat.category}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-2 transition-colors"
            data-testid={`api-usage-row-${cat.category}`}
          >
            <span className="text-xs text-text-primary flex-1 truncate font-medium">
              {formatCategoryName(cat.category)}
            </span>
            <div className="w-28">
              <ProgressBar value={cat.usedPercent} variant={usageVariant(cat.usedPercent)} size="sm" />
            </div>
            <span className="text-xs tabular-nums text-text-secondary w-24 text-right">
              {formatNumber(cat.used)} / {formatNumber(cat.max)}
            </span>
            <span className="w-14 text-right">
              {cat.usedPercent >= 95 ? (
                <Badge variant="error" data-testid={`api-usage-badge-critical-${cat.category}`}>
                  {cat.usedPercent}%
                </Badge>
              ) : cat.usedPercent >= 80 ? (
                <Badge variant="warning" data-testid={`api-usage-badge-warning-${cat.category}`}>
                  {cat.usedPercent}%
                </Badge>
              ) : (
                <span className="text-xs tabular-nums text-text-muted">{cat.usedPercent}%</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
