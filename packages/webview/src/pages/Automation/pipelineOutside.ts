import type { TFunction } from 'i18next';
import type {
  PipelineDefinition,
  PipelineOutsideRunner,
  PipelineRunsOutside,
} from '@sandforge/shared';
import { dateTimeFormat, formatStoredDate } from '../../utils/formatters';

/**
 * What the page says of a pipeline whose schedule was handed over to a
 * launcher at an export (`runsOutside`): who starts it and since when, how
 * its schedule comes back to VS Code, and what is left to remove then.
 */

/** When the hand-over was made, as the trigger panel writes a time; unknown for a value that is no date. */
function sinceWords(iso: string, t: TFunction): string {
  return (
    formatStoredDate(iso, (date) =>
      dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(date),
    ) ?? t('common.dateUnknown')
  );
}

/** What starts a pipeline whose schedule was handed over, as a sentence names it. */
export function runnerWords(runner: PipelineOutsideRunner, t: TFunction): string {
  switch (runner) {
    case 'cron':
      return t('automation.outside.runner.cron');
    case 'taskScheduler':
      return t('automation.outside.runner.taskScheduler');
    case 'githubActions':
      return t('automation.outside.runner.githubActions');
  }
}

/** What a schedule trigger a launcher took over is marked with: the scheduler's name alone. */
export function runnerBadgeWords(runner: PipelineOutsideRunner, t: TFunction): string {
  switch (runner) {
    case 'cron':
      return t('automation.outside.badge.cron');
    case 'taskScheduler':
      return t('automation.outside.badge.taskScheduler');
    case 'githubActions':
      return t('automation.outside.badge.githubActions');
  }
}

/** Who starts the pipeline since when, from which file: its schedule is off in VS Code. */
export function outsideSinceLine(outside: PipelineRunsOutside, t: TFunction): string {
  return t('automation.outside.since', {
    runner: runnerWords(outside.runner, t),
    time: sinceWords(outside.since, t),
    file: outside.file,
  });
}

/**
 * What is left to do once the schedule is given back: the launcher still
 * starts the pipeline until its line, its task or its workflow is removed.
 */
export function resumedLine(runner: PipelineOutsideRunner, t: TFunction): string {
  switch (runner) {
    case 'cron':
      return t('automation.outside.resumed.cron');
    case 'taskScheduler':
      return t('automation.outside.resumed.taskScheduler');
    case 'githubActions':
      return t('automation.outside.resumed.githubActions');
  }
}

/**
 * What History says of a pipeline a launcher starts: whose runs it lists. A
 * run on this machine is kept in the command line's history, which History
 * reads; a GitHub Actions run is kept on GitHub alone.
 */
export function historyOutsideLine(
  name: string,
  outside: PipelineRunsOutside,
  t: TFunction,
): string {
  const time = sinceWords(outside.since, t);
  const runner = runnerWords(outside.runner, t);
  return outside.runner === 'githubActions'
    ? t('automation.outside.historyElsewhere', { name, runner, time })
    : t('automation.outside.historyHere', { name, runner, time });
}

/**
 * The pipeline with its schedule given back to VS Code: each schedule trigger
 * that has a line on again, and the hand-over gone. An export of a pipeline
 * handed over carries the schedule triggers it switched off, so these are
 * the ones it handed over.
 */
export function resumedPipeline(pipeline: PipelineDefinition): PipelineDefinition {
  const resumed: PipelineDefinition = {
    ...pipeline,
    triggers: (pipeline.triggers ?? []).map((trigger) =>
      trigger.type === 'schedule' && (trigger.config.cron ?? '').trim() !== ''
        ? { ...trigger, enabled: true }
        : trigger,
    ),
    updatedAt: new Date().toISOString(),
  };
  delete resumed.runsOutside;
  return resumed;
}
