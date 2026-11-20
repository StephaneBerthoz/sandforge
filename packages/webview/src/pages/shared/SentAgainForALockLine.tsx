import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SentAgainForALock } from '@sandforge/shared';

/** Props for {@link SentAgainForALockLine}. */
export interface SentAgainForALockLineProps {
  /** What the run sent again for a lock, of one object; nothing is said without it. */
  entry: SentAgainForALock | undefined;
  /** Test id of the line. */
  testId: string;
  /** The element it renders as: a list item among the lines of a list. */
  as?: 'li' | 'p';
  className?: string;
  /**
   * The key of its first sentence, counting `{{count}}` and `{{written}}`:
   * the records of an insert by default; a Frozen load's updates and its
   * purge's deletes say theirs.
   */
  leadKey?: string;
}

/**
 * The records of one object the target refused because it could not lock a
 * record their write needed, sent again on their own, and what became of
 * them: written, still refused for the lock, or refused for another reason —
 * those two among the object's refusals, which say why.
 *
 * Sync's results and Autopilot's nodes said the refusals of those the lock
 * still held, and nothing of the others: a send again that wrote them was in
 * the run's log alone, and a run that had met the lock and written every row
 * read as one that never met it.
 */
export const SentAgainForALockLine: React.FC<SentAgainForALockLineProps> = ({
  entry,
  testId,
  as: Element = 'p',
  className,
  leadKey = 'runResults.sentAgainForALock.lead',
}) => {
  const { t } = useTranslation();
  if (!entry || entry.rows <= 0) return null;
  const otherwise = Math.max(0, entry.rows - entry.written - entry.stillLocked);
  const parts = [
    t(leadKey, { count: entry.rows, written: entry.written }),
    ...(entry.stillLocked > 0
      ? [t('runResults.sentAgainForALock.stillLocked', { count: entry.stillLocked })]
      : []),
    ...(otherwise > 0 ? [t('runResults.sentAgainForALock.otherwise', { count: otherwise })] : []),
  ];
  return (
    <Element className={className} data-testid={testId}>
      {parts.join(' ')}
    </Element>
  );
};
