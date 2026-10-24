import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncEarlierCopies } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';

/** Props for {@link SyncEarlierCopiesNotice}. */
export interface SyncEarlierCopiesNoticeProps {
  sourceOrgId: string;
  targetOrgId: string;
  /** The objects the run inserts without a key: those it would write a second copy of. */
  objects: readonly string[];
  /** The configuration the run is of, when it may be saved: its runs leave what earlier ones copied. */
  configId?: string;
  /** Where it is said: before a Quick Sync, or before a history entry's Run again. */
  context: 'quickSync' | 'runAgain';
  testId?: string;
}

/**
 * What the last run between the same orgs left in the target, said before a
 * run that inserts the same objects again: a Quick Sync, which keeps no
 * configuration, or a Run again of the history.
 *
 * Every re-run inserted every record again, and no screen said so: a Quick
 * Sync run each week to refresh a sandbox added a full copy of every record
 * each time. A run of a saved configuration leaves as they are the records
 * its earlier runs copied, and says so; any other is told how many the last
 * run created that the target still holds.
 */
export const SyncEarlierCopiesNotice: React.FC<SyncEarlierCopiesNoticeProps> = ({
  sourceOrgId,
  targetOrgId,
  objects,
  configId,
  context,
  testId,
}) => {
  const { t } = useTranslation();
  const query = useBridgeQuery<{ copies: SyncEarlierCopies }>(
    'sync:earlier-copies',
    {
      sourceOrgId,
      targetOrgId,
      objects: [...objects],
      ...(configId !== undefined ? { configId } : {}),
    },
    {
      errorType: 'sync:remove:error',
      skip: objects.length === 0 || sourceOrgId === '' || targetOrgId === '',
    },
  );
  const copies = query.data?.copies;
  if (!copies) return null;
  if (copies.leftAsIs) {
    return context === 'runAgain' ? (
      <p className="text-xs text-text-secondary" data-testid={testId}>
        {t('sync.earlierCopies.leftAsIs')}
      </p>
    ) : null;
  }
  if (copies.objects.length === 0 || !copies.run) return null;
  const words = {
    date: formatStoredDate(copies.run.startedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
    objects: listWords(
      copies.objects.map(({ objectApiName, count }) => `${objectApiName} (${formatNumber(count)})`),
      (key) => t(key),
    ),
  };
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <p className="text-xs text-status-warning">
        {/* A session of the Real-Time tab is removed on that tab, never from the history. */}
        {copies.run.realtime
          ? context === 'quickSync'
            ? t('sync.earlierCopies.quickSyncSession', words)
            : t('sync.earlierCopies.runAgainSession', words)
          : context === 'quickSync'
            ? t('sync.earlierCopies.quickSync', words)
            : t('sync.earlierCopies.runAgain', words)}
      </p>
      {copies.unread !== undefined && (
        <p className="text-[11px] text-text-secondary">
          {t('sync.earlierCopies.unread', { reason: copies.unread })}
        </p>
      )}
    </div>
  );
};
