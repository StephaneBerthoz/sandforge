import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  PipelineDefinition,
  PipelineExport,
  PipelineExportOrg,
  PipelineExportRefusalCode,
  PipelineExportStep,
  PipelineExportVariable,
  PipelineFileNote,
  PipelineLauncher,
  PipelineOutsideRunner,
} from '@sandforge/shared';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { formatTriggerTime } from './TriggerConfigPanel';
import { stepTypeLabel } from './stepTypeLabel';
import { runnerWords } from './pipelineOutside';
import {
  usePipelineExport,
  baseNameOf,
  type ExportLauncherChoice,
  type ExportSaveProgress,
} from './usePipelineExport';

/** Props for {@link ExportPipelineDialog}. */
export interface ExportPipelineDialogProps {
  /** The pipeline as saved: what is exported, and what a hand-over saves again. */
  pipeline: PipelineDefinition;
  onClose: () => void;
  /** Its schedule was handed over to the launcher: the pipeline as saved then. */
  onHandedOver: (saved: PipelineDefinition) => void;
}

/** The launchers offered, in the order the dialog lists them. */
const LAUNCHER_CHOICES: readonly ExportLauncherChoice[] = [
  'none',
  'cron',
  'taskScheduler',
  'githubActions',
];

/** A refusal of the export, in the reader's language. */
function refusalWords(code: PipelineExportRefusalCode, t: TFunction): string {
  switch (code) {
    case 'NOT_SAVED':
      return t('automation.export.refused.NOT_SAVED');
    case 'ORG_UNKNOWN':
      return t('automation.export.refused.ORG_UNKNOWN');
    case 'SYNC_CONFIG_UNKNOWN':
      return t('automation.export.refused.SYNC_CONFIG_UNKNOWN');
    case 'SCHEDULES_MANY':
      return t('automation.export.refused.SCHEDULES_MANY');
    case 'FILE_INVALID':
      return t('automation.export.refused.FILE_INVALID');
    case 'VERSION_UNKNOWN':
      return t('automation.export.refused.VERSION_UNKNOWN');
  }
}

const FATE_VARIANT: Record<PipelineExportStep['fate'], BadgeVariant> = {
  runs: 'success',
  asks: 'warning',
  refused: 'error',
};

/** What a step's fate is called. */
function fateWords(fate: PipelineExportStep['fate'], t: TFunction): string {
  switch (fate) {
    case 'runs':
      return t('automation.export.steps.runs');
    case 'asks':
      return t('automation.export.steps.asks');
    case 'refused':
      return t('automation.export.steps.refused');
  }
}

/**
 * What a note of the export says of a step, in the reader's language: what
 * the run asks of a person or of its machine. A refusal is said apart, with
 * the run's own words; a note this page does not know is said as the export
 * wrote it.
 */
function stepNoteWords(
  code: string,
  step: PipelineExportStep,
  exported: PipelineExport,
  t: TFunction,
): string | undefined {
  switch (code) {
    case 'APPROVAL_NEEDS_PERSON':
      return t('automation.export.note.approval', { step: step.name });
    case 'STAGING_NEEDS_PERSON':
      return t('automation.export.note.staging');
    case 'REWIND_NEEDS_CONFIRMATION': {
      const org = exported.orgs.find((candidate) => candidate.writtenBy.includes(step.name));
      return t('automation.export.note.rewindConfirm', { alias: org?.alias ?? '<alias>' });
    }
    case 'REWIND_CHECKPOINT_ELSEWHERE':
      // A command is typed as it is, in every language: given apart, it is no
      // word of the sentence a translation names a checkpoint by.
      return t('automation.export.note.rewindCheckpoint', {
        command: 'sandforge checkpoint import',
      });
    case 'NOTIFICATION_PRINTED':
      return t('automation.export.note.notification');
    case 'STEP_REFUSED':
      return undefined;
    default:
      return exported.notes.find(
        (note: PipelineFileNote) => note.code === code && note.step === step.name,
      )?.text;
  }
}

/** How an org is named in the dialog: its alias, its own name, or its key in the file. */
function orgLabel(org: PipelineExportOrg): string {
  return org.alias ?? org.name ?? org.key;
}

/** What a kind of org is called. */
function orgKindWords(kind: PipelineExportOrg['kind'], t: TFunction): string {
  switch (kind) {
    case 'sandbox':
      return t('automation.export.orgs.kind.sandbox');
    case 'scratch':
      return t('automation.export.orgs.kind.scratch');
    case 'developer':
      return t('automation.export.orgs.kind.developer');
    case 'production':
      return t('automation.export.orgs.kind.production');
  }
}

/** What a launcher is called in the list of choices. */
export function launcherWords(choice: ExportLauncherChoice, t: TFunction): string {
  switch (choice) {
    case 'none':
      return t('automation.export.launcher.none');
    case 'cron':
      return t('automation.export.launcher.cron');
    case 'taskScheduler':
      return t('automation.export.launcher.taskScheduler');
    case 'githubActions':
      return t('automation.export.launcher.githubActions');
  }
}

/** What the launcher's schedule line is introduced by, by what reads it. */
function lineLead(runner: PipelineOutsideRunner, timezone: string, t: TFunction): string {
  switch (runner) {
    case 'cron':
      return t('automation.export.launcher.line.cron', { timezone });
    case 'taskScheduler':
      return t('automation.export.launcher.line.taskScheduler', { timezone });
    case 'githubActions':
      return t('automation.export.launcher.line.githubActions', { timezone });
  }
}

/** A command or a line of a launcher, as it is typed or copied. */
const Code: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <code
    className="block whitespace-pre-wrap break-all rounded-sm border border-subtle bg-surface-1 px-2 py-1 font-mono text-xs text-text-primary select-all"
    data-testid={testId}
  >
    {children}
  </code>
);

/** A section of the dialog, under its heading. */
const Section: React.FC<{ title: string; testId: string; children: React.ReactNode }> = ({
  title,
  testId,
  children,
}) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5" data-testid={testId}>
      <h3 id={headingId} className="text-xs font-semibold text-text-primary">
        {title}
      </h3>
      {children}
    </section>
  );
};

/** How the launcher chosen starts the pipeline on its schedule, and where it is saved. */
const LauncherFacts: React.FC<{ exported: PipelineExport; launcher: PipelineLauncher }> = ({
  exported,
  launcher,
}) => {
  const { t } = useTranslation();
  const schedule = launcher.schedule;
  return (
    <div
      className="flex flex-col gap-1.5 text-xs text-text-secondary"
      data-testid="export-launcher-facts"
    >
      <p>
        {launcher.runner === 'githubActions'
          ? t('automation.export.launcher.github', {
              launcher: launcher.fileName,
              file: exported.fileName,
            })
          : t('automation.export.launcher.beside', {
              launcher: launcher.fileName,
              file: exported.fileName,
            })}
      </p>
      {schedule === undefined && <p>{t('automation.export.launcher.noSchedule')}</p>}
      {schedule?.kind === 'line' && (
        <>
          <p>{lineLead(launcher.runner, schedule.timezone, t)}</p>
          <Code testId="export-launcher-line">{schedule.text}</Code>
          {schedule.offsetMinutes !== 0 && (
            <p>{t('automation.export.launcher.moved', { minutes: schedule.offsetMinutes })}</p>
          )}
          {schedule.offsetChanges.map((change) => {
            const time =
              formatTriggerTime(new Date(change.at).toISOString()) ?? t('common.dateUnknown');
            const drift = schedule.offsetMinutes - change.offsetMinutes;
            return (
              <p key={change.at} data-testid="export-launcher-drift">
                {drift === 0
                  ? t('automation.export.launcher.drift.back', { time })
                  : drift > 0
                    ? t('automation.export.launcher.drift.later', { time, minutes: drift })
                    : t('automation.export.launcher.drift.earlier', { time, minutes: -drift })}
              </p>
            );
          })}
        </>
      )}
      {schedule?.kind === 'manual' && (
        <p data-testid="export-launcher-manual">
          {t('automation.export.launcher.manual')}
          <span className="block font-mono">{schedule.reason}</span>
        </p>
      )}
      {schedule?.kind === 'refused' && (
        <p data-testid="export-launcher-refused">
          {t('automation.export.launcher.refused')}
          <span className="block font-mono">{schedule.reason}</span>
        </p>
      )}
    </div>
  );
};

/** What the saves did, or where they stopped and why: each file saved is named with its path. */
const SaveOutcome: React.FC<{ exported: PipelineExport; progress: ExportSaveProgress }> = ({
  exported,
  progress,
}) => {
  const { t } = useTranslation();
  const { stopped } = progress;
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary"
      data-testid="export-outcome"
    >
      {progress.phase === 'file' && <p>{t('automation.export.saving.file')}</p>}
      {progress.phase === 'launcher' && <p>{t('automation.export.saving.launcher')}</p>}
      {progress.phase === 'handOver' && <p>{t('automation.export.saving.handOver')}</p>}
      {progress.filePath && (
        <p data-testid="export-saved-file">
          {t('automation.export.saved.file', { path: progress.filePath })}
        </p>
      )}
      {progress.launcherPath && (
        <p data-testid="export-saved-launcher">
          {t('automation.export.saved.launcher', { path: progress.launcherPath })}
        </p>
      )}
      {progress.phase === 'done' && progress.handedOver && (
        <p data-testid="export-handed-over">
          {t('automation.export.saved.handedOver', {
            runner: runnerWords(progress.handedOver.runner, t),
          })}
        </p>
      )}
      {progress.withheld === 'renamed' && progress.filePath && (
        <p data-testid="export-withheld">
          {t('automation.export.saved.withheld.renamed', {
            name: baseNameOf(progress.filePath),
            file: exported.fileName,
          })}
        </p>
      )}
      {progress.withheld === 'apart' && (
        <p data-testid="export-withheld">{t('automation.export.saved.withheld.apart')}</p>
      )}
      {stopped?.reason === 'cancelled' && (
        <p data-testid="export-stopped">
          {stopped.at === 'file'
            ? t('automation.export.stopped.cancelledFile')
            : t('automation.export.stopped.cancelledLauncher')}
        </p>
      )}
      {stopped?.reason === 'error' && (
        <p data-testid="export-stopped">
          {stopped.at === 'file'
            ? t('automation.export.stopped.errorFile')
            : stopped.at === 'launcher'
              ? t('automation.export.stopped.errorLauncher')
              : t('automation.export.stopped.errorHandOver')}
          {stopped.message && <span className="block font-mono">{stopped.message}</span>}
        </p>
      )}
    </div>
  );
};

/** The body of a pipeline exported: what each step, org and variable does with VS Code closed. */
const Exported: React.FC<{
  exported: PipelineExport;
  launcher: ExportLauncherChoice;
  onLauncher: (choice: ExportLauncherChoice) => void;
  handOver: boolean;
  onHandOver: (handOver: boolean) => void;
  handOverOffered: boolean;
  locked: boolean;
}> = ({ exported, launcher, onLauncher, handOver, onHandOver, handOverOffered, locked }) => {
  const { t } = useTranslation();
  const radioName = useId();
  const chosen = launcher === 'none' ? undefined : exported.launchers[launcher];
  return (
    <div className="flex flex-col gap-4 text-xs text-text-primary">
      {exported.problems.length > 0 && (
        <div
          role="note"
          className="flex flex-col gap-1 rounded-lg border border-dashed border-subtle bg-surface-1 px-3 py-2"
          data-testid="export-problems"
        >
          <p className="font-semibold">{t('automation.export.problems')}</p>
          <ul className="flex flex-col gap-0.5 font-mono text-text-secondary">
            {exported.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <Section title={t('automation.export.steps.heading')} testId="export-steps">
        <ul className="flex flex-col gap-1.5">
          {exported.steps.map((step) => (
            <li
              key={step.stepId}
              className="flex flex-col gap-0.5"
              data-testid={`export-step-${step.stepId}`}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{step.name}</span>
                <span className="text-text-secondary">({stepTypeLabel(step.type, t)})</span>
                <Badge variant={FATE_VARIANT[step.fate]}>{fateWords(step.fate, t)}</Badge>
              </span>
              {step.fate === 'refused' && step.refusal && (
                <span className="text-text-secondary">
                  {t('automation.export.steps.refusedWhy')}
                  <span className="block font-mono">{step.refusal}</span>
                </span>
              )}
              {step.notes.map((code) => {
                const words = stepNoteWords(code, step, exported, t);
                return words ? (
                  <span key={code} className="text-text-secondary">
                    {words}
                  </span>
                ) : null;
              })}
            </li>
          ))}
        </ul>
      </Section>

      {exported.orgs.length > 0 && (
        <Section title={t('automation.export.orgs.heading')} testId="export-orgs">
          <ul className="flex flex-col gap-1.5">
            {exported.orgs.map((org) => (
              <li
                key={org.key}
                className="flex flex-col gap-0.5"
                data-testid={`export-org-${org.key}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{orgLabel(org)}</span>
                  <span className="text-text-secondary">{orgKindWords(org.kind, t)}</span>
                  {org.staging && (
                    <Badge variant="warning">{t('automation.export.orgs.staging')}</Badge>
                  )}
                </span>
                {org.writtenBy.length > 0 && (
                  <span className="text-text-secondary">
                    {t('automation.export.orgs.writtenBy', { steps: org.writtenBy.join(', ') })}
                  </span>
                )}
                {org.readBy.length > 0 && (
                  <span className="text-text-secondary">
                    {t('automation.export.orgs.readBy', { steps: org.readBy.join(', ') })}
                  </span>
                )}
                {org.alias === undefined && (
                  <>
                    <span className="text-text-secondary">
                      {t('automation.export.orgs.noAlias')}
                    </span>
                    <Code>{`sf alias set <alias>=<username>\n--org ${org.key}=<alias>`}</Code>
                  </>
                )}
                {org.cliHolds ? (
                  <span className="text-text-secondary">{t('automation.export.orgs.held')}</span>
                ) : (
                  <>
                    <span className="text-text-secondary">
                      {t('automation.export.orgs.notHeld')}
                    </span>
                    <Code testId={`export-org-login-${org.key}`}>
                      {`sf org login web --alias ${org.alias ?? '<alias>'}${
                        org.kind === 'sandbox' ? ' --instance-url https://test.salesforce.com' : ''
                      }`}
                    </Code>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {exported.variables.length > 0 && (
        <Section title={t('automation.export.variables.heading')} testId="export-variables">
          <ul className="flex flex-col gap-1.5">
            {exported.variables.map((variable: PipelineExportVariable) => (
              <li
                key={variable.name}
                className="flex flex-col gap-0.5"
                data-testid={`export-variable-${variable.name}`}
              >
                <span className="font-medium">{variable.name}</span>
                <span className="text-text-secondary">
                  {variable.type === 'secret'
                    ? t('automation.export.variables.secret')
                    : variable.env !== undefined
                      ? t('automation.export.variables.fromEnv')
                      : variable.valued
                        ? t('automation.export.variables.valued')
                        : t('automation.export.variables.noValue')}
                </span>
                {variable.env !== undefined && (
                  <Code>{`--var-env ${variable.name}=${variable.env}`}</Code>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <fieldset className="flex flex-col gap-1.5" data-testid="export-launchers" disabled={locked}>
        <legend className="mb-1 text-xs font-semibold text-text-primary">
          {t('automation.export.launcher.heading')}
        </legend>
        {LAUNCHER_CHOICES.map((choice) => (
          <label key={choice} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={radioName}
              value={choice}
              checked={launcher === choice}
              onChange={() => onLauncher(choice)}
              data-testid={`export-launcher-${choice}`}
            />
            <span>{launcherWords(choice, t)}</span>
          </label>
        ))}
      </fieldset>
      {chosen && <LauncherFacts exported={exported} launcher={chosen} />}
      {handOverOffered && (
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={handOver}
            disabled={locked}
            onChange={(event) => onHandOver(event.target.checked)}
            data-testid="export-hand-over"
          />
          <span className="flex flex-col gap-0.5">
            <span>{t('automation.export.handOver.label')}</span>
            <span className="text-text-secondary">{t('automation.export.handOver.help')}</span>
          </span>
        </label>
      )}

      <Section title={t('automation.export.locks.heading')} testId="export-locks">
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-text-secondary">
          <li>{t('automation.export.locks.same')}</li>
          <li>{t('automation.export.locks.writes')}</li>
          <li>{t('automation.export.locks.masking')}</li>
          <li>{t('automation.export.locks.elsewhere')}</li>
        </ul>
      </Section>
    </div>
  );
};

/**
 * Export… on the Automation page: the saved pipeline as a pipeline file, and
 * a launcher that runs it with npx sandforge while VS Code is closed.
 *
 * Before anything is saved it says, for that file, what each step does where
 * no VS Code window is — runs as here, asks something of a person or of the
 * machine, or is refused with the words the run would use —, which orgs it
 * reads and writes and whether the Salesforce CLI here holds them, which
 * variables the file leaves out, and what the run lock does not hold off.
 * The file is saved first, then the launcher chosen beside it; then, when the
 * person leaves the box ticked, the pipeline is saved with its schedule off
 * here, so that the editor and the launcher do not both start it. A Save
 * dialog closed, or a save refused, stops there, says so, and saves nothing
 * after it.
 */
export const ExportPipelineDialog: React.FC<ExportPipelineDialogProps> = ({
  pipeline,
  onClose,
  onHandedOver,
}) => {
  const { t } = useTranslation();
  const { outcome, error, save, progress } = usePipelineExport(pipeline, onHandedOver);
  const [launcher, setLauncher] = useState<ExportLauncherChoice>('none');
  const [handOver, setHandOver] = useState(false);

  const exported = outcome?.exported ? outcome : undefined;
  const chosen = exported && launcher !== 'none' ? exported.launchers[launcher] : undefined;
  // Only for a launcher that starts the pipeline on its schedule by itself: a
  // line it runs on, or a task a person creates. One whose scheduler has no
  // line for the schedule starts nothing, and VS Code keeps it.
  const handOverOffered =
    exported !== undefined &&
    exported.schedule !== null &&
    chosen?.schedule !== undefined &&
    chosen.schedule.kind !== 'refused';
  const busy =
    progress.phase === 'file' || progress.phase === 'launcher' || progress.phase === 'handOver';
  const finished = progress.phase === 'done';

  const chooseLauncher = (choice: ExportLauncherChoice): void => {
    setLauncher(choice);
    // Ticked as a launcher that starts on the schedule is chosen: two
    // schedulers starting one pipeline is what it is there to prevent.
    if (exported === undefined) return;
    const schedule = choice === 'none' ? undefined : exported.launchers[choice].schedule;
    setHandOver(
      exported.schedule !== null && schedule !== undefined && schedule.kind !== 'refused',
    );
  };

  let body: React.ReactNode;
  if (error) {
    body = (
      <p role="alert" className="text-xs text-status-error" data-testid="export-error">
        {t('automation.export.failed', { reason: error })}
      </p>
    );
  } else if (outcome === null) {
    body = (
      <p role="status" className="text-xs text-text-secondary" data-testid="export-reading">
        {t('automation.export.reading')}
      </p>
    );
  } else if (!outcome.exported) {
    body = (
      <div
        role="alert"
        className="flex flex-col gap-1 text-xs text-text-primary"
        data-testid="export-refused"
      >
        <p>{refusalWords(outcome.code, t)}</p>
        <p className="font-mono text-text-secondary">{outcome.message}</p>
        {outcome.issues && outcome.issues.length > 0 && (
          <ul className="flex flex-col gap-0.5 font-mono text-text-secondary">
            {outcome.issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <Exported
          exported={outcome}
          launcher={launcher}
          onLauncher={chooseLauncher}
          handOver={handOver}
          onHandOver={setHandOver}
          handOverOffered={handOverOffered}
          locked={busy || finished}
        />
        {progress.phase !== 'idle' && <SaveOutcome exported={outcome} progress={progress} />}
      </div>
    );
  }

  const footer = (
    <>
      <Button variant="secondary" size="sm" onClick={onClose} data-testid="export-close">
        {finished ? t('common.close') : t('common.cancel')}
      </Button>
      {exported && !finished && (
        <Button
          variant="primary"
          size="sm"
          onClick={() => save({ launcher, handOver: handOverOffered && handOver })}
          loading={busy}
          disabled={busy}
          data-testid="export-save"
        >
          {launcher === 'none'
            ? t('automation.export.saveFile')
            : t('automation.export.saveFileAndLauncher')}
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('automation.export.title', { name: pipeline.name })}
      description={t('automation.export.description')}
      footer={footer}
      className="max-w-2xl max-h-[90vh] overflow-y-auto"
    >
      <div data-testid="export-dialog">{body}</div>
    </Dialog>
  );
};
