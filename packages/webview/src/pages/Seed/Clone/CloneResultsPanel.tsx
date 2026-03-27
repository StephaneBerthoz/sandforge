import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CloneExecutionResult, CloneObjectResult } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import type { BadgeVariant } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Accordion } from '../../../components/ui/Accordion';
import { DataTable } from '../../../components/ui/DataTable';
import type { DataTableColumn } from '../../../components/ui/DataTable';
import { Pagination } from '../../../components/ui/Pagination';

/** Page size for ID mapping tables. */
const MAPPING_PAGE_SIZE = 25;

/** Status to Badge variant mapping. */
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Props for the CloneResultsPanel component. */
export interface CloneResultsPanelProps {
  /** Clone execution result. */
  result: CloneExecutionResult;
  /** Callback when user clicks Done. */
  onDone: () => void;
}

/**
 * Displays clone execution results: overall status, per-object
 * results with ID mapping tables, error lists, and an export button.
 */
export const CloneResultsPanel: React.FC<CloneResultsPanelProps> = ({
  result,
  onDone,
}) => {
  const { t } = useTranslation();

  /** Track current pagination page per object. */
  const [objectPages, setObjectPages] = useState<Record<string, number>>({});

  /** Format duration from milliseconds. */
  const formattedDuration = useMemo(
    () => (result.durationMs / 1000).toFixed(1),
    [result.durationMs],
  );

  /** Get page for a specific object. */
  const getPage = (objectApiName: string): number =>
    objectPages[objectApiName] ?? 1;

  /** Set page for a specific object. */
  const setPage = (objectApiName: string, page: number): void => {
    setObjectPages((prev) => ({ ...prev, [objectApiName]: page }));
  };

  /** ID mapping table columns. */
  const mappingColumns: DataTableColumn<{ sourceId: string; targetId: string }>[] = [
    { key: 'sourceId', header: 'Source ID' },
    { key: 'targetId', header: 'Target ID' },
  ];

  /** Error table columns. */
  const errorColumns: DataTableColumn<{ sourceId: string; message: string }>[] = [
    { key: 'sourceId', header: 'Source ID' },
    { key: 'message', header: t('common.error') },
  ];

  /** Export all ID mappings as CSV and trigger download. */
  const handleExportMapping = useCallback(() => {
    const lines = ['Object,Source ID,Target ID'];
    for (const objResult of result.objectResults) {
      for (const mapping of objResult.idMappings) {
        lines.push(`${objResult.objectApiName},${mapping.sourceId},${mapping.targetId}`);
      }
    }
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'clone-id-mapping.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [result.objectResults]);

  /** Build accordion content for a single object result. */
  const buildObjectContent = (objResult: CloneObjectResult): React.ReactNode => {
    const page = getPage(objResult.objectApiName);
    const totalMappings = objResult.idMappings.length;
    const totalPages = Math.max(1, Math.ceil(totalMappings / MAPPING_PAGE_SIZE));
    const start = (page - 1) * MAPPING_PAGE_SIZE;
    const paginatedMappings = objResult.idMappings.slice(
      start,
      start + MAPPING_PAGE_SIZE,
    );

    return (
      <div className="flex flex-col gap-2">
        {/* ID Mappings */}
        {paginatedMappings.length > 0 && (
          <>
            <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
              {t('seed.clone.results.idMapping')}
            </span>
            <DataTable
              columns={mappingColumns}
              data={paginatedMappings}
              keyExtractor={(row) => row.sourceId}
              enableVirtualization={false}
            />
            {totalPages > 1 && (
              <Pagination
                page={page}
                pageSize={MAPPING_PAGE_SIZE}
                totalItems={totalMappings}
                totalPages={totalPages}
                canNext={page < totalPages}
                canPrev={page > 1}
                onPageChange={(p) => setPage(objResult.objectApiName, p)}
                onPageSizeChange={() => {
                  /* fixed page size */
                }}
              />
            )}
          </>
        )}

        {/* Errors */}
        {objResult.errors.length > 0 && (
          <>
            <span className="text-xs font-medium text-[var(--vscode-errorForeground,#f48771)]">
              {t('seed.clone.results.failed')} ({objResult.errors.length})
            </span>
            <DataTable
              columns={errorColumns}
              data={objResult.errors}
              keyExtractor={(row) => row.sourceId}
              enableVirtualization={false}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)]" data-testid="clone-results-panel">
      {/* Overall status */}
      <div className="flex items-center gap-3" data-testid="clone-results-summary">
        <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.clone.results.title')}
        </span>
        <Badge variant={STATUS_VARIANT[result.status] ?? 'default'}>
          {result.status}
        </Badge>
        <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
          {t('seed.clone.results.duration')}: {formattedDuration}s
        </span>
      </div>

      {/* Summary counts */}
      <div className="flex items-center gap-4 text-xs" data-testid="clone-results-counts">
        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.clone.results.summary')}: {result.totalSourceRecords} {t('seed.records')}
        </span>
        <span className="text-emerald-400">
          {t('seed.clone.results.inserted')}: {result.totalInserted}
        </span>
        {result.totalFailed > 0 && (
          <span className="text-[var(--vscode-errorForeground,#f48771)]">
            {t('seed.clone.results.failed')}: {result.totalFailed}
          </span>
        )}
      </div>

      {/* Per-object accordion */}
      <Accordion
        items={result.objectResults.map((objResult) => ({
          title: `${objResult.objectApiName} -- ${objResult.insertedCount}/${objResult.sourceCount} ${t('seed.clone.results.inserted').toLowerCase()}`,
          content: buildObjectContent(objResult),
        }))}
      />

      {/* Actions */}
      <div className="flex justify-between items-center pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleExportMapping}
          data-testid="clone-export-mapping"
        >
          {t('seed.clone.results.exportMapping')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onDone}
          data-testid="clone-results-done"
        >
          {t('seed.clone.results.done')}
        </Button>
      </div>
    </div>
  );
};
