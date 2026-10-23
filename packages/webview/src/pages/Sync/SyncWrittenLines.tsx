import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeFieldRefusal, SyncObjectResult } from '@sandforge/shared';

/** What an object's result says its write did beside its refusals. */
type WrittenResult = Pick<
  SyncObjectResult,
  | 'linkedToExisting'
  | 'lookupsLeftOut'
  | 'lookupsSetAfter'
  | 'writtenWithoutFields'
  | 'encryptedLeftOut'
>;

/** Props for {@link SyncWrittenLines}. */
export interface SyncWrittenLinesProps {
  /** The object's result. */
  result: WrittenResult;
  /** Test id of the list. */
  testId: string;
}

/**
 * What refused a field records went in again without, as the line says it:
 * in Forge's words, which say the same of a clone's records.
 */
const REFUSED_BY_KEYS: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'runResults.writtenWithoutFields.byValidationRule',
  'restricted-picklist': 'runResults.writtenWithoutFields.byRestrictedPicklist',
  'lookup-filter': 'runResults.writtenWithoutFields.byLookupFilter',
};

/** Whether an object's write did anything {@link SyncWrittenLines} says. */
export function hasWrittenLines(result: WrittenResult): boolean {
  return (
    result.linkedToExisting !== undefined ||
    (result.lookupsLeftOut?.length ?? 0) > 0 ||
    result.lookupsSetAfter !== undefined ||
    result.writtenWithoutFields !== undefined ||
    (result.encryptedLeftOut?.length ?? 0) > 0
  );
}

/**
 * What an object's write did that no refusal says, beside its other lines on
 * the results step, the Quick Sync results and the history detail: the
 * records linked to one the target already holds rather than written, those
 * written without lookups they held, with why, those given lookups at an
 * object written after them, those written again without the fields the
 * target refused them on, and the encrypted fields every record went without,
 * read masked from the source, in the panel's language.
 *
 * Each was a sentence among the object's errors, which the pages list as
 * refusals: "1 × LINKED_TO_EXISTING", "1 × 12 record(s) written without
 * OwnerId" and "1 × 2 record(s) written again without the fields the target
 * refused them on" in red, in English, under a run that had succeeded.
 */
export const SyncWrittenLines: React.FC<SyncWrittenLinesProps> = ({ result, testId }) => {
  const { t } = useTranslation();
  if (!hasWrittenLines(result)) return null;
  const linked = result.linkedToExisting;
  const setAfter = result.lookupsSetAfter;
  const without = result.writtenWithoutFields;
  /** The target's words, after a line that names them. */
  const words = (refusal: string | undefined): React.ReactNode =>
    refusal === undefined ? null : (
      <>
        {` ${t('sync.written.refusal')} `}
        <span className="font-mono wrap-break-word">{refusal}</span>
      </>
    );
  const encrypted = result.encryptedLeftOut ?? [];
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-text-secondary" data-testid={testId}>
      {encrypted.length > 0 && (
        <li className="text-status-warning" data-testid={`${testId}-encrypted`}>
          {t('sync.written.encryptedLeftOut', { fields: encrypted.join(', ') })}
        </li>
      )}
      {linked && (
        <li data-testid={`${testId}-linked`}>
          {t('sync.written.linked', { count: linked.records })}
          {words(linked.refusal)}
        </li>
      )}
      {(result.lookupsLeftOut ?? []).map(({ records, fields, reason, refusal }, at) => (
        <li key={`${reason}:${fields.join(',')}:${at}`} data-testid={`${testId}-${reason}`}>
          {t(`sync.written.${reason}`, { count: records, fields: fields.join(', ') })}
          {words(refusal)}
        </li>
      ))}
      {setAfter && (
        <li data-testid={`${testId}-setAfter`}>
          {t('sync.written.setAfter', {
            count: setAfter.records,
            fields: setAfter.fields.join(', '),
            objects: setAfter.after.join(', '),
          })}
        </li>
      )}
      {without && (
        <li data-testid={`${testId}-withoutFields`}>
          {t('sync.written.withoutFields', { count: without.rows })}
          <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
            {without.fields.map(({ field, rows, refusedBy = 'validation-rule', reason }) => (
              <li key={`${field}:${reason}`} data-testid={`${testId}-withoutFields-${field}`}>
                {t('sync.written.withoutField', {
                  count: rows,
                  field,
                  refusedBy: t(REFUSED_BY_KEYS[refusedBy]),
                })}
                {words(reason)}
              </li>
            ))}
          </ul>
        </li>
      )}
    </ul>
  );
};
