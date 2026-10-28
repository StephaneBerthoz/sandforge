import React, { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SeedRunRemovalInfo } from '@sandforge/shared';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useRewoundMarks } from '../../hooks/useRewoundMarks';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { PartBoundary } from '../../components/ui/PartBoundary';
import { RewoundMark } from '../../components/ui/RewoundMark';

/*
 * A seed's removal, loaded when a seed is opened onto it: with Forge's sweep
 * and the confirmation it asks for, it was parsed with the Seed page by every
 * panel that opened Seed, for a list most never open.
 */
const SeedRunRemoval = lazy(() =>
  import('./SeedRunRemoval').then((module) => ({ default: module.SeedRunRemoval })),
);

/*
 * A scenario's test file, written from its run later — once the org has an
 * agent —, loaded when a run is opened onto it.
 */
const ScenarioTestFile = lazy(() =>
  import('./Scenario/ScenarioTestFile').then((module) => ({ default: module.ScenarioTestFile })),
);

/** The name of the way a run was written, when not the generator: the Seed page's own cards. */
const ORIGIN_LABELS: Record<NonNullable<SeedRunRemovalInfo['origin']>, string> = {
  csv: 'seed.modeSelect.csv',
  clone: 'seed.modeSelect.clone',
};

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
  const navigate = useAppStore((s) => s.navigate);
  const [open, setOpen] = useState<string | null>(null);
  /** The scenario run opened onto its test file. */
  const [tests, setTests] = useState<string | null>(null);
  const list = useBridgeQuery<{ runs: SeedRunRemovalInfo[] }>(
    'seed:removal:list',
    {},
    { errorType: 'seed:remove:error' },
  );
  const runs = list.data?.runs ?? [];
  const markOf = useRewoundMarks(runs.length === 0);
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
              // A rewind that deleted what the run created left the line
              // offering a removal that found it all gone, unexplained.
              const mark = markOf({
                orgId: run.targetOrgId,
                startedAt: run.startedAt,
                ...(run.running || run.runningElsewhere ? {} : { endedAt: run.endedAt }),
                ...(run.objects ? { objects: run.objects } : {}),
              });
              return (
                <li
                  key={run.runId}
                  className="flex flex-col gap-1"
                  data-testid={`seed-run-history-${run.runId}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    {/* A CSV import and a clone are kept and taken back as a
                        seed is, and named by the way that wrote them. */}
                    {run.origin && (
                      <span
                        className="font-semibold text-text-primary"
                        data-testid={`seed-run-history-origin-${run.runId}`}
                      >
                        {t(ORIGIN_LABELS[run.origin])}
                      </span>
                    )}
                    <span className="text-text-primary">
                      {t('seed.removal.historyRun', {
                        date,
                        org,
                        count: run.created,
                        formatted: formatNumber(run.created),
                      })}
                    </span>
                    {/* A seed is kept as it writes: one whose window closed
                        under it lists what it wrote until then, and no end. */}
                    {run.unfinished && (
                      <span
                        className="text-status-warning"
                        data-testid={`seed-run-history-unfinished-${run.runId}`}
                      >
                        {t('seed.removal.historyUnfinished')}
                      </span>
                    )}
                    {/* Still writing in this window: it has no end because it
                        has not ended. Read as stopped, it was offered a
                        removal that deleted accounts while contacts were
                        still being inserted under them. */}
                    {/* Written by another window now: its process is alive.
                        Read as one that stopped, it was listed as partial,
                        and listing it aborted its Bulk API job mid-upload. */}
                    {run.runningElsewhere ? (
                      <span
                        className="text-text-secondary"
                        data-testid={`seed-run-history-elsewhere-${run.runId}`}
                      >
                        {t('seed.removal.historyRunningElsewhere')}
                      </span>
                    ) : run.running ? (
                      <>
                        <span
                          className="text-text-secondary"
                          data-testid={`seed-run-history-running-${run.runId}`}
                        >
                          {t('seed.removal.historyRunning')}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate('monitor')}
                          data-testid={`seed-run-history-live-${run.runId}`}
                          className="text-[11px]"
                        >
                          {t('seed.removal.historyOpenLiveOps')}
                        </Button>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                    {/* A scenario's run: its agent's test file is written
                        from here once the org has an agent. */}
                    {run.scenario && !run.running && !run.runningElsewhere && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={tests === run.runId}
                        onClick={() => setTests(tests === run.runId ? null : run.runId)}
                        data-testid={`seed-run-history-tests-${run.runId}`}
                        className="text-[11px]"
                      >
                        {t('seed.scenario.tests.title')}
                      </Button>
                    )}
                  </div>
                  {mark && (
                    <RewoundMark mark={mark} testId={`seed-run-history-rewound-${run.runId}`} />
                  )}
                  {shown && !run.running && !run.runningElsewhere && (
                    <PartBoundary data-testid="seed-removal-failed">
                      <Suspense fallback={<div aria-busy="true" />}>
                        <SeedRunRemoval runId={run.runId} onAnswered={list.refetch} />
                      </Suspense>
                    </PartBoundary>
                  )}
                  {run.scenario && tests === run.runId && (
                    <PartBoundary data-testid="seed-scenario-tests-failed">
                      <Suspense fallback={<div aria-busy="true" />}>
                        <ScenarioTestFile
                          runId={run.runId}
                          orgId={run.targetOrgId}
                          packId={run.scenario.packId}
                          stale={run.created > 0 && run.left.length === 0}
                        />
                      </Suspense>
                    </PartBoundary>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </CardBody>
    </Card>
  );
};
