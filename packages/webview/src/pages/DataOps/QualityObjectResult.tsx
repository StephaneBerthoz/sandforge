import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DataQualityCheckError,
  DataQualityFieldFill,
  DataQualityObjectResult,
  DataQualityScanBounds,
  DataQualityUnmeasuredReason,
} from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Select } from '../../components/ui/Select';
import { formatNumber, uiLocale } from '../../utils/formatters';

/** Props for {@link QualityObjectResult}. */
export interface QualityObjectResultProps {
  result: DataQualityObjectResult;
  bounds: DataQualityScanBounds;
  /** The staleness threshold the result was counted with. */
  staleDays: number;
  /** The duplicate key the page asked for, when it asked for one. */
  requestedKey?: string;
  /** Look for duplicates by another field. */
  onKeyChange: (fieldApiName: string) => void;
  /** A scan is in flight: the key cannot change under it. */
  busy: boolean;
}

/**
 * Empty on most records: filled on fewer than half of them. An object with no
 * records has no field to call empty.
 */
export function isMostlyEmpty(field: DataQualityFieldFill, totalRecords: number): boolean {
  return totalRecords > 0 && field.filled * 2 < totalRecords;
}

/** A field the org requires on a new record, empty on records it already holds. */
export function isRequiredButEmpty(field: DataQualityFieldFill, totalRecords: number): boolean {
  return field.required && field.filled < totalRecords;
}

const cell = 'py-1 pr-3 text-left';
const headerCell = `${cell} font-medium text-text-secondary`;

/** One object of a data-quality scan: its fill counts, its repeated values, its stale records. */
export const QualityObjectResult: React.FC<QualityObjectResultProps> = ({
  result,
  bounds,
  staleDays,
  requestedKey,
  onKeyChange,
  busy,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  // Written in the language picked in SandForge, like every figure beside it.
  const number = (n: number): string => formatNumber(n);
  const percent = (part: number, whole: number): string =>
    new Intl.NumberFormat(uiLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(
      whole > 0 ? part / whole : 0,
    );

  const checkError = (error: DataQualityCheckError): string => {
    switch (error.check) {
      case 'fill':
        return t('dataops.qualityScan.fillRefused', { message: error.message });
      case 'duplicates':
        return t('dataops.qualityScan.duplicatesRefused', { message: error.message });
      default:
        return t('dataops.qualityScan.staleRefused', { message: error.message });
    }
  };

  const unmeasuredReason = (reason: DataQualityUnmeasuredReason): string => {
    switch (reason) {
      case 'not-countable':
        return t('dataops.qualityScan.notCountable');
      case 'query-budget':
        return t('dataops.qualityScan.queryBudget', { limit: bounds.singleFieldQueries });
      default:
        return t('dataops.qualityScan.refusedByOrg');
    }
  };

  if (result.status === 'failed') {
    return (
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-1 rounded-lg border border-(--sf-border) p-3"
        data-testid={`quality-object-${result.objectApiName}`}
      >
        <h3 id={headingId} className="font-mono text-sm font-semibold text-text-primary">
          {result.objectApiName}
        </h3>
        <p className="text-xs text-status-error" data-testid="quality-object-failed">
          {t('dataops.qualityScan.objectFailed', { message: result.message })}
        </p>
      </section>
    );
  }

  const total = result.totalRecords;
  const mostlyEmpty = result.fields.filter((f) => isMostlyEmpty(f, total));
  const requiredEmpty = result.fields.filter((f) => isRequiredButEmpty(f, total));
  const duplicates = result.duplicates;
  const currentKey = duplicates?.keyField ?? requestedKey ?? '';
  const unmeasuredBy = (reason: DataQualityUnmeasuredReason) =>
    result.unmeasured.filter((f) => f.reason === reason);

  const fillTable = (fields: DataQualityFieldFill[], testId: string) => (
    <table className="w-full text-xs" data-testid={testId}>
      <thead>
        <tr className="border-b border-(--sf-border)">
          <th scope="col" className={headerCell}>
            {t('dataops.qualityScan.field')}
          </th>
          <th scope="col" className={`${headerCell} text-right`}>
            {t('dataops.qualityScan.filled')}
          </th>
          <th scope="col" className={`${headerCell} text-right`}>
            {t('dataops.qualityScan.fillRate')}
          </th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr
            key={f.fieldApiName}
            className="border-b border-(--sf-border) last:border-0"
            data-testid={`quality-field-${f.fieldApiName}`}
          >
            <th scope="row" className={`${cell} font-normal text-text-primary`}>
              <span>{f.label}</span>{' '}
              {f.label !== f.fieldApiName && (
                <span className="font-mono text-text-secondary">{f.fieldApiName}</span>
              )}
              {f.filled === 0 && (
                <Badge variant="warning" className="ml-1">
                  {t('dataops.qualityScan.neverFilled')}
                </Badge>
              )}
            </th>
            <td className={`${cell} text-right text-text-primary`}>{number(f.filled)}</td>
            <td className={`${cell} text-right text-text-primary`}>{percent(f.filled, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-(--sf-border) p-3"
      data-testid={`quality-object-${result.objectApiName}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-text-primary">
          {result.label}{' '}
          {result.label !== result.objectApiName && (
            <span className="font-mono text-xs font-normal">{result.objectApiName}</span>
          )}
        </h3>
        <span className="text-xs text-text-secondary" data-testid="quality-total">
          {t('dataops.qualityScan.records', { count: total, formatted: number(total) })}
        </span>
      </div>

      {total === 0 ? (
        <p className="text-xs text-text-secondary" data-testid="quality-no-records">
          {t('dataops.qualityScan.noRecords')}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="quality-summary">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-text-secondary">
                {t('dataops.qualityScan.mostlyEmpty')}
              </dt>
              <dd
                className="text-sm font-semibold text-text-primary"
                data-testid="quality-summary-empty"
              >
                {t('dataops.qualityScan.ofCounted', {
                  part: number(mostlyEmpty.length),
                  whole: number(result.fields.length),
                })}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-text-secondary">
                {t('dataops.qualityScan.requiredEmpty')}
              </dt>
              <dd
                className="text-sm font-semibold text-text-primary"
                data-testid="quality-summary-required"
              >
                {number(requiredEmpty.length)}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-text-secondary">{t('dataops.qualityScan.duplicates')}</dt>
              <dd
                className="text-sm font-semibold text-text-primary"
                data-testid="quality-summary-duplicates"
              >
                {duplicates
                  ? t('dataops.qualityScan.records', {
                      count: duplicates.recordCount,
                      formatted: number(duplicates.recordCount),
                    })
                  : t('dataops.qualityScan.notMeasured')}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-text-secondary">
                {t('dataops.qualityScan.stale', { count: staleDays })}
              </dt>
              <dd
                className="text-sm font-semibold text-text-primary"
                data-testid="quality-summary-stale"
              >
                {result.stale
                  ? `${number(result.stale.records)} (${percent(result.stale.records, total)})`
                  : t('dataops.qualityScan.notMeasured')}
              </dd>
            </div>
          </dl>

          <div className="flex flex-col gap-2" data-testid="quality-duplicates">
            <h4 className="text-xs font-semibold text-text-primary">
              {t('dataops.qualityScan.duplicates')}
            </h4>
            {result.keyFields.length > 0 ? (
              <div className="max-w-xs">
                <Select
                  label={t('dataops.qualityScan.duplicateKey')}
                  value={currentKey}
                  placeholder={t('dataops.qualityScan.pickKey')}
                  options={result.keyFields.map((f) => ({
                    value: f.fieldApiName,
                    label: f.label === f.fieldApiName ? f.label : `${f.label} (${f.fieldApiName})`,
                  }))}
                  onChange={(e) => onKeyChange(e.target.value)}
                  disabled={busy}
                  data-testid="quality-duplicate-key"
                />
              </div>
            ) : (
              <p className="text-xs text-text-secondary">{t('dataops.qualityScan.noKeyField')}</p>
            )}
            {duplicates && duplicates.groupCount === 0 && (
              <p className="text-xs text-text-secondary" data-testid="quality-no-duplicates">
                {t('dataops.qualityScan.noDuplicates', { field: duplicates.keyLabel })}
              </p>
            )}
            {duplicates && duplicates.groupCount > 0 && (
              <>
                <p className="text-xs text-text-primary" data-testid="quality-duplicate-summary">
                  {t('dataops.qualityScan.duplicateGroups', {
                    count: duplicates.groupCount,
                    formatted: number(duplicates.groupCount),
                    records: number(duplicates.recordCount),
                    field: duplicates.keyLabel,
                  })}
                </p>
                <table className="w-full text-xs" data-testid="quality-duplicate-table">
                  <thead>
                    <tr className="border-b border-(--sf-border)">
                      <th scope="col" className={headerCell}>
                        {duplicates.keyLabel}
                      </th>
                      <th scope="col" className={`${headerCell} text-right`}>
                        {t('dataops.qualityScan.recordsColumn')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicates.groups.map((group) => (
                      <tr key={group.value} className="border-b border-(--sf-border) last:border-0">
                        <td className={`${cell} break-all text-text-primary`}>{group.value}</td>
                        <td className={`${cell} text-right text-text-primary`}>
                          {number(group.count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {duplicates.groupCount > duplicates.groups.length && (
                  <p className="text-xs text-text-secondary">
                    {t('dataops.qualityScan.duplicateSample', {
                      shown: number(duplicates.groups.length),
                      total: number(duplicates.groupCount),
                    })}
                  </p>
                )}
                {duplicates.truncated && (
                  <p
                    className="text-xs text-status-warning"
                    data-testid="quality-duplicates-truncated"
                  >
                    {t('dataops.qualityScan.duplicatesTruncated', {
                      limit: number(bounds.duplicateGroupLimit),
                    })}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-2" data-testid="quality-mostly-empty">
            <h4 className="text-xs font-semibold text-text-primary">
              {t('dataops.qualityScan.mostlyEmpty')}
            </h4>
            {mostlyEmpty.length > 0 ? (
              fillTable(mostlyEmpty, 'quality-mostly-empty-table')
            ) : (
              <p className="text-xs text-text-secondary">
                {t('dataops.qualityScan.noMostlyEmpty')}
              </p>
            )}
          </div>

          {requiredEmpty.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="quality-required-empty">
              <h4 className="text-xs font-semibold text-text-primary">
                {t('dataops.qualityScan.requiredEmpty')}
              </h4>
              <p className="text-xs text-text-secondary">{t('dataops.qualityScan.requiredHint')}</p>
              {fillTable(requiredEmpty, 'quality-required-empty-table')}
            </div>
          )}

          {result.fields.length > 0 && (
            <details data-testid="quality-all-fields">
              <summary className="cursor-pointer text-xs font-semibold text-text-primary">
                {t('dataops.qualityScan.allFields', { total: number(result.fields.length) })}
              </summary>
              <div className="mt-2">{fillTable(result.fields, 'quality-all-fields-table')}</div>
            </details>
          )}
        </>
      )}

      {result.unmeasured.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="quality-unmeasured">
          <h4 className="text-xs font-semibold text-text-primary">
            {t('dataops.qualityScan.unmeasured', { total: number(result.unmeasured.length) })}
          </h4>
          <ul className="flex flex-col gap-1 text-xs text-text-secondary">
            {(['not-countable', 'query-budget', 'refused'] as const)
              .filter((reason) => unmeasuredBy(reason).length > 0)
              .map((reason) => (
                <li key={reason} data-testid={`quality-unmeasured-${reason}`}>
                  <span className="text-text-primary">
                    {unmeasuredBy(reason)
                      .map((f) => f.label)
                      .join(', ')}
                  </span>
                  {' — '}
                  {unmeasuredReason(reason)}
                </li>
              ))}
          </ul>
        </div>
      )}

      {result.errors.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="quality-errors">
          {result.errors.map((error) => (
            <li key={`${error.check}-${error.message}`} className="text-xs text-status-error">
              {checkError(error)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
