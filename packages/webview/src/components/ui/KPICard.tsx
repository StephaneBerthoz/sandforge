import React from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '../../theme';
import { slideUp } from '../../motion/presets';
import { Icon } from './Icon';
import { ProgressBar } from './ProgressBar';
import { Sparkline } from './Sparkline';

/** Visual variant for KPI accent color. */
export type KPICardVariant = 'default' | 'success' | 'warning' | 'error';

/** Props for the KPICard component. */
export interface KPICardProps {
  /** Codicon name for the card icon. */
  icon: string;
  /** Text label describing the KPI. */
  label: string;
  /** Main displayed value. */
  value: string | number;
  /** Secondary text shown below the value (e.g. "/15,000" or "83%"). */
  subtitle?: string;
  /** Progress percentage (0-100). Renders a ProgressBar when provided. */
  progress?: number;
  /** Accent color variant applied to icon and progress bar. */
  variant?: KPICardVariant;
  /** Additional CSS classes for the root element. */
  className?: string;
  /** Sparkline data points (usedPercent values over time). */
  sparklineData?: number[];
  /** Trend direction for indicator arrow. */
  trendDirection?: 'up' | 'down' | 'stable';
  /** Warning text shown below progress bar (e.g. "Limit reached in ~2h"). */
  trendWarning?: string;
  /**
   * Optional override for the icon's colour, as a text colour class sized for
   * contrast (e.g. `text-hue-forge`). A raw hex could not follow the theme: the
   * Forge orange read 2.6:1 on Light Modern.
   */
  accentClassName?: string;
}

/** Maps variant to the text colour class of its icon. */
const variantColorMap: Record<KPICardVariant, string> = {
  default: 'text-[var(--sf-accent)]',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
};

/**
 * KPI card displaying a metric with icon, value, optional subtitle and progress bar.
 * Uses design system tokens for all colors and spacing.
 */
/** Map trend direction to its Lucide icon component and color. */
const trendIndicatorMap: Record<
  string,
  { icon: React.FC<React.SVGProps<SVGSVGElement>>; className: string }
> = {
  up: { icon: TrendingUp, className: 'text-status-error' },
  down: { icon: TrendingDown, className: 'text-status-success' },
  stable: { icon: Minus, className: 'text-text-secondary' },
};

/** What the trend arrow says to a screen reader, per direction. */
const trendLabelKey: Record<NonNullable<KPICardProps['trendDirection']>, string> = {
  up: 'a11y.trendUp',
  down: 'a11y.trendDown',
  stable: 'a11y.trendStable',
};

export const KPICard: React.FC<KPICardProps> = ({
  icon,
  label,
  value,
  subtitle,
  progress,
  variant = 'default',
  className,
  sparklineData,
  trendDirection,
  trendWarning,
  accentClassName,
}) => {
  const { t } = useTranslation();
  const accentClass = accentClassName ?? variantColorMap[variant];
  const trendIndicator = trendDirection ? trendIndicatorMap[trendDirection] : undefined;

  return (
    <m.div
      data-testid="kpi-card"
      variants={slideUp}
      initial="hidden"
      animate="visible"
      className={cn('rounded-xl border border-subtle bg-surface-1 p-4', className)}
    >
      {/* Header row: icon + label + trend arrow */}
      <div className="mb-3 flex items-center gap-2">
        <span className={accentClass}>
          <Icon name={icon} label={label} />
        </span>
        <span className="text-sm font-medium text-text-secondary">{label}</span>
        {trendIndicator && (
          <span
            data-testid="trend-arrow"
            className={cn('ml-auto flex items-center', trendIndicator.className)}
            aria-label={trendDirection ? t(trendLabelKey[trendDirection]) : undefined}
          >
            <trendIndicator.icon width={14} height={14} />
          </span>
        )}
      </div>

      {/* Value */}
      <div
        className="text-2xl font-bold text-text-primary tabular-nums"
        data-testid="kpi-value"
        style={{ lineHeight: 1.2 }}
      >
        {value}
      </div>

      {/* Subtitle */}
      {subtitle && (
        <div data-testid="kpi-subtitle" className="mt-1 text-sm text-text-secondary">
          {subtitle}
        </div>
      )}

      {/* Progress bar */}
      {progress !== undefined && (
        <div className="mt-3">
          <ProgressBar value={progress} variant={variant} size="sm" ariaLabel={label} />
        </div>
      )}

      {/* Trend warning */}
      {trendWarning && (
        <div data-testid="trend-warning" className="mt-1 text-xs text-hue-yellow">
          {trendWarning}
        </div>
      )}

      {/* Sparkline */}
      {sparklineData && sparklineData.length >= 2 && (
        <div className={cn('mt-2', accentClass)} data-testid="kpi-sparkline">
          <Sparkline
            data={sparklineData}
            width={200}
            height={24}
            color="currentColor"
            strokeWidth={1}
          />
        </div>
      )}
    </m.div>
  );
};
