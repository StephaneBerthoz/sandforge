import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SeedRunRemovalInfo } from '@sandforge/shared';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { SeedRunRemoval } from './SeedRunRemoval';

/** What a run's line says of its removal: whether it can still be taken back. */
function removalState(t: TFunction, run: SeedRunRemovalInfo): string {
  const removedOn = run.removed
    ? (formatStoredDate(run.removed.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'))
    : undefined;
  if (run.left.length === 0) {
    return removedOn !== undefined
      ? t('seed.removal.historyRemoved', { date: removedOn })
      : t('seed.removal.historyNothingLeft');
  }
  if (run.refusal) return t('seed.removal.historyRefused');
  return removedOn !== undefined
    ? t('seed.removal.historyPartlyRemoved', { date: removedOn })
    : t('seed.removal.historyRemovable');
}

/**
 * The seeds the extension kept, newest first, each saying whether it can still
 * be taken back, and opening onto its removal. What a seed from the panel
 * created was kept for the window's life only: once the window was reloaded,
 * nothing led back to a run, and its records stayed in the org. They are kept
 * on disk now, and listed here.
 */
export const SeedRunHistory: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const [open, setOpen] = useState<string | null>(null);
  const list = useBridgeQuery<{ runs: SeedRunRemovalInfo[] }>(
    'seed:removal:list',
    {},
    { errorType: 'seed:remove:error' },
  );
  const runs = list.data?.runs ?? [];
  if (runs.length === 0) return null;

  return (
    <Card className="border border-subtle bg-surface-1">
      <CardBody>
        <section
          className="flex flex-col gap-2"
          data-testid="seed-run-history"
          aria-label={t('seed.removal.historyTitle')}
        >
          <h2 className="text-sm font-semibold text-text-primary">
            {t('seed.removal.historyTitle')}
          </h2>
          <p className="text-[11px] text-text-secondary">{t('seed.removal.historyNote')}</p>
          <ul className="flex flex-col gap-2">
            {runs.map((run) => {
              const org = orgs.find((o) => o.id === run.targetOrgId)?.alias ?? run.targetOrgId;
              const date =
                formatStoredDate(run.endedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown');
              const shown = open === run.runId;
              return (
                <li
                  key={run.runId}
                  className="flex flex-col gap-1"
                  data-testid={`seed-run-history-${run.runId}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-text-primary">
                      {t('seed.removal.historyRun', {
                        date,
                        org,
                        count: run.created,
                        formatted: formatNumber(run.created),
                      })}
                    </span>
                    <span
                      className="text-text-secondary"
                      data-testid={`seed-run-history-state-${run.runId}`}
                    >
                      {removalState(t, run)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={shown}
                      onClick={() => setOpen(shown ? null : run.runId)}
                      data-testid={`seed-run-history-toggle-${run.runId}`}
                      className="text-[11px]"
                    >
                      {shown ? t('seed.removal.historyHide') : t('seed.removal.historyShow')}
                    </Button>
                  </div>
                  {shown && <SeedRunRemoval runId={run.runId} onAnswered={list.refetch} />}
                </li>
              );
            })}
          </ul>
        </section>
      </CardBody>
    </Card>
  );
};
