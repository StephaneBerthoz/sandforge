import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Icon } from '../../components/ui/Icon';
import { formatStoredDate } from '../../utils/formatters';

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
          {/* A run a cancel stopped reads as cancelled, not as the partial
              status its objects came to; the text below says before what. */}
          {result.cancelled ? (
            <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
          ) : (
            <Badge variant={statusVariant[result.status] ?? 'default'}>
              {t(`sync.history.status_${result.status}`)}
            </Badge>
          )}
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

      {/* Meta info. The times are read from storage: one that is not a date
          reads as unknown, where formatting it threw and the detail did not
          open. */}
      <div className="flex gap-[var(--sf-space-3)] text-xs text-text-secondary">
        <span>{formatStoredDate(startTime, 'yyyy-MM-dd HH:mm:ss') ?? t('common.dateUnknown')}</span>
        <span>
          {t('sync.history.triggeredBy')}:{' '}
          {t(`sync.history.triggered${triggeredBy.charAt(0).toUpperCase()}${triggeredBy.slice(1)}`)}
        </span>
        {endTime && (
          <span>
            {t('sync.history.endTime')}:{' '}
            {formatStoredDate(endTime, 'HH:mm:ss') ?? t('common.dateUnknown')}
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
              <div className="text-lg font-bold text-status-success">{result.totalSuccess}</div>
              <div className="text-[10px] text-text-secondary">{t('sync.totalSuccess')}</div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-center">
              <div className="text-lg font-bold text-status-error">{result.totalFailed}</div>
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

      {/*
        Why the run ended. Until 1.23.1 a run that threw before it read an
        object showed "failure" and four zeroes, with its reason only in the
        output channel and a toast the user had already dismissed.
      */}
      {result.error && (
        <Card>
          <CardBody>
            <h5 className="mb-1 text-xs font-semibold text-status-error">
              {t('sync.history.failureReason')}
            </h5>
            <p className="text-[11px] text-text-primary" data-testid="history-failure-reason">
              {result.error}
            </p>
          </CardBody>
        </Card>
      )}

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
                <span className="text-status-success">
                  {t('sync.history.successCount')}: {obj.success}
                </span>
                <span className="text-status-error">
                  {t('sync.history.failedCount')}: {obj.failed}
                </span>
                <span>
                  {t('sync.history.skippedCount')}: {obj.skipped}
                </span>
              </div>
              {obj.errors.length > 0 && (
                <div className="mt-1">
                  {obj.errors.map((err, i) => (
                    <p key={i} className="text-[10px] text-status-error">
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
          <span>{t('common.objectCount', { count: configSnapshot.objects.length })}</span>
          <span>
            {t('sync.fieldMappingCount', {
              count: configSnapshot.objects.reduce((sum, o) => sum + o.fieldMappings.length, 0),
            })}
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
