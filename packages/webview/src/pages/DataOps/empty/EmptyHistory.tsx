import React, { useEffect, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AUDIT_TRAIL_LIMIT, type AuditLogEntry } from '@sandforge/shared';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { dateTimeFormat, formatNumber, formatStoredDate } from '../../../utils/formatters';
import { emptyHistoryOf, undoableRun, type EmptyHistoryEntry } from './emptyFacts';

/** What `reports:audit` answers, of what the history reads. */
interface AuditAnswer {
  entries: AuditLogEntry[];
}

/** How an act ended, as the history says it. */
const OUTCOME_KEYS: Readonly<Record<string, string>> = {
  success: 'dataopsEmpty.history.outcome.success',
  partial: 'dataopsEmpty.history.outcome.partial',
  failure: 'dataopsEmpty.history.outcome.failure',
  cancelled: 'dataopsEmpty.history.outcome.cancelled',
  stopped: 'dataopsEmpty.history.outcome.stopped',
};

/** Props for {@link EmptyHistory}. */
export interface EmptyHistoryProps {
  orgId: string;
  orgName: string;
  /** Changes whenever an act of the page ends: the history is read again then. */
  readAgainOn: unknown;
  /** Open the confirmation of the undo of `runId`. */
  onUndo: (runId: string) => void;
  /** Something of the emptying is under way: no act is offered meanwhile. */
  busy: boolean;
}

/**
 * The org's emptyings and their undos, the latest first, as this machine's
 * audit trail holds them: when, which act, how it ended, the records it
 * deleted or brought back and those the org refused. Undo is offered on the
 * org's last emptying while nothing says it was undone or deleted for good;
 * the extension answers for it, and says why when the recycle bin, or the
 * journal on this machine, no longer holds it.
 */
export const EmptyHistory: React.FC<EmptyHistoryProps> = ({
  orgId,
  orgName,
  readAgainOn,
  onUndo,
  busy,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const audit = useBridgeQuery<AuditAnswer>(
    'reports:audit',
    { module: 'dataops', orgId, limit: AUDIT_TRAIL_LIMIT },
    { responseType: 'reports:audit:response', errorType: 'reports:error' },
  );
  const readAgain = useLatestRef(() => audit.refetch());
  useEffect(() => {
    if (readAgainOn !== null && readAgainOn !== undefined) readAgain.current();
  }, [readAgainOn, readAgain]);
  const history = useMemo(() => emptyHistoryOf(audit.data?.entries ?? []), [audit.data]);
  const undoable = undoableRun(history);
  const when = (entry: EmptyHistoryEntry): string =>
    formatStoredDate(
      entry.at,
      dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format,
    ) ?? t('common.dateUnknown');

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 text-xs text-text-primary"
      data-testid="empty-history"
    >
      <h3 id={headingId} className="text-sm font-semibold text-text-primary">
        {t('dataopsEmpty.history.title', { org: orgName })}
      </h3>
      {audit.error && (
        <ErrorBanner
          message={audit.error}
          code={audit.errorCode}
          data-testid="empty-history-error"
        />
      )}
      {audit.loading && !audit.data && (
        <p role="status" className="text-text-secondary">
          {t('dataopsEmpty.history.loading')}
        </p>
      )}
      {audit.data && history.length === 0 && (
        <p className="text-text-secondary" data-testid="empty-history-none">
          {t('dataopsEmpty.history.none', { org: orgName })}
        </p>
      )}
      {history.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="empty-history-list">
          {history.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-subtle px-2 py-1"
              data-testid={`empty-history-${entry.id}`}
            >
              <span>{when(entry)}</span>
              <span className="font-medium">
                {entry.act === 'run'
                  ? entry.hard
                    ? t('dataopsEmpty.history.runHard')
                    : t('dataopsEmpty.history.run')
                  : t('dataopsEmpty.history.undo')}
              </span>
              <span>
                {OUTCOME_KEYS[entry.outcome] ? t(OUTCOME_KEYS[entry.outcome]) : entry.outcome}
              </span>
              <span>
                {entry.act === 'run'
                  ? t('dataopsEmpty.history.deleted', {
                      count: entry.records,
                      formatted: formatNumber(entry.records),
                    })
                  : t('dataopsEmpty.history.broughtBack', {
                      count: entry.records,
                      formatted: formatNumber(entry.records),
                    })}
                {entry.refused > 0 &&
                  `, ${t('dataopsEmpty.history.refused', { formatted: formatNumber(entry.refused) })}`}
              </span>
              {entry.code !== undefined && (
                <span className="font-mono text-text-secondary">{entry.code}</span>
              )}
              {entry.runId !== undefined && (
                <span className="font-mono text-text-secondary">{entry.runId}</span>
              )}
              {undoable?.id === entry.id && entry.runId !== undefined && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => entry.runId !== undefined && onUndo(entry.runId)}
                  disabled={busy}
                  data-testid="empty-history-undo"
                >
                  {t('dataopsEmpty.result.undo')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-text-secondary">{t('dataopsEmpty.history.where')}</p>
    </section>
  );
};
