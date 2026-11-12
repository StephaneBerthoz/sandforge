import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { ForgeGraph, ForgePlan } from '@sandforge/shared';
import { formatEstimateSec, uiLocale } from '../../utils/formatters';
import { forgeRunBuckets } from './reviewSummaries';

/** The objects named on the line, the rest being counted: all of them are in its title. */
const OBJECTS_NAMED = 4;

/** One thing the run does with its objects: its words, its count, and the first of them. */
const LinePart: React.FC<{
  label: string;
  value: string | number;
  objects: string[];
  testId: string;
}> = ({ label, value, objects, testId }) => (
  <span data-testid={testId} title={objects.join(', ')}>
    <span className="text-text-secondary">{label}</span>{' '}
    <span className="font-medium tabular-nums">{value}</span>
    {objects.length > 0 && (
      <span className="text-text-secondary">
        {' '}
        {objects.slice(0, OBJECTS_NAMED).join(', ')}
        {objects.length > OBJECTS_NAMED ? ` +${objects.length - OBJECTS_NAMED}` : ''}
      </span>
    )}
  </span>
);

/** Props of {@link ReviewPlanLine}. */
export interface ReviewPlanLineProps {
  graph: ForgeGraph;
  plan: ForgePlan | null;
  cycleCount: number;
  truncated: boolean;
  /**
   * The run clones one record's graph (`clonesOneRecord`): the counts are
   * the source tables', and the calls and the duration reckoned from them are
   * left out.
   */
  oneRecord?: boolean;
}

/**
 * What the Plan row says of the run: every object of the graph in one of four
 * buckets (clone, map, skip excluded, skip empty), the totals, and what to
 * know before Execute. Text only, as it sits inside the row's button.
 */
export const ReviewPlanLine: React.FC<ReviewPlanLineProps> = ({
  graph,
  plan,
  cycleCount,
  truncated,
  oneRecord = false,
}) => {
  const { t } = useTranslation();
  const buckets = useMemo(() => forgeRunBuckets(graph), [graph]);
  /**
   * Discovery counts each object's whole table: a clone of one case's graph
   * was told "Will clone 9 objects · 1.2 M records, ~40 min", and read a few
   * hundred.
   */
  const recordsValue = buckets.cloneRecordsUnknown
    ? t('forgeRun.preview.recordsNotCounted')
    : t(oneRecord ? 'forgeRun.preview.recordsInSourceTables' : 'common.recordCountFormatted', {
        count: buckets.cloneRecords,
        formatted: buckets.cloneRecords.toLocaleString(uiLocale()),
      });
  // The plan reckons its calls and its duration from the counts: from counts
  // nobody took, it said "0 API calls · ~0s" of a run that reads every object
  // of the template. From counts taken, its calls are a guess all the same,
  // and are said to be one; of whole tables a clone of one record does not
  // read, they say nothing.
  const reckoned = plan !== null && !buckets.cloneRecordsUnknown && !oneRecord;

  return (
    <span data-testid="forge-preview-card" className="flex flex-col gap-1">
      <span className="flex flex-wrap gap-x-3 gap-y-0.5">
        <LinePart
          label={t('forgeRun.preview.willClone')}
          value={`${t('common.objectCount', { count: buckets.cloneObjects.length })} · ${recordsValue}`}
          objects={buckets.cloneObjects}
          testId="forge-preview-clone"
        />
        {buckets.mappedObjects.length > 0 && (
          <LinePart
            label={t('forgeRun.preview.willMap')}
            value={buckets.mappedObjects.length}
            objects={buckets.mappedObjects}
            testId="forge-preview-map"
          />
        )}
        {buckets.skippedExcluded.length > 0 && (
          <LinePart
            label={t('forgeRun.preview.skippedExcluded')}
            value={buckets.skippedExcluded.length}
            objects={buckets.skippedExcluded}
            testId="forge-preview-skipped-excluded"
          />
        )}
        {buckets.skippedOutOfScope.length > 0 && (
          <LinePart
            label={t('forgeRun.preview.skippedEmpty')}
            value={buckets.skippedOutOfScope.length}
            objects={buckets.skippedOutOfScope}
            testId="forge-preview-skipped-empty"
          />
        )}
        {reckoned && (
          <span data-testid="forge-preview-reckoned" className="text-text-secondary">
            {t('common.estimatedApiCallCount', { count: plan.totalApiCalls })} · ~
            {formatEstimateSec(plan.estimatedDurationSeconds)}
          </span>
        )}
      </span>
      {cycleCount > 0 && (
        <span
          data-testid="forge-preview-cycles"
          className="flex items-center gap-1.5 text-xs text-status-warning"
        >
          <AlertTriangle size={11} aria-hidden="true" className="shrink-0" />
          {t('forgeRun.preview.cycleCount', { count: cycleCount })}
        </span>
      )}
      {truncated && (
        <span
          data-testid="forge-preview-truncated"
          className="flex items-center gap-1.5 text-xs text-status-warning"
        >
          <AlertTriangle size={11} aria-hidden="true" className="shrink-0" />
          {t('forgeRun.preview.truncatedAction')}
        </span>
      )}
      {buckets.cloneRecordsUnknown && (
        <span data-testid="forge-preview-not-counted" className="text-xs text-text-secondary">
          {t('forgeRun.preview.countsComeWithDiscovery')}
        </span>
      )}
      {oneRecord && !buckets.cloneRecordsUnknown && (
        <span data-testid="forge-preview-source-tables" className="text-xs text-text-secondary">
          {t('forgeRun.preview.readsWhatTheRecordReaches')}
        </span>
      )}
    </span>
  );
};
