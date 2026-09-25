import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CleanupObjectResult as CleanupResult,
  CleanupRecommendation,
} from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { formatNumber } from '../../utils/formatters';

/** Props for {@link CleanupObjectResult}. */
export interface CleanupObjectResultProps {
  result: CleanupResult;
  /** The staleness threshold the result was counted with. */
  staleDays: number;
  /** Share of records that must fill a lookup for its empty ones to be orphans. */
  orphanThreshold: number;
  /** Repeated values one duplicate search reads at most. */
  duplicateGroupLimit: number;
  /** Look for duplicates by another field. */
  onKeyChange: (fieldApiName: string) => void;
  /** Save the records a recommendation names to a file. */
  onExport: (recommendation: CleanupRecommendation) => void;
  /** Say what deleting them takes, before anything is deleted. */
  onReview: (recommendation: CleanupRecommendation) => void;
  /** A request is in flight: nothing can start under it. */
  busy: boolean;
}

/**
 * One object of a cleanup scan: its stale records, the orphans of each lookup
 * the business relies on, and the copies of a repeated value — each with the
 * export and the delete of the records it names.
 */
export const CleanupObjectResult: React.FC<CleanupObjectResultProps> = ({
  result,
  staleDays,
  orphanThreshold,
  duplicateGroupLimit,
  onKeyChange,
  onExport,
  onReview,
  busy,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const number = (n: number): string => formatNumber(n);
  const percent = (share: number): string => `${Math.round(share * 100)}%`;

  if (result.status === 'failed') {
    return (
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-1 rounded-lg border border-(--sf-border) p-3"
        data-testid={`cleanup-object-${result.objectApiName}`}
      >
        <h3 id={headingId} className="font-mono text-sm font-semibold text-text-primary">
          {result.objectApiName}
        </h3>
        <p className="text-xs text-status-error">
          {t('dataops.cleanupScan.objectFailed', { message: result.message })}
        </p>
      </section>
    );
  }

  /** The two actions of a recommendation, named for what they act on. */
  const actions = (recommendation: CleanupRecommendation, what: string, testId: string) => (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onExport(recommendation)}
        disabled={busy}
        aria-label={t('dataops.cleanupScan.exportWhat', { what })}
        data-testid={`${testId}-export`}
      >
        {t('dataops.cleanupScan.export')}
      </Button>
      <Button
        variant="danger"
        size="sm"
        onClick={() => onReview(recommendation)}
        disabled={busy}
        aria-label={t('dataops.cleanupScan.deleteWhat', { what })}
        data-testid={`${testId}-delete`}
      >
        {t('dataops.cleanupScan.delete')}
      </Button>
    </div>
  );

  const duplicates = result.duplicates;
  const copies = duplicates ? duplicates.recordCount - duplicates.groupCount : 0;
  const staleText = result.stale
    ? t('dataops.cleanupScan.staleRecords', {
        count: result.stale.records,
        formatted: number(result.stale.records),
        days: number(staleDays),
      })
    : '';

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-(--sf-border) p-3"
      data-testid={`cleanup-object-${result.objectApiName}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-text-primary">
          {result.label}{' '}
          {result.label !== result.objectApiName && (
            <span className="font-mono text-xs font-normal">{result.objectApiName}</span>
          )}
        </h3>
        <span className="text-xs text-text-secondary">
          {t('dataops.cleanupScan.records', {
            count: result.totalRecords,
            formatted: number(result.totalRecords),
          })}
        </span>
      </div>

      <div className="flex flex-col gap-1" data-testid="cleanup-stale">
        <h4 className="text-xs font-semibold text-text-primary">
          {t('dataops.cleanupScan.stale')}
        </h4>
        {result.stale === null ? (
          <p className="text-xs text-text-secondary">{t('dataops.cleanupScan.staleUnmeasured')}</p>
        ) : (
          <>
            <p className="text-xs text-text-primary" data-testid="cleanup-stale-count">
              {staleText}
            </p>
            {result.stale.records > 0 &&
              actions({ kind: 'stale', days: staleDays }, staleText, 'cleanup-stale')}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1" data-testid="cleanup-orphans">
        <h4 className="text-xs font-semibold text-text-primary">
          {t('dataops.cleanupScan.orphans')}
        </h4>
        <p className="text-xs text-text-secondary">
          {t('dataops.cleanupScan.orphansRule', { share: percent(orphanThreshold) })}
        </p>
        {result.orphans.length === 0 ? (
          <p className="text-xs text-text-secondary" data-testid="cleanup-no-orphans">
            {t('dataops.cleanupScan.noOrphans')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {result.orphans.map((orphan) => {
              const text = t('dataops.cleanupScan.orphanLine', {
                count: orphan.empty,
                formatted: number(orphan.empty),
                field: orphan.label,
                parent: orphan.referenceTo,
                filled: number(orphan.filled),
                total: number(result.totalRecords),
              });
              return (
                <li
                  key={orphan.fieldApiName}
                  className="flex flex-col gap-1"
                  data-testid={`cleanup-orphans-${orphan.fieldApiName}`}
                >
                  <p className="text-xs text-text-primary">{text}</p>
                  {actions(
                    { kind: 'orphans', fieldApiName: orphan.fieldApiName },
                    text,
                    `cleanup-orphans-${orphan.fieldApiName}`,
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1" data-testid="cleanup-duplicates">
        <h4 className="text-xs font-semibold text-text-primary">
          {t('dataops.cleanupScan.duplicates')}
        </h4>
        {result.keyFields.length > 0 ? (
          <div className="max-w-xs">
            <Select
              label={t('dataops.qualityScan.duplicateKey')}
              value={duplicates?.keyField ?? ''}
              placeholder={t('dataops.qualityScan.pickKey')}
              options={result.keyFields.map((f) => ({
                value: f.fieldApiName,
                label: f.label === f.fieldApiName ? f.label : `${f.label} (${f.fieldApiName})`,
              }))}
              onChange={(e) => onKeyChange(e.target.value)}
              disabled={busy}
              data-testid="cleanup-duplicate-key"
            />
          </div>
        ) : (
          <p className="text-xs text-text-secondary">{t('dataops.qualityScan.noKeyField')}</p>
        )}
        {duplicates && duplicates.groupCount === 0 && (
          <p className="text-xs text-text-secondary" data-testid="cleanup-no-duplicates">
            {t('dataops.qualityScan.noDuplicates', { field: duplicates.keyLabel })}
          </p>
        )}
        {duplicates && duplicates.groupCount > 0 && (
          <>
            <p className="text-xs text-text-primary" data-testid="cleanup-duplicate-copies">
              {t('dataops.cleanupScan.copies', {
                copies: number(copies),
                values: number(duplicates.groupCount),
                field: duplicates.keyLabel,
              })}
            </p>
            {duplicates.truncated && (
              <p className="text-xs text-status-warning">
                {t('dataops.qualityScan.duplicatesTruncated', {
                  limit: number(duplicateGroupLimit),
                })}
              </p>
            )}
            <p className="text-xs text-text-secondary">{t('dataops.cleanupScan.copiesRule')}</p>
            {actions(
              { kind: 'duplicates', keyField: duplicates.keyField },
              t('dataops.cleanupScan.copiesOf', { field: duplicates.keyLabel }),
              'cleanup-duplicates',
            )}
          </>
        )}
      </div>

      {result.errors.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="cleanup-errors">
          {result.errors.map((error) => (
            <li key={`${error.check}-${error.message}`} className="text-xs text-status-error">
              {error.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
