import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgePicklistRefusal, ForgePicklistValuesChanged } from '@sandforge/shared';

/** Why the target would have refused the values, in the user's words. */
const REASON_KEYS: Record<ForgePicklistRefusal, string> = {
  'not-in-target': 'forge.picklists.notInTarget',
  'record-type': 'forge.picklists.recordType',
  'controlling-value': 'forge.picklists.controllingValue',
};

/** Props for {@link ForgePicklistsResult}. */
export interface ForgePicklistsResultProps {
  /** The picklist values the run did not write as it read them. */
  changes: readonly ForgePicklistValuesChanged[];
}

/**
 * The picklist values a run did not write as it read them, per object and
 * field: the target would have refused them — not a value of the field there,
 * or not one the record type the rows went in with allows — so each was
 * replaced by the record type's default, by its first value for a required
 * field it sets no default for, or left out. Said with how many rows, and why.
 */
export const ForgePicklistsResult: React.FC<ForgePicklistsResultProps> = ({ changes }) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-results-picklists"
      className="rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary"
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t('forge.picklists.title')}
      </h3>
      <p className="mt-0.5">{t('forge.picklists.hint')}</p>
      <ul className="mt-1 space-y-0.5">
        {changes.map((change) => {
          const recordType = change.recordType ?? '';
          return (
            <li
              key={[
                change.objectApiName,
                change.field,
                change.reason,
                recordType,
                change.controllingField ?? '',
                change.replacedBy ?? '',
              ].join('|')}
              data-testid="forge-results-picklists-row"
            >
              <span className="font-mono text-text-primary">{`${change.objectApiName}.${change.field}`}</span>
              {` — ${t('forge.picklists.rows', { count: change.rows })}: `}
              <span className="font-mono">{change.values.join(', ')}</span>
              {` — ${t(REASON_KEYS[change.reason], {
                recordType,
                field: change.controllingField ?? '',
              })}, `}
              {change.replacedBy === undefined
                ? t('forge.picklists.leftOut')
                : t(
                    change.replacement === 'first'
                      ? 'forge.picklists.replacedFirst'
                      : 'forge.picklists.replacedDefault',
                    { value: change.replacedBy, recordType },
                  )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
