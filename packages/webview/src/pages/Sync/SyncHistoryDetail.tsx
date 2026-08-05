import React from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Icon } from '../../components/ui/Icon';

/** Map sync status to badge variant. */
const statusVariant: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/**
 * SyncHistoryDetail renders the detailed view of a single sync execution.
 * Shows per-object results, config snapshot summary, and a "Run Again" button.
 */
export const SyncHistoryDetail: React.FC = () => {
  const { t } = useTranslation();
  const { selectedEntry, clearSelection, rerun } = useSyncHistoryStore();

  if (!selectedEntry) return null;

  const { result, configSnapshot, startTime, endTime, triggeredBy } = selectedEntry;

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-3)] p-[var(--sf-space-3)] border border-[var(--sf-border)] rounded"
      data-testid="sync-history-detail"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--sf-space-2)]">
          <h4 className="text-sm font-semibold text-text-primary">
            {configSnapshot.name ?? t('sync.history.detailTitle')}
          </h4>
          <Badge variant={statusVariant[result.status] ?? 'default'}>
            {t(`sync.history.status_${result.status}`)}
          </Badge>
        </div>
        <button
          type="button"
          className="text-xs px-2 py-1 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] hover:bg-[var(--sf-button-secondary-hover)]"
          onClick={clearSelection}
          data-testid="detail-close-btn"
          aria-label={t('common.close')}
        >
          <Icon name="close" />
        </button>
      </div>

      {/* Meta info */}
      <div className="flex gap-[var(--sf-space-3)] text-xs text-text-secondary">
        <span>{format(new Date(startTime), 'yyyy-MM-dd HH:mm:ss')}</span>
        <span>
          {t('sync.history.triggeredBy')}:{' '}
          {t(`sync.history.triggered${triggeredBy.charAt(0).toUpperCase()}${triggeredBy.slice(1)}`)}
        </span>
        {endTime && (
          <span>
            {t('sync.history.endTime')}: {format(new Date(endTime), 'HH:mm:ss')}
          </span>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-[var(--sf-space-2)]">
        <Card>
          <CardBody>
            <div className="text-center">
              <div className="text-lg font-bold text-text-primary">{result.totalProcessed}</div>
              <div className="text-[10px] text-text-secondary">{t('sync.totalProcessed')}</div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-center">
              <div className="text-lg font-bold text-[var(--sf-color-success,#4ec9b0)]">
                {result.totalSuccess}
              </div>
              <div className="text-[10px] text-text-secondary">{t('sync.totalSuccess')}</div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-center">
              <div className="text-lg font-bold text-[var(--sf-error)]">{result.totalFailed}</div>
              <div className="text-[10px] text-text-secondary">{t('sync.totalFailed')}</div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-center">
              <div className="text-lg font-bold text-text-secondary">{result.totalSkipped}</div>
              <div className="text-[10px] text-text-secondary">{t('sync.totalSkipped')}</div>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Per-object results */}
      <div className="flex flex-col gap-[var(--sf-space-2)]">
        <h5 className="text-xs font-semibold text-text-primary">
          {t('sync.history.objectResults')}
        </h5>
        {result.objectResults.map((obj) => (
          <Card key={obj.objectApiName} data-testid={`object-result-${obj.objectApiName}`}>
            <CardHeader
              title={obj.objectApiName}
              subtitle={`${t(`sync.operations.${obj.operation}`)} - ${obj.success}/${obj.processed}`}
            />
            <CardBody>
              <div className="flex gap-[var(--sf-space-3)] text-[10px]">
                <span>
                  {t('sync.history.processed')}: {obj.processed}
                </span>
                <span className="text-[var(--sf-color-success,#4ec9b0)]">
                  {t('sync.history.successCount')}: {obj.success}
                </span>
                <span className="text-[var(--sf-error)]">
                  {t('sync.history.failedCount')}: {obj.failed}
                </span>
                <span>
                  {t('sync.history.skippedCount')}: {obj.skipped}
                </span>
              </div>
              {obj.errors.length > 0 && (
                <div className="mt-1">
                  {obj.errors.map((err, i) => (
                    <p key={i} className="text-[10px] text-[var(--sf-error)]">
                      {err}
                    </p>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Config snapshot summary */}
      <div className="flex flex-col gap-[var(--sf-space-1)]">
        <h5 className="text-xs font-semibold text-text-primary">
          {t('sync.history.configSnapshot')}
        </h5>
        <div className="flex gap-[var(--sf-space-2)] text-[10px] text-text-secondary flex-wrap">
          <Badge variant="default">{t(`sync.directions.${configSnapshot.direction}`)}</Badge>
          <Badge variant="default">{t(`sync.modes.${configSnapshot.mode}`)}</Badge>
          <span>
            {configSnapshot.objects.length} {t('sync.objectSet').toLowerCase()}
          </span>
          <span>
            {configSnapshot.objects.reduce((sum, o) => sum + o.fieldMappings.length, 0)}{' '}
            {t('sync.fieldMapping').toLowerCase()}
          </span>
        </div>
      </div>

      {/* Run Again button */}
      <div className="flex justify-end">
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] hover:bg-[var(--sf-button-hover)]"
          onClick={() => rerun(selectedEntry.id)}
          data-testid="rerun-btn"
        >
          <Icon name="debug-restart" /> {t('sync.history.runAgain')}
        </button>
      </div>
    </div>
  );
};
