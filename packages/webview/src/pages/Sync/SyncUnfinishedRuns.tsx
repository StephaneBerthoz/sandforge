import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncRunRemovalInfo } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { SyncRunRemoval } from './SyncRunRemoval';

/**
 * The runs whose creations are kept that no entry of the history holds: a
 * run a closed window stopped before it ended — the history keeps a run once
 * it ends — or one the history no longer lists. What they created stays
 * removable, from here. Nothing is shown while there are none.
 *
 * What a run created is kept as each call to the target answers; a call under
 * way when the window closed is named, since what it wrote is in the target
 * and not in the list. The note said everything a run created was kept, and
 * a removal of a run stopped during a Bulk API job left its rows in the
 * target without a word.
 *
 * A run another window is writing now is listed too, said as such and with
 * no removal: read as one a closed window left, it was offered a removal
 * that let what it went on to create stay in the target unoffered.
 */
export const SyncUnfinishedRuns: React.FC = () => {
  const { t } = useTranslation();
  const listed = useBridgeQuery<{ runs: SyncRunRemovalInfo[] }>('sync:removal:list', undefined, {
    errorType: 'sync:remove:error',
  });
  const runs = listed.data?.runs ?? [];
  if (runs.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="sync-unfinished-runs">
      <h3 className="text-sm font-semibold text-text-primary">
        {t('runRemoval.sync.unfinishedTitle')}
      </h3>
      <p className="text-[11px] text-text-secondary">{t('runRemoval.sync.unfinishedNote')}</p>
      {runs.map((run) => (
        <div key={run.runId} className="flex flex-col gap-1">
          <p className="text-[11px] text-text-primary" data-testid={`sync-unfinished-${run.runId}`}>
            {t('runRemoval.sync.unfinishedRun', {
              config: run.configName,
              date: formatStoredDate(run.startedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
            })}
          </p>
          {run.runningElsewhere && (
            <p
              className="text-[11px] text-text-secondary"
              data-testid={`sync-unfinished-elsewhere-${run.runId}`}
            >
              {t('runRemoval.sync.unfinishedElsewhere')}
            </p>
          )}
          {run.inFlight && !run.runningElsewhere && (
            <p
              className="text-[11px] text-status-warning"
              data-testid={`sync-unfinished-in-flight-${run.runId}`}
            >
              {t('runRemoval.sync.unfinishedInFlight', {
                count: run.inFlight.rows,
                formatted: formatNumber(run.inFlight.rows),
                object: run.inFlight.objectApiName,
              })}
            </p>
          )}
          {!run.runningElsewhere && (
            <SyncRunRemoval runId={run.runId} testId={`sync-unfinished-removal-${run.runId}`} />
          )}
        </div>
      ))}
    </section>
  );
};
