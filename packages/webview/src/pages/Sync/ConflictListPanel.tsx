import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  useConflictStore,
  filteredConflicts as filterConflicts,
} from '../../stores/useConflictStore';
import type { UIConflict, ConflictType } from '@sandforge/shared';
import { DataTable } from '../../components/ui/DataTable';
import type { DataTableColumn } from '../../components/ui/DataTable';
import { Pagination } from '../../components/ui/Pagination';
import { Badge } from '../../components/ui/Badge';
import { usePagination } from '../../hooks/usePagination';
import { EmptyState } from '../../components/ui/EmptyState';

/** Conflict type display map keyed by ConflictType. */
const conflictTypeI18nMap: Record<ConflictType, string> = {
  'edit/edit': 'sync.conflictResolution.conflictTypes.editEdit',
  'delete/edit': 'sync.conflictResolution.conflictTypes.deleteEdit',
  'edit/delete': 'sync.conflictResolution.conflictTypes.editDelete',
  'create/edit': 'sync.conflictResolution.conflictTypes.createEdit',
};

/**
 * Panel displaying a paginated, filterable list of conflicts.
 * Uses DataTable for tabular display and usePagination for client-side paging.
 */
export const ConflictListPanel: React.FC = () => {
  const { t } = useTranslation();
  const conflicts = useConflictStore((s) => s.conflicts);
  const selectConflict = useConflictStore((s) => s.selectConflict);
  const filterObject = useConflictStore((s) => s.filterObject);
  const filterType = useConflictStore((s) => s.filterType);
  const setFilterObject = useConflictStore((s) => s.setFilterObject);
  const setFilterType = useConflictStore((s) => s.setFilterType);
  const clearResolved = useConflictStore((s) => s.clearResolved);

  const filtered = React.useMemo(
    () => filterConflicts(conflicts, filterObject, filterType),
    [conflicts, filterObject, filterType],
  );

  const pagination = usePagination({
    totalItems: filtered.length,
    initialPageSize: 20,
  });

  const paginatedData = pagination.paginatedSlice(filtered);

  /** Unique object names from all conflicts for filter dropdown. */
  const uniqueObjects = React.useMemo(
    () => [...new Set(conflicts.map((c) => c.objectApiName))].sort(),
    [conflicts],
  );

  /** Unique conflict types from all conflicts for filter dropdown. */
  const uniqueTypes = React.useMemo(
    () => [...new Set(conflicts.map((c) => c.conflictType))].sort(),
    [conflicts],
  );

  const columns: DataTableColumn<UIConflict>[] = React.useMemo(
    () => [
      {
        key: 'objectApiName',
        header: t('common.object'),
        sortable: true,
      },
      {
        key: 'recordId',
        header: 'Record ID',
        render: (row: UIConflict) => <span className="font-mono text-[10px]">{row.recordId}</span>,
      },
      {
        key: 'conflictType',
        header: t('sync.conflictResolution.filterByType'),
        render: (row: UIConflict) => (
          <Badge variant="default">{t(conflictTypeI18nMap[row.conflictType])}</Badge>
        ),
      },
      {
        key: 'conflictFields',
        header: t('sync.conflictResolution.fieldCount', { count: 0 }).replace('0', '#'),
        render: (row: UIConflict) => (
          <span>
            {t('sync.conflictResolution.fieldCount', { count: row.conflictFields.length })}
          </span>
        ),
      },
      {
        key: 'resolved',
        header: 'Status',
        render: (row: UIConflict) =>
          row.resolved ? (
            <Badge variant="success">{t('sync.conflictResolution.resolved')}</Badge>
          ) : (
            <Badge variant="warning">{t('sync.conflictResolution.unresolved')}</Badge>
          ),
      },
      {
        key: 'timestamp',
        header: 'Timestamp',
        sortable: true,
        render: (row: UIConflict) => (
          <span className="text-[10px]">{new Date(row.timestamp).toLocaleString()}</span>
        ),
      },
    ],
    [t],
  );

  if (conflicts.length === 0) {
    return (
      <div data-testid="conflict-list-panel">
        <EmptyState
          icon="warning"
          title={t('sync.conflictResolution.title')}
          description={t('sync.conflictResolution.noConflicts')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 h-full" data-testid="conflict-list-panel">
      {/* Filters bar */}
      <div className="flex items-center gap-2 px-2 pt-2" data-testid="conflict-filters">
        <select
          value={filterObject ?? ''}
          onChange={(e) => setFilterObject(e.target.value || null)}
          className="text-xs px-2 py-1 rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#d4d4d4)] border border-[var(--vscode-input-border,#3c3c3c)]"
          aria-label={t('sync.conflictResolution.filterByObject')}
          data-testid="filter-object"
        >
          <option value="">{t('sync.conflictResolution.filterByObject')}</option>
          {uniqueObjects.map((obj) => (
            <option key={obj} value={obj}>
              {obj}
            </option>
          ))}
        </select>

        <select
          value={filterType ?? ''}
          onChange={(e) => setFilterType(e.target.value || null)}
          className="text-xs px-2 py-1 rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#d4d4d4)] border border-[var(--vscode-input-border,#3c3c3c)]"
          aria-label={t('sync.conflictResolution.filterByType')}
          data-testid="filter-type"
        >
          <option value="">{t('sync.conflictResolution.filterByType')}</option>
          {uniqueTypes.map((type) => (
            <option key={type} value={type}>
              {t(conflictTypeI18nMap[type])}
            </option>
          ))}
        </select>

        <div className="ml-auto">
          <button
            type="button"
            onClick={clearResolved}
            className="text-xs px-2 py-1 rounded bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#fff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]"
            data-testid="clear-resolved-btn"
          >
            {t('sync.conflictResolution.clearResolved')}
          </button>
        </div>
      </div>

      {/* Data table */}
      <DataTable<UIConflict & Record<string, unknown>>
        columns={columns as DataTableColumn<UIConflict & Record<string, unknown>>[]}
        data={paginatedData as (UIConflict & Record<string, unknown>)[]}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => selectConflict(row.id)}
        emptyMessage={t('sync.conflictResolution.noConflicts')}
      />

      {/* Pagination */}
      <Pagination
        page={pagination.page}
        pageSize={pagination.pageSize}
        totalItems={filtered.length}
        totalPages={pagination.totalPages}
        canNext={pagination.canNext}
        canPrev={pagination.canPrev}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        data-testid="conflict-pagination"
      />
    </div>
  );
};
