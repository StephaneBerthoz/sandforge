import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import { DataTable } from '../../components/ui/DataTable';
import type { DataTableColumn } from '../../components/ui/DataTable';
import { Pagination } from '../../components/ui/Pagination';
import { SkeletonTable } from '../../components/ui/SkeletonTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Icon } from '../../components/ui/Icon';
import { usePagination } from '../../hooks/usePagination';
import { formatDuration, formatRelativeTime, formatStoredDate } from '../../utils/formatters';
import type { SyncHistoryEntry } from '@sandforge/shared';
import { SyncHistoryDetail } from './SyncHistoryDetail';

/** Row type compatible with DataTable's Record<string, unknown> constraint. */
type HistoryRow = SyncHistoryEntry & Record<string, unknown>;

/** Map sync status to badge variant. */
const statusVariantMap: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Map triggeredBy to a human-readable label key. */
const triggeredByKeyMap: Record<string, string> = {
  manual: 'sync.history.triggeredManual',
  schedule: 'sync.history.triggeredSchedule',
  rerun: 'sync.history.triggeredRerun',
};

/**
 * SyncHistoryPanel displays a paginated, virtual-scrolled table of sync execution history.
 * Includes export buttons (CSV/JSON), refresh, and row click to view details.
 *
 * The extension's answers reach the store through `useSyncHistoryMessages`,
 * which SyncPage mounts: an export answered after the user left this tab would
 * otherwise have no listener left.
 */
export const SyncHistoryPanel: React.FC = () => {
  const { t } = useTranslation();
  const { entries, loading, selectedEntry, fetchHistory, fetchDetail, exportHistory } =
    useSyncHistoryStore();

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const pagination = usePagination({ totalItems: entries.length });
  const paginatedEntries = useMemo(
    () => pagination.paginatedSlice(entries) as HistoryRow[],
    [entries, pagination],
  );

  const columns: DataTableColumn<HistoryRow>[] = useMemo(
    () => [
      {
        key: 'startTime',
        header: t('sync.history.dateTime'),
        width: '180px',
        // The relative phrase is written in the interface language; the tooltip
        // keeps the exact ISO time, which reads the same in all six. A stored
        // time that is not a date reads as unknown: formatting it threw, and
        // the history listed nothing at all.
        render: (row: HistoryRow) => {
          const unknown = t('common.dateUnknown');
          return (
            <span title={formatStoredDate(row.startTime, 'yyyy-MM-dd HH:mm:ss') ?? unknown}>
              {formatStoredDate(row.startTime, formatRelativeTime) ?? unknown}
            </span>
          );
        },
      },
      {
        key: 'objects',
        header: t('sync.history.objects'),
        render: (row: HistoryRow) =>
          row.result.objectResults.map((o) => o.objectApiName).join(', '),
      },
      {
        key: 'records',
        header: t('sync.history.records'),
        width: '100px',
        align: 'right' as const,
        render: (row: HistoryRow) => String(row.result.totalProcessed),
      },
      {
        key: 'status',
        header: t('sync.history.status'),
        width: '110px',
        // A run a cancel stopped reads as cancelled, in the neutral colour,
        // not as the partial status its objects came to.
        render: (row: HistoryRow) =>
          row.result.cancelled ? (
            <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
          ) : (
            <Badge variant={statusVariantMap[row.result.status] ?? 'default'}>
              {t(`sync.history.status_${row.result.status}`)}
            </Badge>
          ),
      },
      {
        key: 'duration',
        header: t('sync.history.duration'),
        width: '100px',
        align: 'right' as const,
        render: (row: HistoryRow) => formatDuration(row.result.duration),
      },
      {
        key: 'triggeredBy',
        header: t('sync.history.triggeredBy'),
        width: '120px',
        render: (row: HistoryRow) =>
          t(triggeredByKeyMap[row.triggeredBy] ?? 'sync.history.triggeredManual'),
      },
    ],
    [t],
  );

  const isLoading = loading && entries.length === 0;
  const isEmpty = !loading && entries.length === 0;
  const hasData = entries.length > 0;

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="sync-history-panel">
      {isLoading && <SkeletonTable rows={5} columns={6} />}

      {isEmpty && (
        <EmptyState
          title={t('sync.history.emptyTitle')}
          description={t('sync.history.emptyDesc')}
          module="sync"
        />
      )}

      {hasData && (
        <>
          {/* Header bar */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-(--sf-text-primary)">
              {t('sync.history.title')}
            </h3>
            <div className="flex items-center gap-(--sf-space-2)">
              <button
                type="button"
                className="text-xs px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)"
                onClick={() => exportHistory('csv')}
                data-testid="export-csv-btn"
              >
                <Icon name="file" /> CSV
              </button>
              <button
                type="button"
                className="text-xs px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)"
                onClick={() => exportHistory('json')}
                data-testid="export-json-btn"
              >
                <Icon name="file" /> JSON
              </button>
              <button
                type="button"
                className="text-xs px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)"
                onClick={() => fetchHistory()}
                aria-label={t('common.reload')}
                data-testid="refresh-btn"
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>

          {/* Table */}
          <DataTable<HistoryRow>
            columns={columns}
            data={paginatedEntries}
            keyExtractor={(row) => row.id}
            onRowClick={(row) => fetchDetail(row.id)}
            enableVirtualization
            stickyHeader
            striped
          />

          {/* Pagination */}
          <Pagination
            page={pagination.page}
            pageSize={pagination.pageSize}
            totalItems={entries.length}
            totalPages={pagination.totalPages}
            canNext={pagination.canNext}
            canPrev={pagination.canPrev}
            onPageChange={pagination.setPage}
            onPageSizeChange={pagination.setPageSize}
          />

          {/* Detail panel */}
          {selectedEntry && <SyncHistoryDetail />}
        </>
      )}
    </div>
  );
};
