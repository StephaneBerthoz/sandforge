import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncDeltaOutcome } from '@sandforge/shared';
import { formatStoredDate } from '../../utils/formatters';

/** Props for {@link SyncDeltaLine}. */
export interface SyncDeltaLineProps {
  /** How the object was read, and the deletions it carried. */
  delta: SyncDeltaOutcome;
  /** A simulation's line: deletions a run would carry, and no watermark. */
  simulated?: boolean;
  /** Test id of the line. */
  testId?: string;
}

/**
 * How one object of a delta configuration was read, as the results step and
 * the history detail say it: "Delta since <time> · 3 changed · 1 deleted", or
 * "Full read (first run)", then where the next run reads from. The times come
 * from the org's own clock and are shown as stored.
 */
export const SyncDeltaLine: React.FC<SyncDeltaLineProps> = ({ delta, simulated, testId }) => {
  const { t } = useTranslation();
  const time = (iso: string): string =>
    formatStoredDate(iso, 'yyyy-MM-dd HH:mm:ss') ?? t('common.dateUnknown');

  const parts: string[] = [];
  if (delta.read === 'delta') {
    parts.push(t('sync.delta.since', { time: time(delta.since ?? '') }));
  } else {
    parts.push(t(`sync.delta.full.${delta.reason ?? 'first_run'}`));
  }
  parts.push(t('sync.delta.changed', { count: delta.changed }));
  if (delta.deletionsChecked) {
    parts.push(
      simulated
        ? t('sync.delta.wouldDelete', { count: delta.deleted })
        : t('sync.delta.deleted', { count: delta.deleted }),
    );
  }

  // Where the next run reads from. A configuration that is not saved, or a
  // source without a stamp, keeps no watermark, and its reason says so.
  let next: string | null = null;
  if (!simulated) {
    if (delta.recorded) next = t('sync.delta.recorded', { time: time(delta.recorded) });
    else if (delta.reason === 'not_saved' || delta.reason === 'no_modstamp') next = null;
    else next = delta.read === 'delta' ? t('sync.delta.kept') : t('sync.delta.notRecorded');
  }

  return (
    <div className="flex flex-col gap-0.5 text-[10px]" data-testid={testId}>
      <p className="text-text-primary">{parts.join(' · ')}</p>
      {delta.deleteFailed > 0 && (
        <p className="text-status-error">
          {t('sync.delta.deleteFailed', { count: delta.deleteFailed })}
        </p>
      )}
      {delta.deletionError !== undefined && (
        <p className="text-status-error">{t('sync.delta.deletionsNotCarried')}</p>
      )}
      {next !== null && <p className="text-text-secondary">{next}</p>}
    </div>
  );
};
