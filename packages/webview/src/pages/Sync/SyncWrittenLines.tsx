import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncObjectResult } from '@sandforge/shared';

/** Props for {@link SyncWrittenLines}. */
export interface SyncWrittenLinesProps {
  /** The object's result. */
  result: Pick<SyncObjectResult, 'linkedToExisting' | 'lookupsLeftOut'>;
  /** Test id of the list. */
  testId: string;
}

/**
 * What an object's write did that no refusal says, beside its other lines on
 * the results step, the Quick Sync results and the history detail: the
 * records linked to one the target already holds rather than written, and
 * those written without lookups they held, with why, in the panel's language.
 *
 * Both were sentences among the object's errors, which the pages list as
 * refusals: "1 × LINKED_TO_EXISTING" and "1 × 12 record(s) written without
 * OwnerId" in red, in English, under a run that had succeeded.
 */
export const SyncWrittenLines: React.FC<SyncWrittenLinesProps> = ({ result, testId }) => {
  const { t } = useTranslation();
  const linked = result.linkedToExisting;
  const leftOut = result.lookupsLeftOut ?? [];
  if (!linked && leftOut.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-text-secondary" data-testid={testId}>
      {linked && (
        <li data-testid={`${testId}-linked`}>
          {t('sync.written.linked', { count: linked.records })}
          {linked.refusal !== undefined && (
            <>
              {` ${t('sync.written.refusal')} `}
              <span className="font-mono wrap-break-word">{linked.refusal}</span>
            </>
          )}
        </li>
      )}
      {leftOut.map(({ records, fields, reason }) => (
        <li key={`${reason}:${fields.join(',')}`} data-testid={`${testId}-${reason}`}>
          {t(`sync.written.${reason}`, { count: records, fields: fields.join(', ') })}
        </li>
      ))}
    </ul>
  );
};
