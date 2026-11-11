import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ForgeLeftOutObject } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { formatEstimateSec, uiLocale } from '../../utils/formatters';
import { leftOutByReason, leftOutDetail, leftOutReasonLabel } from './forgeLeftOut';

/**
 * Reasons an object is left out for whose detail is the org's own words — a
 * sentence each — listed one object a line; the others, their objects named
 * in a run of text, the word `detail` translates in brackets.
 */
const SAID_BY_THE_ORG = new Set(['unreadable', 'notDescribed']);

/**
 * The objects of the source org a clone of the whole org leaves out, grouped
 * by why, folded until opened: up to thousands of names, which neither the
 * plan's waves nor the run take, said here rather than left unsaid. Nothing
 * is shown of a graph walked from a root, which names none. The names are
 * put in the page only once the section is opened.
 */
const ReviewLeftOutObjects: React.FC<{ leftOut: readonly ForgeLeftOutObject[] | undefined }> = ({
  leftOut,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const groups = useMemo(() => leftOutByReason(leftOut), [leftOut]);
  if (groups.length === 0) return null;
  const count = leftOut?.length ?? 0;
  return (
    <section data-testid="review-left-out" className="rounded-lg border border-subtle p-3">
      <button
        type="button"
        data-testid="review-left-out-toggle"
        aria-expanded={open}
        // Named once the list is in the page: folded, it is not there.
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-text-primary"
      >
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
        {t('forgeRun.review.leftOutTitle', {
          count,
          formatted: count.toLocaleString(uiLocale()),
        })}
      </button>
      {open && (
        <div id={listId} className="mt-2 flex flex-col gap-2">
          <p className="text-[10px] text-text-secondary">{t('forgeRun.review.leftOutHint')}</p>
          {groups.map((group) => (
            <div key={group.reason} data-testid={`review-left-out-${group.reason}`}>
              <h4 className="text-[11px] font-semibold text-text-primary">
                {leftOutReasonLabel(t, group.reason)}{' '}
                <span className="font-normal tabular-nums text-text-secondary">
                  ({group.objects.length.toLocaleString(uiLocale())})
                </span>
              </h4>
              {SAID_BY_THE_ORG.has(group.reason) ? (
                <ul className="text-[10px] text-text-secondary">
                  {group.objects.map((object) => {
                    const detail = leftOutDetail(t, object);
                    return (
                      <li key={object.objectApiName}>
                        <span className="text-text-primary">{object.objectApiName}</span>
                        {detail ? `: ${detail}` : ''}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[10px] text-text-secondary">
                  {group.objects
                    .map((object) => {
                      const detail = leftOutDetail(t, object);
                      return detail ? `${object.objectApiName} (${detail})` : object.objectApiName;
                    })
                    .join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

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

  // What a clone of the whole org leaves out is the graph's, not the plan's:
  // said whether the plan came, is coming, or could not be made.
  const leftOutSection = <ReviewLeftOutObjects leftOut={graph?.leftOut} />;

  // A failed plan request used to be indistinguishable from a slow one: both
  // showed the loading text forever.
  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <div data-testid="plan-error" className="py-8 text-center text-sm text-status-error">
          {error}
        </div>
        {leftOutSection}
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="flex flex-col gap-3">
        <div
          data-testid="plan-loading"
          className="flex items-center justify-center py-8 text-text-secondary text-sm"
        >
          {t('forgeRun.review.planLoading', 'Generating execution plan...')}
        </div>
        {leftOutSection}
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
            {/* "~7200s" said nothing at a glance of a run of two hours. */}
            <span data-testid="review-plan-duration">
              ~{formatEstimateSec(plan.estimatedDurationSeconds)}
            </span>
          </>
        ) : (
          <span>{t('forgeRun.preview.recordsNotCounted')}</span>
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
              {t('forgeRun.review.wave', 'Wave')} {wave.order + 1}
            </span>
            {counted(wave.objectApiNames) && (
              <span className="text-[10px] text-text-secondary">
                {t('common.estimatedApiCallCount', { count: wave.estimatedApiCalls })} · ~
                {formatEstimateSec(wave.estimatedDurationSeconds)}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {wave.objectApiNames.map((obj) => (
              <span
                key={obj}
                className="text-[10px] bg-surface-3 text-text-primary px-2 py-0.5 rounded-sm"
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
            {t('forgeRun.review.cycles', 'Cycle Resolutions')}
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

      {leftOutSection}
    </div>
  );
};
