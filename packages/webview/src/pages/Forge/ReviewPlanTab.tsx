import React from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';

/**
 * Plan tab within the Forge Review phase.
 *
 * Displays execution waves as cards, each showing the wave number,
 * participating objects, estimated duration, and API calls.
 * Also renders cycle resolutions when detected.
 */
/** Props for {@link ReviewPlanTab}. */
export interface ReviewPlanTabProps {
  /** Message from forge:plan:error, when the extension could not build a plan. */
  error?: string | null;
}

export const ReviewPlanTab: React.FC<ReviewPlanTabProps> = ({ error = null }) => {
  const { t } = useTranslation();
  const plan = useForgeStore((s) => s.plan);

  // A failed plan request used to be indistinguishable from a slow one: both
  // showed the loading text forever.
  if (error) {
    return (
      <div data-testid="plan-error" className="py-8 text-center text-sm text-status-error">
        {error}
      </div>
    );
  }

  if (!plan) {
    return (
      <div
        data-testid="plan-loading"
        className="flex items-center justify-center py-8 text-text-muted text-sm"
      >
        {t('forge.review.planLoading', 'Generating execution plan...')}
      </div>
    );
  }

  return (
    <div data-testid="review-plan-tab" className="flex flex-col gap-3">
      {/* Summary */}
      <div className="flex gap-4 text-xs text-text-muted">
        <span>
          {plan.totalRecords.toLocaleString()} {t('forge.records', 'records')}
        </span>
        <span>{plan.totalApiCalls} API calls</span>
        <span>~{plan.estimatedDurationSeconds.toFixed(0)}s</span>
      </div>

      {/* Waves */}
      {plan.waves.map((wave) => (
        <div
          key={wave.order}
          data-testid={`wave-${wave.order}`}
          className="rounded-lg border border-subtle p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text-primary">
              {t('forge.review.wave', 'Wave')} {wave.order + 1}
            </span>
            <span className="text-[10px] text-text-muted">
              {wave.estimatedApiCalls} calls · ~{wave.estimatedDurationSeconds.toFixed(1)}s
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {wave.objectApiNames.map((obj) => (
              <span
                key={obj}
                className="text-[10px] bg-surface-3 text-text-primary px-2 py-0.5 rounded"
              >
                {obj}
              </span>
            ))}
          </div>
        </div>
      ))}

      {/* Cycle resolutions */}
      {plan.cycleResolutions.length > 0 && (
        <div data-testid="cycle-resolutions" className="mt-2">
          <h4 className="text-xs font-semibold text-orange-400 mb-1">
            {t('forge.review.cycles', 'Cycle Resolutions')}
          </h4>
          {plan.cycleResolutions.map((cycle, idx) => (
            <div key={`cycle-${idx}`} className="text-[10px] text-text-muted mb-1">
              <span className="text-orange-400">{cycle.objects.join(' \u2192 ')}</span>
              {' \u2014 '}
              {cycle.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
