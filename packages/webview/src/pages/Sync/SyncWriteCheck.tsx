import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncWriteCheck as WriteCheck, SyncWriteOrder } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { formatNumber } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';

/** Megabytes as the run says them: rounded up, two decimals under 10 MB. */
function megabytes(value: number): string {
  if (value <= 0) return '0';
  const factor = value < 10 ? 100 : 10;
  return formatNumber(Math.ceil(value * factor - 1e-9) / factor);
}

/** Props for {@link SyncWriteCheckCard}. */
export interface SyncWriteCheckCardProps {
  /** What a run would be held to before its first write, as the simulation measured it. */
  check?: WriteCheck;
  /** Why the records could not be counted, when they could not. */
  unread?: string;
  /** The order the run writes the objects in. */
  order?: SyncWriteOrder;
}

/**
 * What a run would meet before its first write, in a simulation's results:
 * the order it writes the objects in, the records it writes, the data
 * storage they take and the emails the target's automation sends for them,
 * against what the target has left, and whether the run writes, asks first
 * or is refused — the checks Forge, Seed and Autopilot hold their runs to,
 * which Sync had none of.
 */
export const SyncWriteCheckCard: React.FC<SyncWriteCheckCardProps> = ({ check, unread, order }) => {
  const { t } = useTranslation();
  if (!check && unread === undefined && !order) return null;
  const limitWords = (limit: 'SingleEmail' | 'DailyWorkflowEmails'): string =>
    limit === 'SingleEmail' ? t('common.emailLimit.single') : t('common.emailLimit.workflow');

  const storageLine = (storage: WriteCheck['storage']): string => {
    const estimate = megabytes(storage.estimateMB);
    if (storage.verdict === 'unread') {
      return t('sync.writeCheck.storage.unread', { estimate, reason: storage.unread ?? '' });
    }
    const figures = {
      estimate,
      remaining: formatNumber(storage.remainingMB ?? 0),
      max: formatNumber(storage.maxMB ?? 0),
    };
    if (storage.verdict === 'exceeds') return t('sync.writeCheck.storage.exceeds', figures);
    if (storage.verdict === 'near') return t('sync.writeCheck.storage.near', figures);
    return t('sync.writeCheck.storage.fits', figures);
  };

  return (
    <Card data-testid="sync-write-check">
      <CardHeader title={t('sync.writeCheck.title')} />
      <CardBody>
        <div className="flex flex-col gap-1 text-xs text-text-primary">
          {order && order.objects.length > 1 && (
            <p data-testid="sync-write-check-order">
              {t('sync.writeCheck.order', { objects: listWords(order.objects, (key) => t(key)) })}
            </p>
          )}
          {order?.moved.map((move) => (
            <p key={move.objectApiName} className="text-text-secondary">
              {move.objectApiName}
              {' — '}
              {t('sync.reviewObjects.after', { parent: move.after, field: move.field })}
            </p>
          ))}
          {order?.cycles.map((cycle) => (
            <p key={cycle.join(',')} className="text-text-secondary">
              {t('sync.reviewObjects.cycle', { objects: listWords(cycle, (key) => t(key)) })}
            </p>
          ))}
          {unread !== undefined && (
            <p className="text-status-warning" data-testid="sync-write-check-unread">
              {t('sync.writeCheck.unread', { reason: unread })}
            </p>
          )}
          {check && (
            <>
              <p data-testid="sync-write-check-records">
                {t('sync.writeCheck.records', { count: check.total })}
                {check.objects.length > 0 &&
                  ` (${check.objects
                    .map(({ objectApiName, rows }) => `${objectApiName} ${formatNumber(rows)}`)
                    .join(', ')})`}
              </p>
              {check.alreadyCopied > 0 && (
                <p className="text-text-secondary">
                  {t('sync.writeCheck.alreadyCopied', { count: check.alreadyCopied })}
                </p>
              )}
              {(check.overwrites ?? 0) > 0 && (
                <p className="text-text-secondary" data-testid="sync-write-check-overwrites">
                  {t('sync.writeCheck.overwrites', { count: check.overwrites ?? 0 })}
                </p>
              )}
              {check.total > 0 && (
                <p
                  className={check.storage.verdict === 'fits' ? undefined : 'text-status-warning'}
                  data-testid="sync-write-check-storage"
                >
                  {storageLine(check.storage)}
                </p>
              )}
              {check.apiRequests && (
                <p
                  className={
                    check.apiRequests.verdict === 'fits' ? undefined : 'text-status-warning'
                  }
                  data-testid="sync-write-check-api"
                >
                  {check.apiRequests.verdict === 'unread'
                    ? t('sync.writeCheck.apiRequests.unread', {
                        estimate: formatNumber(check.apiRequests.estimate),
                        reason: check.apiRequests.unread ?? '',
                      })
                    : t(`sync.writeCheck.apiRequests.${check.apiRequests.verdict}`, {
                        estimate: formatNumber(check.apiRequests.estimate),
                        remaining: formatNumber(check.apiRequests.remaining ?? 0),
                        max: formatNumber(check.apiRequests.max ?? 0),
                      })}
                </p>
              )}
              {check.emails.map((email) => (
                <p
                  key={email.limit}
                  className={email.verdict === 'fits' ? undefined : 'text-status-warning'}
                  data-testid={`sync-write-check-emails-${email.limit}`}
                >
                  {email.verdict === 'unread'
                    ? t('sync.writeCheck.emails.unread', {
                        limit: limitWords(email.limit),
                        emails: formatNumber(email.emails),
                        reason: email.unread ?? '',
                      })
                    : t(
                        email.verdict === 'exceeds'
                          ? 'sync.writeCheck.emails.exceeds'
                          : 'sync.writeCheck.emails.fits',
                        {
                          limit: limitWords(email.limit),
                          emails: formatNumber(email.emails),
                          remaining: formatNumber(email.remaining ?? 0),
                          max: formatNumber(email.max ?? 0),
                        },
                      )}
                  {email.alertsCounted && ` ${t('sync.writeCheck.emails.alertsCounted')}`}
                </p>
              ))}
              {check.emailsUnread !== undefined && (
                <p className="text-text-secondary">
                  {t('sync.writeCheck.emailsUnread', { reason: check.emailsUnread })}
                </p>
              )}
              {(check.unwritable ?? []).map(({ objectApiName, rows, why }) => (
                <p
                  key={objectApiName}
                  className="text-status-warning"
                  data-testid={`sync-write-check-unwritable-${objectApiName}`}
                >
                  {t(`sync.writeCheck.unwritable.${why}`, {
                    object: objectApiName,
                    rows: formatNumber(rows),
                  })}
                </p>
              ))}
              {(check.unwritable ?? []).length > 0 && (
                <p className="text-text-secondary">{t('sync.writeCheck.unwritable.hint')}</p>
              )}
              {check.aboveRecords !== undefined && (
                <p className="text-text-secondary">
                  {t('sync.writeCheck.aboveRecords', {
                    threshold: formatNumber(check.aboveRecords),
                  })}
                </p>
              )}
              <p
                className={
                  check.verdict === 'refused'
                    ? 'font-medium text-status-error'
                    : check.verdict === 'asks'
                      ? 'font-medium text-status-warning'
                      : 'font-medium'
                }
                data-testid="sync-write-check-verdict"
              >
                {check.verdict === 'refused'
                  ? t('sync.writeCheck.verdict.refused')
                  : check.verdict === 'asks'
                    ? t('sync.writeCheck.verdict.asks')
                    : t('sync.writeCheck.verdict.writes')}
              </p>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
};

/** Props for {@link SyncAlreadyCopiedLine}. */
export interface SyncAlreadyCopiedLineProps {
  /** Records an earlier run of the configuration copied, left as they are. */
  count: number;
  /** Whether it is a simulation's: what a run would leave, not what it left. */
  simulated?: boolean;
  testId?: string;
}

/**
 * The records of an object an earlier run of a saved configuration copied,
 * which a run leaves as they are rather than inserting them a second time:
 * no refusal, said beside the object's other lines.
 */
export const SyncAlreadyCopiedLine: React.FC<SyncAlreadyCopiedLineProps> = ({
  count,
  simulated = false,
  testId,
}) => {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-text-secondary" data-testid={testId}>
      {simulated
        ? t('sync.simulation.alreadyCopied', { count })
        : t('sync.alreadyCopied', { count })}
    </p>
  );
};
