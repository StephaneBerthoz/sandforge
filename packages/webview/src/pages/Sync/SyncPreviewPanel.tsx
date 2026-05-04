import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { cn } from '../../theme';
import { formatDurationSec } from '../../utils/formatters';

/** Object impact summary for display. */
export interface ObjectImpactUI {
  objectApiName: string;
  operation: string;
  newRecords: number;
  modifiedRecords: number;
  deletedRecords: number;
  conflictCount: number;
  estimatedApiCalls: number;
  riskLevel: 'low' | 'medium' | 'high';
  riskReasons: string[];
}

/** Full sync preview data. */
export interface SyncPreviewData {
  objects: ObjectImpactUI[];
  totalNewRecords: number;
  totalModifiedRecords: number;
  totalDeletedRecords: number;
  totalConflicts: number;
  estimatedDuration: number;
  estimatedApiCalls: number;
  overallRisk: 'low' | 'medium' | 'high';
  warnings: string[];
}

/** SyncPreviewPanel props. */
export interface SyncPreviewPanelProps {
  preview?: SyncPreviewData;
  isLoading?: boolean;
  className?: string;
}

/** Badge variant for risk level. */
function riskBadge(risk: 'low' | 'medium' | 'high'): BadgeVariant {
  switch (risk) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    default:
      return 'success';
  }
}

/**
 * Sync preview panel showing impact analysis, conflict summary,
 * and risk assessment before sync execution.
 */
export const SyncPreviewPanel: React.FC<SyncPreviewPanelProps> = ({
  preview,
  isLoading = false,
  className,
}) => {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div
        data-testid="sync-preview-loading"
        className={cn('text-xs text-center py-6', className)}
        style={{ color: 'var(--sf-text-muted)' }}
      >
        {t('common.loading')}
      </div>
    );
  }

  if (!preview) {
    return null;
  }

  const stats = [
    { label: t('sync.previewNew', 'New'), value: preview.totalNewRecords, testId: 'preview-new' },
    {
      label: t('sync.previewModified', 'Modified'),
      value: preview.totalModifiedRecords,
      testId: 'preview-modified',
    },
    {
      label: t('sync.previewDeleted', 'Deleted'),
      value: preview.totalDeletedRecords,
      testId: 'preview-deleted',
    },
    {
      label: t('sync.previewConflicts', 'Conflicts'),
      value: preview.totalConflicts,
      testId: 'preview-conflicts',
    },
  ];

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="sync-preview-panel">
      {/* Header with overall risk */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
          {t('sync.impactAnalysis', 'Impact Analysis')}
        </span>
        <span data-testid="preview-overall-risk">
          <Badge variant={riskBadge(preview.overallRisk)}>
            {preview.overallRisk.toUpperCase()}
          </Badge>
        </span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="preview-stats">
        {stats.map((stat) => (
          <div
            key={stat.testId}
            data-testid={stat.testId}
            className={cn(
              'flex flex-col items-center p-2 rounded text-center',
              'border border-[var(--sf-border,#3c3c3c)]',
              'bg-[var(--sf-bg-card,#252526)]',
            )}
          >
            <span
              className="text-sm font-bold"
              style={{
                color:
                  stat.value > 0 && stat.label === t('sync.previewDeleted', 'Deleted')
                    ? 'var(--sf-error, #EF4444)'
                    : stat.value > 0 && stat.label === t('sync.previewConflicts', 'Conflicts')
                      ? 'var(--sf-warning, #F59E0B)'
                      : 'var(--sf-text-primary, #d4d4d4)',
              }}
            >
              {stat.value.toLocaleString()}
            </span>
            <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Estimates */}
      <div
        className="flex gap-4 text-[10px] text-[var(--sf-text-muted,#868686)]"
        data-testid="preview-estimates"
      >
        <span>
          {t('sync.previewApiCalls', 'API Calls')}: {preview.estimatedApiCalls.toLocaleString()}
        </span>
        <span>
          {t('sync.previewDuration', 'Est. Duration')}:{' '}
          {formatDurationSec(preview.estimatedDuration)}
        </span>
      </div>

      {/* Warnings */}
      {preview.warnings.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="preview-warnings">
          {preview.warnings.map((w, i) => (
            <ErrorBanner key={i} message={w} data-testid={`preview-warning-${i}`} />
          ))}
        </div>
      )}

      {/* Per-object breakdown */}
      <div className="flex flex-col gap-1" data-testid="preview-objects">
        {preview.objects.map((obj) => (
          <div
            key={obj.objectApiName}
            className={cn(
              'flex items-center justify-between px-2 py-1.5 rounded text-xs',
              'border border-[var(--sf-border,#3c3c3c)]',
            )}
            data-testid={`preview-obj-${obj.objectApiName}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[var(--sf-text-primary,#d4d4d4)] font-medium">
                {obj.objectApiName}
              </span>
              <Badge variant="default">{obj.operation}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {obj.conflictCount > 0 && (
                <Badge variant="warning">
                  {obj.conflictCount} {t('sync.previewConflicts', 'Conflicts').toLowerCase()}
                </Badge>
              )}
              <Badge variant={riskBadge(obj.riskLevel)}>{obj.riskLevel}</Badge>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
