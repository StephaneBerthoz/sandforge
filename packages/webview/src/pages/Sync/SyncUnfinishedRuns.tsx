import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncRunRemovalInfo } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { formatStoredDate } from '../../utils/formatters';
import { SyncRunRemoval } from './SyncRunRemoval';

/**
 * The runs whose creations are kept that no entry of the history holds: a
 * run a closed window stopped before it ended — the history keeps a run once
 * it ends — or one the history no longer lists. What they created stays
 * removable, from here. Nothing is shown while there are none.
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
        {t('sync.removal.unfinishedTitle')}
      </h3>
      <p className="text-[11px] text-text-secondary">{t('sync.removal.unfinishedNote')}</p>
      {runs.map((run) => (
        <div key={run.runId} className="flex flex-col gap-1">
          <p className="text-[11px] text-text-primary" data-testid={`sync-unfinished-${run.runId}`}>
            {t('sync.removal.unfinishedRun', {
              config: run.configName,
              date: formatStoredDate(run.startedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
            })}
          </p>
          <SyncRunRemoval runId={run.runId} testId={`sync-unfinished-removal-${run.runId}`} />
        </div>
      ))}
    </section>
  );
};
