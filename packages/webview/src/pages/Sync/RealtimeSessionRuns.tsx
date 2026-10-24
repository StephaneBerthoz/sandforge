import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncRunRemovalInfo } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useCDCLiveStore, type CDCConnectionStatus } from '../../stores/useCDCLiveStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { SyncRunRemoval } from './SyncRunRemoval';

/** The states of a session that is still writing, or trying to. */
const WRITING: ReadonlySet<CDCConnectionStatus> = new Set(['connecting', 'syncing', 'paused']);

/**
 * The sessions of the Real-Time tab that wrote into their target, each with
 * what it created, wrote over and deleted, and its removal — the Sync run's
 * removal card, since a session is kept as a run is, from its first write to
 * its stop. A session still writing is listed once it has stopped: read
 * again as the tab hears it stop. Nothing is shown while there are none.
 *
 * A session kept nothing it wrote, and the tab said so: the records it
 * created, the values it wrote over and the records it deleted stayed so
 * once it stopped, whatever the user had meant to try.
 */
export const RealtimeSessionRuns: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const status = useCDCLiveStore((s) => s.status);
  const listed = useBridgeQuery<{ runs: SyncRunRemovalInfo[] }>(
    'sync:removal:list',
    { realtime: true },
    { errorType: 'sync:remove:error' },
  );
  const { refetch } = listed;
  const before = useRef(status);
  useEffect(() => {
    const was = before.current;
    before.current = status;
    if (WRITING.has(was) && !WRITING.has(status)) refetch();
  }, [status, refetch]);

  const runs = listed.data?.runs ?? [];
  if (runs.length === 0) return null;
  const nameOf = (orgId: string): string => orgs.find((o) => o.id === orgId)?.alias ?? orgId;
  const dateOf = (at: string): string =>
    formatStoredDate(at, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown');
  return (
    <section className="flex flex-col gap-2" data-testid="realtime-sessions">
      <h3 className="text-sm font-semibold text-text-primary">
        {t('runRemoval.sync.sessionsTitle')}
      </h3>
      <p className="text-[11px] text-text-secondary">{t('runRemoval.sync.sessionsNote')}</p>
      {runs.map((run) => {
        const orgsOf = { source: nameOf(run.sourceOrgId), target: nameOf(run.targetOrgId) };
        return (
          <div key={run.runId} className="flex flex-col gap-1">
            <p
              className="text-[11px] text-text-primary"
              data-testid={`realtime-session-${run.runId}`}
            >
              {run.endedAt !== undefined
                ? t('runRemoval.sync.sessionRun', {
                    ...orgsOf,
                    started: dateOf(run.startedAt),
                    ended: dateOf(run.endedAt),
                  })
                : t('runRemoval.sync.sessionRunCut', { ...orgsOf, started: dateOf(run.startedAt) })}
            </p>
            {run.runningElsewhere && (
              <p
                className="text-[11px] text-text-secondary"
                data-testid={`realtime-session-elsewhere-${run.runId}`}
              >
                {t('runRemoval.sync.sessionElsewhere')}
              </p>
            )}
            {run.inFlight && !run.runningElsewhere && (
              <p
                className="text-[11px] text-status-warning"
                data-testid={`realtime-session-in-flight-${run.runId}`}
              >
                {t('runRemoval.sync.unfinishedInFlight', {
                  count: run.inFlight.rows,
                  formatted: formatNumber(run.inFlight.rows),
                  object: run.inFlight.objectApiName,
                })}
              </p>
            )}
            {!run.runningElsewhere && (
              <SyncRunRemoval runId={run.runId} testId={`realtime-session-removal-${run.runId}`} />
            )}
          </div>
        );
      })}
    </section>
  );
};
