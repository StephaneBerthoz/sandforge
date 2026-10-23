import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncEncryptedFieldsMasked, SyncWriteOrder } from '@sandforge/shared';
import { listWords } from '../../utils/listWords';
import type { ObjectSetEntry } from './ObjectSetEditor';

/** Props for {@link SyncReviewObjects}. */
export interface SyncReviewObjectsProps {
  /** The objects of the configuration on screen. */
  entries: readonly ObjectSetEntry[];
  /** The order a run writes them in, as the extension computed it; null until it answers. */
  order: SyncWriteOrder | null;
  /** Whether the order is being read. */
  orderLoading: boolean;
  /** Whether the order could not be read. */
  orderUnread: boolean;
  /** Whether the configuration on screen is the one saved: its runs leave what earlier ones copied. */
  saved: boolean;
  /**
   * Per object, the encrypted fields the source's user reads masked, which
   * the run leaves out, as the extension read them with the order.
   */
  encrypted?: readonly SyncEncryptedFieldsMasked[];
}

/** The objects in the order a run writes them, those the order does not name after it, as listed. */
function namesInOrder(
  entries: readonly ObjectSetEntry[],
  order: SyncWriteOrder | null,
): ObjectSetEntry[] {
  const byName = new Map(entries.map((entry) => [entry.objectApiName, entry]));
  const ordered = (order?.objects ?? []).flatMap((name) => {
    const entry = byName.get(name);
    return entry ? [entry] : [];
  });
  const named = new Set(ordered.map((entry) => entry.objectApiName));
  return [...ordered, ...entries.filter((entry) => !named.has(entry.objectApiName))];
}

/**
 * What each object of the run does, in the order the run writes them, on the
 * Review step.
 *
 * Review showed the direction, the strategy and counts, and nothing of what
 * an object did: a row set to Delete deleted in the target the records that
 * held the ids the source read, and nothing before the run said it; and the
 * objects went in the order they were added, a contact after the case naming
 * it. Each object now says its operation and key, and the order is the one
 * the run computes from the target's lookups, with why an object moved.
 */
export const SyncReviewObjects: React.FC<SyncReviewObjectsProps> = ({
  entries,
  order,
  orderLoading,
  orderUnread,
  saved,
  encrypted = [],
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const moved = new Map((order?.moved ?? []).map((move) => [move.objectApiName, move]));
  const inserts = entries.some((entry) => entry.operation === 'insert');
  // What an update or an upsert writes over is kept first, and a removal of
  // the run puts it back: said once for the run.
  const overwrites = entries.some(
    (entry) => entry.operation === 'update' || entry.operation === 'upsert',
  );

  const operationWords = (entry: ObjectSetEntry): string => {
    switch (entry.operation) {
      case 'insert':
        return t('sync.reviewObjects.insert');
      case 'upsert':
        return t('sync.reviewObjects.upsert', { key: entry.externalIdField.trim() || 'Id' });
      case 'update':
        return t('sync.reviewObjects.update');
      case 'delete':
        return t('sync.reviewObjects.delete');
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-(--sf-space-2)"
      data-testid="sync-review-objects"
    >
      <h3 id={headingId} className="text-xs font-medium text-text-primary">
        {t('sync.reviewObjects.title')}
      </h3>
      <ol className="flex flex-col gap-1 ps-5 list-decimal text-xs text-text-primary">
        {namesInOrder(entries, order).map((entry) => {
          const move = moved.get(entry.objectApiName);
          return (
            <li key={entry.objectApiName} data-testid={`sync-review-object-${entry.objectApiName}`}>
              <span className="font-medium">{entry.objectApiName}</span>
              {' — '}
              <span
                className={
                  entry.operation === 'delete' ? 'text-status-warning' : 'text-text-secondary'
                }
              >
                {operationWords(entry)}
              </span>
              {move && (
                <span className="block text-text-secondary">
                  {t('sync.reviewObjects.after', { parent: move.after, field: move.field })}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {(order?.cycles ?? []).map((cycle) => (
        <p
          key={cycle.join(',')}
          className="text-xs text-text-secondary"
          data-testid="sync-review-cycle"
        >
          {t('sync.reviewObjects.cycle', { objects: listWords(cycle, (key) => t(key)) })}
        </p>
      ))}
      {orderLoading && (
        <p className="text-xs text-text-secondary" role="status">
          {t('sync.reviewObjects.orderLoading')}
        </p>
      )}
      {orderUnread && !orderLoading && (
        <p className="text-xs text-text-secondary" data-testid="sync-review-order-unread">
          {t('sync.reviewObjects.orderUnread')}
        </p>
      )}
      {overwrites && (
        <p className="text-xs text-text-secondary" data-testid="sync-review-overwrites">
          {t('sync.reviewObjects.overwriteKept')}
        </p>
      )}
      {/* Review said nothing of them, and the run copied the masks. */}
      {encrypted.map(({ objectApiName, fields }) => (
        <p
          key={objectApiName}
          className="text-xs text-status-warning"
          data-testid={`sync-review-encrypted-${objectApiName}`}
        >
          {t('sync.reviewObjects.encrypted', { object: objectApiName, fields: fields.join(', ') })}
        </p>
      ))}
      {inserts && (
        <p
          className={saved ? 'text-xs text-text-secondary' : 'text-xs text-status-warning'}
          data-testid="sync-review-inserts"
        >
          {saved ? t('sync.reviewObjects.insertsSaved') : t('sync.reviewObjects.insertsUnsaved')}
        </p>
      )}
    </section>
  );
};
