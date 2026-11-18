import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../../components/ui/Icon';
import { cn } from '../../theme';
import type { OrgHealthSummary } from './useOrgHealthSummary';

/** Placeholder shown wherever a measurement is not available. */
const NO_VALUE = '—';

/** Props for {@link OrgHealthCard}. */
export interface OrgHealthCardProps {
  /** The selected org's figures, read from the Monitor's own answer. */
  health: OrgHealthSummary;
}

/**
 * The selected org's health in one card, which opens the Monitor: the score,
 * the limits past their warning threshold and the share of the daily API
 * requests used.
 *
 * The limit warnings sat in the KPI row and the score and the API usage in a
 * row of their own at the foot of Home, under a "Health summary" that said
 * nothing; none of them led to the Monitor, where each is explained. Every
 * figure that cannot be measured reads as a dash, never as a reassuring zero.
 */
export const OrgHealthCard: React.FC<OrgHealthCardProps> = ({ health }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);

  const figures = [
    {
      testId: 'home-health-score',
      label: t('home.healthScore'),
      value: health.healthScore !== null ? `${health.healthScore}%` : NO_VALUE,
    },
    {
      testId: 'home-limit-warnings',
      label: t('home.limitWarnings'),
      value: health.limitWarnings !== null ? String(health.limitWarnings) : NO_VALUE,
    },
    {
      testId: 'home-api-usage',
      label: t('status.apiUsage'),
      value: health.apiUsedPercent !== null ? `${health.apiUsedPercent}%` : NO_VALUE,
    },
  ];

  return (
    <button
      type="button"
      className={cn(
        'group w-full h-full rounded-xl border border-subtle bg-surface-1 p-4 text-left',
        'hover:border-active transition-colors',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
      )}
      onClick={() => navigate('monitor')}
      title={t('home.openOpModule', { module: t('nav.monitor') })}
      data-testid="home-org-health"
    >
      <span className="mb-3 flex items-center gap-2">
        {/* The Monitor's colour, the module the card opens. */}
        <span className="text-hue-blue">
          <Icon name="pulse" />
        </span>
        <span className="text-sm font-medium text-text-secondary">{t('home.orgHealth')}</span>
        <ArrowRight
          className="ml-auto h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
      <span className="grid grid-cols-3 gap-3">
        {figures.map((figure) => (
          <span key={figure.testId} className="flex min-w-0 flex-col" data-testid={figure.testId}>
            <span className="text-xs text-text-secondary break-words">{figure.label}</span>
            {health.loading ? (
              <span
                className="sf-skeleton mt-1 inline-block h-7 w-12 rounded-(--sf-radius-md)"
                aria-hidden="true"
                data-testid="skeleton"
              />
            ) : (
              <span className="text-2xl font-bold text-text-primary" data-testid="kpi-value">
                {figure.value}
              </span>
            )}
          </span>
        ))}
      </span>
    </button>
  );
};
