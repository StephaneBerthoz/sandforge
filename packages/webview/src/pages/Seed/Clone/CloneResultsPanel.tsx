import React, { useState, useCallback, useMemo } from 'react';
import { useFileSave } from '../../../hooks/useFileSave';
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

/**
 * Status to the words its badge shows, as the Seed results name theirs: the
 * badge read the code the host sent, `success` or `partial`, in every language.
 */
const STATUS_LABEL: Record<CloneExecutionResult['status'], string> = {
  success: 'seed.clone.results.statusSuccess',
  partial: 'seed.clone.results.statusPartial',
  failure: 'seed.clone.results.statusFailure',
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
export const CloneResultsPanel: React.FC<CloneResultsPanelProps> = ({ result, onDone }) => {
  const { save } = useFileSave();
  const { t } = useTranslation();

  /** Track current pagination page per object. */
  const [objectPages, setObjectPages] = useState<Record<string, number>>({});

  /** Format duration from milliseconds. */
  const formattedDuration = useMemo(
    () => (result.durationMs / 1000).toFixed(1),
    [result.durationMs],
  );

  /** The second pass, when the clone owed one. */
  const secondPass = result.secondPass;
  /** Per object, the fields the target does not have, which the clone left out. */
  const fieldsNotInTarget = result.objectResults.flatMap(
    ({ objectApiName, fieldsNotInTarget: fields = [] }) =>
      fields.length > 0 ? [{ objectApiName, fields }] : [],
  );

  /** Get page for a specific object. */
  const getPage = (objectApiName: string): number => objectPages[objectApiName] ?? 1;

  /** Set page for a specific object. */
  const setPage = (objectApiName: string, page: number): void => {
    setObjectPages((prev) => ({ ...prev, [objectApiName]: page }));
  };

  /** Page key for the errors table, kept distinct so it pages independently of the mappings. */
  const errorPageKey = (objectApiName: string): string => `${objectApiName}::errors`;

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
    // Saved by the host: a webview is sandboxed without `allow-downloads`, so
    // the detached-anchor click this replaces frequently wrote nothing.
    save('clone-id-mapping.csv', lines.join('\n'), ['csv']);
  }, [result.objectResults, save]);

  /** Build accordion content for a single object result. */
  const buildObjectContent = (objResult: CloneObjectResult): React.ReactNode => {
    const page = getPage(objResult.objectApiName);
    const totalMappings = objResult.idMappings.length;
    const totalPages = Math.max(1, Math.ceil(totalMappings / MAPPING_PAGE_SIZE));
    const start = (page - 1) * MAPPING_PAGE_SIZE;
    const paginatedMappings = objResult.idMappings.slice(start, start + MAPPING_PAGE_SIZE);

    const errorKey = errorPageKey(objResult.objectApiName);
    const errorPage = getPage(errorKey);
    const totalErrors = objResult.errors.length;
    const errorTotalPages = Math.max(1, Math.ceil(totalErrors / MAPPING_PAGE_SIZE));
    const errorStart = (errorPage - 1) * MAPPING_PAGE_SIZE;
    const paginatedErrors = objResult.errors.slice(errorStart, errorStart + MAPPING_PAGE_SIZE);

    return (
      <div className="flex flex-col gap-2">
        {(objResult.linkedCount ?? 0) > 0 && (
          <span className="text-xs text-status-success" data-testid="clone-object-linked">
            {t('seed.clone.results.linked')}: {objResult.linkedCount}
          </span>
        )}
        {(objResult.leftToThePlatform ?? 0) > 0 && (
          <span
            className="text-xs text-(--sf-text-secondary)"
            data-testid="clone-object-left-to-the-platform"
          >
            {t('seed.clone.results.leftToThePlatform')}: {objResult.leftToThePlatform}
          </span>
        )}
        {/* ID Mappings */}
        {paginatedMappings.length > 0 && (
          <>
            <span className="text-xs font-medium text-(--sf-text-primary)">
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
        {totalErrors > 0 && (
          <>
            <span className="text-xs font-medium text-status-error">
              {t('seed.clone.results.failed')} ({totalErrors})
            </span>
            <DataTable
              columns={errorColumns}
              data={paginatedErrors}
              keyExtractor={(row) => row.sourceId}
              enableVirtualization={false}
            />
            {errorTotalPages > 1 && (
              <Pagination
                page={errorPage}
                pageSize={MAPPING_PAGE_SIZE}
                totalItems={totalErrors}
                totalPages={errorTotalPages}
                canNext={errorPage < errorTotalPages}
                canPrev={errorPage > 1}
                onPageChange={(p) => setPage(errorKey, p)}
                onPageSizeChange={() => {
                  /* fixed page size */
                }}
              />
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-(--sf-space-4)" data-testid="clone-results-panel">
      {/* Overall status */}
      <div className="flex items-center gap-3" data-testid="clone-results-summary">
        <span className="text-sm font-semibold text-(--sf-text-primary)">
          {t('seed.clone.results.title')}
        </span>
        {/* A clone the Cancel stopped reads as cancelled, as a seed does, not
            as one that ran to its end with failures. */}
        {result.cancelled ? (
          <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
        ) : (
          <Badge variant={STATUS_VARIANT[result.status] ?? 'default'}>
            {t(STATUS_LABEL[result.status])}
          </Badge>
        )}
        <span className="text-xs text-(--sf-text-secondary)">
          {t('seed.clone.results.duration')}: {formattedDuration}s
        </span>
      </div>

      {/* Summary counts */}
      <div className="flex items-center gap-4 text-xs" data-testid="clone-results-counts">
        <span className="text-(--sf-text-primary)">
          {t('seed.clone.results.summary')}:{' '}
          {t('common.recordCount', { count: result.totalSourceRecords })}
        </span>
        <span className="text-status-success">
          {t('seed.clone.results.inserted')}: {result.totalInserted}
        </span>
        {/* Records the target already held, linked to rather than written:
            neither inserted nor failed, so counted on their own. */}
        {(result.totalLinked ?? 0) > 0 && (
          <span className="text-status-success" data-testid="clone-results-linked">
            {t('seed.clone.results.linked')}: {result.totalLinked}
          </span>
        )}
        {/* Records read and never sent: neither inserted nor failed. */}
        {(result.totalLeftToThePlatform ?? 0) > 0 && (
          <span
            className="text-(--sf-text-secondary)"
            data-testid="clone-results-left-to-the-platform"
          >
            {t('seed.clone.results.leftToThePlatform')}: {result.totalLeftToThePlatform}
          </span>
        )}
        {result.totalFailed > 0 && (
          <span className="text-status-error">
            {t('seed.clone.results.failed')}: {result.totalFailed}
          </span>
        )}
      </div>

      {/* What a cancelled clone created stays in the target: nothing takes
          it back, and the objects it never reached are not listed below. */}
      {result.cancelled && (
        <div
          className="rounded-sm border border-(--sf-border) px-3 py-2 text-xs text-(--sf-text-secondary)"
          role="status"
          data-testid="clone-results-cancelled"
        >
          <p>
            {result.totalInserted > 0
              ? t('seed.clone.results.cancelled', { count: result.totalInserted })
              : t('seed.clone.results.cancelledNothing')}
          </p>
        </div>
      )}

      {/* The lookups written empty and filled in once the record they point
          at was in: how many were, and why the others were not. */}
      {secondPass && (
        <div
          className={`rounded border px-3 py-2 text-xs ${
            secondPass.filled < secondPass.owed
              ? 'border-status-warning text-status-warning'
              : 'border-(--sf-border) text-(--sf-text-secondary)'
          }`}
          role="status"
          data-testid="clone-results-second-pass"
        >
          <p>
            {t('seed.clone.results.secondPass', {
              filled: secondPass.filled,
              owed: secondPass.owed,
            })}
          </p>
          {/* A pass the cancel came before never ran: its one sample says so
              in English, and this says it in the reader's language. */}
          {secondPass.cancelledBefore ? (
            <p className="mt-1">
              {t('seed.clone.results.secondPassCancelled', { count: secondPass.owed })}
            </p>
          ) : (
            secondPass.samples.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {/* Two batches of one object refused whole read the same: keyed by place. */}
                {secondPass.samples.map((sample, index) => (
                  <li key={index}>
                    <span className="font-mono">{sample.record}</span>
                    {` — ${sample.messages.join(' ')}`}
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

      {/* Read from the source and not in the target: left out of every
          record, which the target would have refused whole. */}
      {fieldsNotInTarget.length > 0 && (
        <div
          className="rounded-sm border border-(--sf-border) px-3 py-2 text-xs text-(--sf-text-secondary)"
          role="status"
          data-testid="clone-results-fields-not-in-target"
        >
          <p>{t('seed.clone.results.fieldsNotInTarget')}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {fieldsNotInTarget.map(({ objectApiName, fields }) => (
              <li key={objectApiName}>
                <span className="font-mono text-(--sf-text-primary)">{objectApiName}</span>
                {` — ${fields.join(', ')}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-object accordion */}
      <Accordion
        items={result.objectResults.map((objResult) => ({
          title: `${objResult.objectApiName} — ${t('seed.clone.results.insertedOf', {
            inserted: objResult.insertedCount,
            count: objResult.sourceCount,
          })}`,
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
        <Button variant="primary" size="sm" onClick={onDone} data-testid="clone-results-done">
          {t('seed.clone.results.done')}
        </Button>
      </div>
    </div>
  );
};
