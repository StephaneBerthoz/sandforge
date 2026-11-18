import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PipelineHistoryEntry,
  PipelineOutsideRunner,
  PipelineTrigger,
  PipelineTriggerStatus,
} from '@sandforge/shared';
import { m } from 'framer-motion';
import { BentoGrid } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import type { KPICardVariant } from '../../components/ui/KPICard';
import { slideUp, staggerContainer } from '../../motion/presets';
import { formatTriggerTime } from './TriggerConfigPanel';
import type { TriggerSandbox } from './TriggerConfigPanel';
import { runnerBadgeWords } from './pipelineOutside';

/** What starts the pipeline next, as the extension says of its saved triggers. */
export type NextRun =
  | { kind: 'time'; at: string; timezone?: string }
  | { kind: 'refresh'; sandbox: string }
  | { kind: 'none' };

/**
 * The soonest start a schedule of the pipeline plans; else the sandbox whose
 * refresh starts it; else none. Read from what the extension says of the
 * pipeline as saved: a trigger that starts nothing plans nothing, and a time
 * that is no date is no start.
 */
export function nextRunOf(
  statuses: readonly PipelineTriggerStatus[],
  triggers: readonly PipelineTrigger[],
  sandboxes: readonly TriggerSandbox[],
): NextRun {
  let soonest: { at: string; ms: number; timezone?: string } | undefined;
  for (const status of statuses) {
    if (!status.armed || status.type !== 'schedule' || !status.nextRunAt) continue;
    const ms = Date.parse(status.nextRunAt);
    if (!Number.isFinite(ms)) continue;
    if (soonest === undefined || ms < soonest.ms) {
      soonest = {
        at: status.nextRunAt,
        ms,
        ...(status.timezone ? { timezone: status.timezone } : {}),
      };
    }
  }
  if (soonest) {
    return {
      kind: 'time',
      at: soonest.at,
      ...(soonest.timezone ? { timezone: soonest.timezone } : {}),
    };
  }
  for (const status of statuses) {
    if (!status.armed || status.type !== 'sandbox_refresh') continue;
    const orgId = triggers.find((trigger) => trigger.id === status.triggerId)?.config.orgId;
    const sandbox = sandboxes.find((candidate) => candidate.id === orgId);
    if (sandbox) return { kind: 'refresh', sandbox: sandbox.alias };
  }
  return { kind: 'none' };
}

/**
 * The latest run of the pipeline, by when it started: never another
 * pipeline's, and never a start a trigger missed, which ran nothing.
 */
export function lastRunOf(
  history: readonly PipelineHistoryEntry[],
  pipelineId: string,
): PipelineHistoryEntry | undefined {
  let latest: { entry: PipelineHistoryEntry; ms: number } | undefined;
  for (const entry of history) {
    if (entry.pipelineId !== pipelineId || entry.status === 'missed') continue;
    const ms = Date.parse(entry.startTime);
    const at = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    if (latest === undefined || at > latest.ms) latest = { entry, ms: at };
  }
  return latest?.entry;
}

/** The colour of the icon beside how the last run ended. */
const RUN_VARIANT: Partial<Record<PipelineHistoryEntry['status'], KPICardVariant>> = {
  completed: 'success',
  completed_with_warnings: 'warning',
  failed: 'error',
};

/** PipelineKpis props. */
export interface PipelineKpisProps {
  /** The pipeline open on the page. */
  pipelineId: string;
  /** What the extension says each of its saved triggers will do. */
  statuses: readonly PipelineTriggerStatus[];
  /** Its triggers as saved: a sandbox refresh trigger names its sandbox there. */
  triggers: readonly PipelineTrigger[];
  /** The registered sandboxes, by which a refresh trigger's sandbox is named. */
  sandboxes: readonly TriggerSandbox[];
  /** Every pipeline's runs, as History lists them. */
  history: readonly PipelineHistoryEntry[];
  /** Who starts it since its schedule was handed over at an export, if one does. */
  outsideRunner?: PipelineOutsideRunner;
}

/**
 * The two figures of the pipeline open: when it next starts, and how its last
 * run ended. The row counted its steps, which the header gives, its triggers,
 * and the runs of every pipeline: with none open, it read 0 / 0 / 1.
 */
export const PipelineKpis: React.FC<PipelineKpisProps> = ({
  pipelineId,
  statuses,
  triggers,
  sandboxes,
  history,
  outsideRunner,
}) => {
  const { t } = useTranslation();
  const next = nextRunOf(statuses, triggers, sandboxes);
  const last = lastRunOf(history, pipelineId);

  let nextValue: string;
  let nextSubtitle: string | undefined;
  if (next.kind === 'time') {
    nextValue = formatTriggerTime(next.at, next.timezone) ?? t('common.dateUnknown');
    nextSubtitle = next.timezone;
  } else if (next.kind === 'refresh') {
    nextValue = t('automation.kpi.onRefresh');
    nextSubtitle = next.sandbox;
  } else if (outsideRunner) {
    // Its schedule is off in VS Code: a launcher starts it, at times this
    // page does not know.
    nextValue = runnerBadgeWords(outsideRunner, t);
    nextSubtitle = t('automation.kpi.outside');
  } else {
    nextValue = t('automation.kpi.none');
    nextSubtitle = t('automation.kpi.noNextRun');
  }

  return (
    <m.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      data-testid="automation-kpi-row"
    >
      <BentoGrid columns={2} gap="md">
        <m.div variants={slideUp} data-testid="automation-kpi-next-run">
          <KPICard
            icon="clock"
            label={t('automation.kpi.nextRun')}
            value={nextValue}
            {...(nextSubtitle ? { subtitle: nextSubtitle } : {})}
          />
        </m.div>
        <m.div variants={slideUp} data-testid="automation-kpi-last-run">
          <KPICard
            icon="history"
            label={t('automation.kpi.lastRun')}
            value={last ? t(`automation.runStatuses.${last.status}`) : t('automation.kpi.noRunYet')}
            variant={last ? (RUN_VARIANT[last.status] ?? 'default') : 'default'}
            {...(last
              ? { subtitle: formatTriggerTime(last.startTime) ?? t('common.dateUnknown') }
              : {})}
          />
        </m.div>
      </BentoGrid>
    </m.div>
  );
};
