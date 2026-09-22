import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** Single limit prediction entry. */
export interface LimitPrediction {
  /** Name of the governor limit. */
  limitName: string;
  /** Current usage percentage (0-100). */
  currentUsage: number;
  /** Estimated hours until the limit is exhausted. */
  estimatedHoursToLimit: number;
}

/** Props for the PredictionsTile component. */
export interface PredictionsTileProps {
  /** List of limit predictions. */
  predictions: LimitPrediction[];
  /** Additional CSS classes. */
  className?: string;
}

/** Returns the urgency dot's colour: the theme's raw severity, drawn, not read. */
function urgencyColor(hours: number): string {
  if (hours < 2) return 'var(--sf-error, #EF4444)';
  if (hours < 12) return 'var(--sf-warning, #F59E0B)';
  return 'var(--sf-success, #10B981)';
}

/**
 * Returns the class the time estimate is written in: the severity sized for
 * text, since the raw ones read 1.88:1 to 3.15:1 on Light Modern.
 */
function urgencyTextClass(hours: number): string {
  if (hours < 2) return 'text-status-error';
  if (hours < 12) return 'text-status-warning';
  return 'text-status-success';
}

/** Returns the catalogue key of the urgency label for the estimated hours. */
function urgencyLabelKey(hours: number): string {
  if (hours < 2) return 'a11y.urgencyCritical';
  if (hours < 12) return 'a11y.urgencyWarning';
  return 'a11y.urgencySafe';
}

/** Formats hours into a human-readable string. */
function formatHours(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${Math.round(hours % 24)}h`;
  }
  return `${Math.round(hours)}h`;
}

/**
 * Tile displaying time-to-limit predictions for governor limits.
 * Color-coded by urgency: red (<2h), amber (<12h), green (>12h).
 */
export const PredictionsTile: React.FC<PredictionsTileProps> = ({ predictions, className }) => {
  const { t } = useTranslation();

  /** Sort predictions by urgency (most urgent first). */
  const sorted = [...predictions].sort((a, b) => a.estimatedHoursToLimit - b.estimatedHoursToLimit);

  return (
    <div className={cn('flex flex-col', className)} data-testid="predictions-tile">
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        {t('monitor.predictions', 'Time-to-Limit Predictions')}
      </h3>

      {sorted.length === 0 ? (
        <p className="text-xs text-text-secondary text-center py-4">
          {t('monitor.noPredictions', 'No predictions available')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((prediction) => {
            const color = urgencyColor(prediction.estimatedHoursToLimit);
            const label = t(urgencyLabelKey(prediction.estimatedHoursToLimit));
            return (
              <div
                key={prediction.limitName}
                className="flex items-center gap-3 rounded-lg border border-subtle bg-surface-2 px-3 py-2"
                data-testid={`prediction-${prediction.limitName}`}
              >
                {/* Urgency indicator dot: an image, since a bare span cannot carry a label */}
                <span
                  role="img"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                  data-testid={`prediction-dot-${prediction.limitName}`}
                  aria-label={label}
                />

                {/* Limit name */}
                <span className="flex-1 truncate text-xs font-medium text-text-primary">
                  {prediction.limitName}
                </span>

                {/* Current usage */}
                <span className="text-xs tabular-nums text-text-secondary">
                  {Math.round(prediction.currentUsage)}%
                </span>

                {/* Time estimate */}
                <span
                  className={cn(
                    'text-xs font-semibold tabular-nums',
                    urgencyTextClass(prediction.estimatedHoursToLimit),
                  )}
                  data-testid={`prediction-time-${prediction.limitName}`}
                >
                  {formatHours(prediction.estimatedHoursToLimit)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
