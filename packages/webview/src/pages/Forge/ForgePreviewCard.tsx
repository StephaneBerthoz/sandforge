import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Link2, EyeOff, AlertTriangle, Clock, Zap } from 'lucide-react';
import type { ForgeGraph, ForgePlan } from '@sandforge/shared';
import { cn } from '../../theme';
import { uiLocale } from '../../utils/formatters';

/** Default reference-data objects — must mirror ForgeExecutor's default. */
const REFERENCE_DATA_DEFAULTS = new Set(['BusinessHours', 'OperatingHours']);

interface Bucket {
  cloneObjects: string[];
  cloneRecords: number;
  mappedObjects: string[];
  skippedExcluded: string[];
  skippedOutOfScope: string[];
}

function categorize(graph: ForgeGraph): Bucket {
  const cloneObjects: string[] = [];
  const mappedObjects: string[] = [];
  const skippedExcluded: string[] = [];
  const skippedOutOfScope: string[] = [];
  let cloneRecords = 0;

  for (const node of graph.nodes) {
    if (REFERENCE_DATA_DEFAULTS.has(node.objectApiName)) {
      mappedObjects.push(node.objectApiName);
      continue;
    }
    if (!node.included) {
      skippedExcluded.push(node.objectApiName);
      continue;
    }
    if (node.recordCount === 0) {
      skippedOutOfScope.push(node.objectApiName);
      continue;
    }
    cloneObjects.push(node.objectApiName);
    cloneRecords += node.recordCount;
  }
  return { cloneObjects, cloneRecords, mappedObjects, skippedExcluded, skippedOutOfScope };
}

interface ForgePreviewCardProps {
  graph: ForgeGraph;
  plan: ForgePlan | null;
  cycleCount: number;
  truncated: boolean;
}

/**
 * Summary card shown at the top of the Review phase. Categorises every
 * graph node into one of four buckets (clone / map / skip-excluded /
 * skip-out-of-scope) and surfaces the totals + warnings before the user
 * commits to the Execute step.
 */
export const ForgePreviewCard: React.FC<ForgePreviewCardProps> = ({
  graph,
  plan,
  cycleCount,
  truncated,
}) => {
  const { t } = useTranslation();
  const buckets = useMemo(() => categorize(graph), [graph]);

  const tile = (
    icon: React.ReactNode,
    label: string,
    value: number | string,
    objects: string[],
    klass: string,
    testId: string,
  ): React.ReactNode => (
    <div
      data-testid={testId}
      className={cn('rounded-lg border px-3 py-2.5 flex flex-col gap-1', klass)}
    >
      <div className="flex items-center gap-2 text-xs text-text-primary">
        {icon}
        <span className="font-medium">{label}</span>
      </div>
      <div className="text-lg font-semibold text-text-primary tabular-nums">{value}</div>
      {objects.length > 0 && (
        <div className="text-[10px] text-text-primary truncate" title={objects.join(', ')}>
          {objects.slice(0, 4).join(', ')}
          {objects.length > 4 ? ` +${objects.length - 4}` : ''}
        </div>
      )}
    </div>
  );

  return (
    <div
      data-testid="forge-preview-card"
      className="rounded-lg border border-subtle bg-surface-1 p-3 space-y-3"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <span>{t('forge.preview.title', 'What will happen on Execute')}</span>
        {truncated && (
          <span
            data-testid="forge-preview-truncated"
            className="ml-auto text-[10px] text-status-warning flex items-center gap-1"
          >
            <AlertTriangle size={11} />
            {t('forge.preview.truncatedAction')}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tile(
          <Database size={13} className="text-status-success" />,
          t('forge.preview.willClone', 'Will clone'),
          `${t('common.objectCount', { count: buckets.cloneObjects.length })} · ${t(
            'common.recordCountFormatted',
            {
              count: buckets.cloneRecords,
              formatted: buckets.cloneRecords.toLocaleString(uiLocale()),
            },
          )}`,
          buckets.cloneObjects,
          'border-status-success/30 bg-status-success/5',
          'forge-preview-clone',
        )}
        {tile(
          <Link2 size={13} className="text-status-info" />,
          t('forge.preview.willMap', 'Will map'),
          buckets.mappedObjects.length,
          buckets.mappedObjects,
          'border-status-info/30 bg-status-info/5',
          'forge-preview-map',
        )}
        {tile(
          <EyeOff size={13} className="text-text-secondary" />,
          t('forge.preview.skippedExcluded', 'Skipped (excluded)'),
          buckets.skippedExcluded.length,
          buckets.skippedExcluded,
          'border-subtle bg-surface-2',
          'forge-preview-skipped-excluded',
        )}
        {tile(
          <EyeOff size={13} className="text-status-warning" />,
          t('forge.preview.skippedEmpty', 'Skipped (empty)'),
          buckets.skippedOutOfScope.length,
          buckets.skippedOutOfScope,
          'border-status-warning/30 bg-status-warning/5',
          'forge-preview-skipped-empty',
        )}
      </div>
      {plan && (
        <div className="flex items-center gap-4 text-xs text-text-secondary">
          <span className="flex items-center gap-1.5">
            <Zap size={11} />
            {t('common.apiCallCount', { count: plan.totalApiCalls })}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock size={11} />~{plan.estimatedDurationSeconds.toFixed(0)}s
          </span>
          {cycleCount > 0 && (
            <span
              data-testid="forge-preview-cycles"
              className="flex items-center gap-1.5 text-status-warning"
            >
              <AlertTriangle size={11} />
              {t('forge.preview.cycleCount', { count: cycleCount })}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
