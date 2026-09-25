import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import { uiLocale } from '../../utils/formatters';

/**
 * Plan tab within the Forge Review phase.
 *
 * Displays execution waves as cards, each showing the wave number,
 * participating objects, estimated duration, and estimated API calls.
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
  const graph = useForgeStore((s) => s.graph);
  /*
   * The objects whose records nobody counted. The plan reckons its records,
   * its calls and its duration from the graph's counts, and a starter
   * template's graph skips discovery and holds each at a placeholder zero:
   * the tab said "0 records · 0 API calls · ~0s", and each wave "0 API
   * calls", of a run that reads every object of the template. Said as the
   * preview card says it.
   */
  const notCounted = useMemo(
    () =>
      new Set(
        (graph?.nodes ?? [])
          .filter((node) => node.recordCountUnknown === true)
          .map((node) => node.objectApiName),
      ),
    [graph],
  );
  const counted = (objects: readonly string[]): boolean =>
    !objects.some((objectApiName) => notCounted.has(objectApiName));

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
        className="flex items-center justify-center py-8 text-text-secondary text-sm"
      >
        {t('forge.review.planLoading', 'Generating execution plan...')}
      </div>
    );
  }

  return (
    <div data-testid="review-plan-tab" className="flex flex-col gap-3">
      {/* Summary. Its calls, and each wave's, are the plan's guess — a call for
          each batch of the rows discovery counted, before anything is read —
          and are said to be one, as the execution and results tiles say
          theirs: "6 API calls" read as calls counted. */}
      <div data-testid="review-plan-summary" className="flex gap-4 text-xs text-text-secondary">
        {plan.waves.every((wave) => counted(wave.objectApiNames)) ? (
          <>
            <span>
              {t('common.recordCountFormatted', {
                count: plan.totalRecords,
                formatted: plan.totalRecords.toLocaleString(uiLocale()),
              })}
            </span>
            <span>{t('common.estimatedApiCallCount', { count: plan.totalApiCalls })}</span>
            <span>~{plan.estimatedDurationSeconds.toFixed(0)}s</span>
          </>
        ) : (
          <span>{t('forge.preview.recordsNotCounted')}</span>
        )}
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
            {counted(wave.objectApiNames) && (
              <span className="text-[10px] text-text-secondary">
                {t('common.estimatedApiCallCount', { count: wave.estimatedApiCalls })} · ~
                {wave.estimatedDurationSeconds.toFixed(1)}s
              </span>
            )}
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
          <h4 className="text-xs font-semibold text-status-warning mb-1">
            {t('forge.review.cycles', 'Cycle Resolutions')}
          </h4>
          {plan.cycleResolutions.map((cycle, idx) => (
            <div key={`cycle-${idx}`} className="text-[10px] text-text-secondary mb-1">
              <span className="text-status-warning">{cycle.objects.join(' \u2192 ')}</span>
              {' \u2014 '}
              {cycle.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
