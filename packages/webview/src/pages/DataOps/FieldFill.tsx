import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DataQualityFieldFill,
  DataQualityUnmeasuredField,
  DataQualityUnmeasuredReason,
} from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { formatNumber, uiLocale } from '../../utils/formatters';

/** Props for {@link FieldFill}. */
export interface FieldFillProps {
  /** The fields a person or an integration fills in, emptiest first. */
  fields: readonly DataQualityFieldFill[];
  /** Such fields the scan could not count, and why. */
  unmeasured: readonly DataQualityUnmeasuredField[];
  /** The object's records: every count is out of this many. */
  totalRecords: number;
  /** Fields the scan counts with a query of their own, per object, at most. */
  singleFieldQueries: number;
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

/**
 * How filled each field of an object is, as Cleanup's scan counted it: the
 * fields most records leave empty, the required ones some leave empty, every
 * field counted, and those it could not count. Quality said it on a tab of its
 * own, with the same picker and the same scan as Cleanup.
 */
export const FieldFill: React.FC<FieldFillProps> = ({
  fields,
  unmeasured,
  totalRecords,
  singleFieldQueries,
}) => {
  const { t } = useTranslation();
  // Written in the language picked in SandForge, like every figure beside it.
  const number = (n: number): string => formatNumber(n);
  const percent = (part: number, whole: number): string =>
    new Intl.NumberFormat(uiLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(
      whole > 0 ? part / whole : 0,
    );

  const unmeasuredReason = (reason: DataQualityUnmeasuredReason): string => {
    switch (reason) {
      case 'not-countable':
        return t('dataops.qualityScan.notCountable');
      case 'query-budget':
        return t('dataops.qualityScan.queryBudget', { limit: singleFieldQueries });
      default:
        return t('dataops.qualityScan.refusedByOrg');
    }
  };

  const mostlyEmpty = fields.filter((f) => isMostlyEmpty(f, totalRecords));
  const requiredEmpty = fields.filter((f) => isRequiredButEmpty(f, totalRecords));
  const unmeasuredBy = (reason: DataQualityUnmeasuredReason) =>
    unmeasured.filter((f) => f.reason === reason);

  const fillTable = (shown: readonly DataQualityFieldFill[], testId: string) => (
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
        {shown.map((f) => (
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
            <td className={`${cell} text-right text-text-primary`}>
              {percent(f.filled, totalRecords)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="quality-fields">
      {totalRecords > 0 && (
        <>
          <div className="flex flex-col gap-2" data-testid="quality-mostly-empty">
            <h4 className="text-xs font-semibold text-text-primary">
              {t('dataops.qualityScan.mostlyEmpty')}{' '}
              <span className="font-normal text-text-secondary" data-testid="quality-summary-empty">
                {t('dataops.qualityScan.ofCounted', {
                  part: number(mostlyEmpty.length),
                  whole: number(fields.length),
                })}
              </span>
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

          {fields.length > 0 && (
            <details data-testid="quality-all-fields">
              <summary className="cursor-pointer text-xs font-semibold text-text-primary">
                {t('dataops.qualityScan.allFields', { total: number(fields.length) })}
              </summary>
              <div className="mt-2">{fillTable(fields, 'quality-all-fields-table')}</div>
            </details>
          )}
        </>
      )}

      {unmeasured.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="quality-unmeasured">
          <h4 className="text-xs font-semibold text-text-primary">
            {t('dataops.qualityScan.unmeasured', { total: number(unmeasured.length) })}
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
    </div>
  );
};
