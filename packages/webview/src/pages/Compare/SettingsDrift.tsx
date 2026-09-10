import React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { ProgressBar } from '../../components/ui/ProgressBar';

/** How one setting compared across the two orgs. */
export type SettingsDriftStatus = 'match' | 'drift' | 'missing_source' | 'missing_target';

/** One compared setting, as `CompareHandler.handleDrift` emits it. */
export interface SettingsDriftItem {
  setting: string;
  sourceValue: string;
  targetValue: string;
  status: SettingsDriftStatus;
}

/**
 * The object `CompareHandler.handleDrift` puts under `drift`.
 *
 * Settings, not metadata components: the handler reads the `Organization`
 * record on both sides and compares its fields key by key. The tab used to
 * feed this to a dashboard reading `drift.driftedComponents` and
 * `drift.driftScore` — two fields no producer in the codebase has ever
 * computed — and crashed on the first of them.
 */
export interface SettingsDriftReport {
  items: SettingsDriftItem[];
  totalChecked: number;
  driftCount: number;
  matchCount: number;
  missingCount: number;
  detectedAt: string;
}

/** Props for {@link SettingsDrift}. */
export interface SettingsDriftProps {
  drift: SettingsDriftReport;
  sourceLabel: string;
  targetLabel: string;
  className?: string;
}

/**
 * Validate a `compare:drift` payload before it reaches the view.
 *
 * An empty item list means no setting was compared, which is not "no drift":
 * rejected here so the caller shows the channel's diagnostic instead of a
 * clean-looking dashboard that would claim the two orgs agree.
 */
export function readSettingsDrift(value: unknown): SettingsDriftReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.items) || raw.items.length === 0) return undefined;
  const items = raw.items as SettingsDriftItem[];
  return {
    items,
    totalChecked: typeof raw.totalChecked === 'number' ? raw.totalChecked : items.length,
    driftCount: typeof raw.driftCount === 'number' ? raw.driftCount : 0,
    matchCount: typeof raw.matchCount === 'number' ? raw.matchCount : 0,
    missingCount: typeof raw.missingCount === 'number' ? raw.missingCount : 0,
    detectedAt: String(raw.detectedAt ?? ''),
  };
}

/** Score band → bar colour, the thresholds the drift dashboard has always used. */
function scoreVariant(score: number): 'error' | 'warning' | 'success' {
  if (score >= 70) return 'error';
  if (score >= 40) return 'warning';
  return 'success';
}

/**
 * Configuration drift between two orgs, at the granularity the handler reports.
 *
 * Statuses are mapped onto the diff vocabulary the rest of the page speaks and
 * DiffEngine defines: present on one side only is added (target) or removed
 * (source), a differing value is modified, an equal value unchanged.
 */
export const SettingsDrift: React.FC<SettingsDriftProps> = ({
  drift,
  sourceLabel,
  targetLabel,
  className,
}) => {
  const { t } = useTranslation();

  const statusOf = (
    status: SettingsDriftStatus,
  ): { text: string; variant: 'warning' | 'default' | 'success' | 'error' } => {
    switch (status) {
      case 'drift':
        return { text: t('compare.modified'), variant: 'warning' };
      case 'missing_source':
        return { text: t('compare.added'), variant: 'success' };
      case 'missing_target':
        return { text: t('compare.removed'), variant: 'error' };
      default:
        return { text: t('compare.unchanged'), variant: 'default' };
    }
  };

  /* Counted off the rows on screen, so the score and the table can never tell
     two different stories about the same comparison. */
  const modified = drift.items.filter((i) => i.status === 'drift').length;
  const added = drift.items.filter((i) => i.status === 'missing_source').length;
  const removed = drift.items.filter((i) => i.status === 'missing_target').length;
  const unchanged = drift.items.filter((i) => i.status === 'match').length;
  const score = Math.round(((modified + added + removed) / drift.items.length) * 100);

  return (
    <Card className={className}>
      <CardHeader title={t('compare.drift')} />
      <CardBody className="max-h-80 overflow-y-auto">
        <div className="flex flex-col gap-3" data-testid="settings-drift">
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--sf-text-primary)]">{t('compare.driftScore')}</span>
            <div className="flex-1">
              <ProgressBar value={score} variant={scoreVariant(score)} showPercent />
            </div>
          </div>

          {/* Same shape as the comparison summary bar above: every compared
              setting lands in exactly one of these four counts, so the
              denominator behind the score is on screen. */}
          <div className="flex gap-[var(--sf-space-4)] text-xs" data-testid="drift-summary">
            <span className="text-[var(--sf-success)]" data-testid="drift-added">
              +{added} {t('compare.added')}
            </span>
            <span className="text-[var(--sf-error)]" data-testid="drift-removed">
              -{removed} {t('compare.removed')}
            </span>
            <span className="text-[var(--sf-warning)]" data-testid="drift-modified">
              ~{modified} {t('compare.modified')}
            </span>
            <span className="text-[var(--sf-text-secondary)]" data-testid="drift-unchanged">
              ={unchanged} {t('compare.unchanged')}
            </span>
          </div>

          <table className="w-full text-[10px]" data-testid="drift-settings-table">
            <thead>
              <tr className="border-b border-[var(--sf-border)] text-[var(--sf-text-secondary)]">
                <th className="pb-1 pr-3 text-left font-medium" />
                <th className="pb-1 pr-3 text-left font-medium" data-testid="drift-header-source">
                  {sourceLabel}
                </th>
                <th className="pb-1 pr-3 text-left font-medium" data-testid="drift-header-target">
                  {targetLabel}
                </th>
                <th className="pb-1 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {drift.items.map((item) => {
                const status = statusOf(item.status);
                return (
                  <tr
                    key={item.setting}
                    className={cn(
                      'border-b border-[var(--sf-border)] last:border-0',
                      item.status !== 'match' && 'bg-[rgba(245,158,11,0.05)]',
                    )}
                    data-testid={`drift-setting-${item.setting}`}
                  >
                    <td className="max-w-[160px] truncate py-1 pr-3 font-mono text-[var(--sf-text-primary)]">
                      {item.setting}
                    </td>
                    <td
                      className="max-w-[120px] truncate py-1 pr-3 text-[var(--sf-text-primary)]"
                      data-testid={`drift-source-${item.setting}`}
                    >
                      {item.sourceValue || t('compare.empty')}
                    </td>
                    <td
                      className="max-w-[120px] truncate py-1 pr-3 text-[var(--sf-text-primary)]"
                      data-testid={`drift-target-${item.setting}`}
                    >
                      {item.targetValue || t('compare.empty')}
                    </td>
                    <td className="py-1 text-right">
                      <span data-testid={`drift-status-${item.setting}`}>
                        <Badge variant={status.variant}>{status.text}</Badge>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {drift.detectedAt && (
            <span
              className="font-mono text-[10px] text-[var(--sf-text-secondary)]"
              data-testid="drift-detected-at"
            >
              {drift.detectedAt}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
};
