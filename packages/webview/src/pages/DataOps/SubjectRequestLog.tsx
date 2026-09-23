import React, { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubjectRequestEvent, SubjectRequestLogEntry } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useFileSave } from '../../hooks/useFileSave';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { dateTimeFormat, formatNumber } from '../../utils/formatters';

/** Props for {@link SubjectRequestLog}. */
export interface SubjectRequestLogProps {
  /** The org whose requests are shown. */
  orgId: string;
  /** Changes when the log has something new, so the list is asked for again. */
  version: number;
}

/** When something happened, in the language picked in SandForge. */
function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * The local log of the subject requests handled on an org: when each was
 * opened, what its searches found, when it was exported and how it was
 * erased — counts and object names only. It can be saved as a file, which
 * holds no personal data either.
 */
export const SubjectRequestLog: React.FC<SubjectRequestLogProps> = ({ orgId, version }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const { save, saving } = useFileSave();
  const logQuery = useBridgeQuery<{ entries: SubjectRequestLogEntry[] }>(
    'dataops:dsr:log',
    undefined,
    {
      responseType: 'dataops:dsr:log:response',
      errorType: 'dataops:error',
    },
  );
  const refetch = logQuery.refetch;
  useEffect(() => {
    if (version > 0) refetch();
  }, [version, refetch]);

  const entries = (logQuery.data?.entries ?? []).filter((e) => e.orgId === orgId);
  const number = (n: number): string => formatNumber(n);

  const describe = (event: SubjectRequestEvent): string => {
    switch (event.kind) {
      case 'searched': {
        const found = event.objects.reduce((sum, o) => sum + o.found, 0);
        return t('dataops.dsrLog.searched', {
          at: when(event.at),
          by: event.searchedBy.map((kind) => t(`dataops.dsrLog.by.${kind}`)).join(', '),
          count: found,
          formatted: number(found),
          objects: event.objects.map((o) => o.objectApiName).join(', '),
        });
      }
      case 'exported':
        return t('dataops.dsrLog.exported', {
          at: when(event.at),
          count: event.records,
          formatted: number(event.records),
        });
      default: {
        const done = event.objects.reduce((sum, o) => sum + o.done, 0);
        const failed = event.objects.reduce((sum, o) => sum + o.failed, 0);
        return t(event.mode === 'delete' ? 'dataops.dsrLog.deleted' : 'dataops.dsrLog.anonymized', {
          at: when(event.at),
          outcome: t(`dataops.dsrLog.outcome.${event.outcome}`),
          count: done,
          formatted: number(done),
          failed: number(failed),
        });
      }
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-[var(--sf-border)] p-3"
      data-testid="dsr-log"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-text-primary">
          {t('dataops.dsrLog.title')}
        </h2>
        {entries.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            loading={saving}
            onClick={() =>
              save(
                `sandforge-subject-request-log-${new Date().toISOString().slice(0, 10)}.json`,
                JSON.stringify({ sandforgeSubjectRequestLogVersion: 1, orgId, entries }, null, 2),
                ['json'],
              )
            }
            data-testid="dsr-log-save-btn"
          >
            {t('dataops.dsrLog.save')}
          </Button>
        )}
      </div>
      <p className="text-xs text-text-secondary">{t('dataops.dsrLog.intro')}</p>
      {logQuery.error && <ErrorBanner message={logQuery.error} data-testid="dsr-log-error" />}
      {entries.length === 0 ? (
        <p className="text-xs text-text-secondary" data-testid="dsr-log-empty">
          {t('dataops.dsrLog.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-2" data-testid="dsr-log-entries">
          {entries.map((entry) => (
            <li
              key={entry.requestId}
              className="flex flex-col gap-0.5 text-xs"
              data-testid={`dsr-log-${entry.requestId.slice(0, 8)}`}
            >
              <span className="font-medium text-text-primary">
                {t('dataops.dsrLog.entry', {
                  id: entry.requestId.slice(0, 8),
                  at: when(entry.openedAt),
                })}
              </span>
              <ul className="flex flex-col gap-0.5 pl-3 text-text-secondary">
                {entry.events.map((event, index) => (
                  <li key={`${event.kind}-${index}`}>{describe(event)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
