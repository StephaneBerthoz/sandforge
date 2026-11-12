import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import {
  formatDurationSec,
  formatFileSize,
  isDevelopmentOrg,
  type RunCheckpointEstimate,
  type RunCheckpointObjectNote,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { cn } from '../../theme';
import { formatNumber } from '../../utils/formatters';
import { checkpointRefusalWords } from '../../utils/runCheckpoint';
import { runNoteWords } from '../../utils/checkpointNotes';
import { namedObjects } from './RewindBeforeRun';

/** Props for {@link CheckpointFirstEstimate}. */
export interface CheckpointFirstEstimateProps {
  estimate: RunCheckpointEstimate;
  /** What the estimate is of, said before it: the last simulation, the preview, a dry run. */
  lead: string;
  testId: string;
  className?: string;
}

/**
 * The objects of a list of notes, one a line, each with why, in the page's
 * language: Forge's and Sync's panels said it in the extension's English.
 */
const NoteList: React.FC<{
  title: string;
  notes: RunCheckpointObjectNote[];
  /** Which list the notes are of: a code may mean an object added or one left out. */
  list: 'added' | 'notHeld';
  testId: string;
}> = ({ title, notes, list, testId }) => {
  const { t } = useTranslation();
  if (notes.length === 0) return null;
  return (
    <div data-testid={testId}>
      <p>{title}</p>
      <ul className="ml-3 flex list-disc flex-col gap-0.5">
        {notes.map((note) => (
          <li key={note.objectApiName} data-testid={`${testId}-${note.objectApiName}`}>
            <span className="font-mono">{note.objectApiName}</span>
            <span className="text-text-secondary">{` · ${runNoteWords(t, note, list)}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * What a checkpoint taken before a run would hold and cost, read before
 * anything is taken — the take's estimate of its records, requests, time and
 * bytes on this machine, how long it would be kept, the objects added for
 * what the target's flows still running create and those left out — and the
 * refusal a real run would meet, which refuses the run before its first
 * write. A simulation's result, the option the run is set up with, and a
 * load's preview show it alike.
 */
export const CheckpointFirstEstimate: React.FC<CheckpointFirstEstimateProps> = ({
  estimate,
  lead,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const { records, apiRequests, seconds, bytes } = estimate.estimate;
  const cost = {
    records: formatNumber(records),
    objects: namedObjects(estimate.objects, t),
    requests: formatNumber(apiRequests),
    // The seconds the run's question says, to the same figure.
    time: formatDurationSec(seconds),
    size: formatFileSize(bytes),
    count: estimate.keepDays,
    days: formatNumber(estimate.keepDays),
  };
  return (
    <div data-testid={testId} className={cn('flex flex-col gap-1', className)}>
      <p data-testid={`${testId}-cost`}>
        {lead}{' '}
        {estimate.keepDays > 0
          ? t('runResults.checkpoint.estimate.cost', cost)
          : t('runResults.checkpoint.estimate.costKept', cost)}
      </p>
      <NoteList
        title={t('runResults.checkpoint.estimate.added')}
        notes={estimate.added}
        list="added"
        testId={`${testId}-added`}
      />
      <NoteList
        title={t('runResults.checkpoint.notHeldTitle')}
        notes={estimate.notHeld}
        list="notHeld"
        testId={`${testId}-not-held`}
      />
      {estimate.refusal && (
        <p role="alert" data-testid={`${testId}-refusal`} className="text-status-warning">
          {t('runResults.checkpoint.estimate.wouldRefuse', {
            reason: checkpointRefusalWords(estimate.refusal.code, t),
          })}
        </p>
      )}
    </div>
  );
};

/**
 * Where a run says the cost of its checkpoint before it takes it: in the
 * question before its first write (Autopilot), in a simulation as well
 * (Forge), or in its preview alone (Frozen Dataset, whose load asks nothing
 * of its own).
 */
export type CheckpointCostSaid = 'question' | 'simulation' | 'preview';

const COST_SAID_KEYS: Readonly<Record<CheckpointCostSaid, string>> = {
  question: 'runResults.checkpoint.option.costAtQuestion',
  simulation: 'runResults.checkpoint.option.costAtSimulation',
  preview: 'runResults.checkpoint.option.costAtPreview',
};

/** The setting that says how long it is kept, named as Settings names it, in no language. */
const KEEP_DAYS_SETTING = 'sandforge.checkpoint.beforeRunKeepDays';

/** Props for {@link CheckpointFirstOption}. */
export interface CheckpointFirstOptionProps {
  /** Whether the run takes the checkpoint first: off unless ticked. */
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The org the run writes to, by its id in this machine's registry: no option before one is picked and known. */
  orgId: string | undefined;
  /** Where the run says its cost before it takes it. */
  costSaid: CheckpointCostSaid;
  /**
   * What the checkpoint would hold and cost, once read — the last
   * simulation's, the preview's —, with what that reading was; absent before.
   */
  estimate?: { of: RunCheckpointEstimate; lead: string } | null;
  /**
   * Said beside the box while it is unticked: the run has no removal, and the
   * checkpoint is the only way to take it back (Autopilot).
   */
  recommendation?: string;
  /**
   * Keep what it holds and its estimate in view, and the rest behind a
   * disclosure: in Forge's column of the run, five paragraphs pushed everything
   * else out of it. A screen reader hears with the box what is in view and
   * what the fold holds, from a hidden copy of it: Chromium describes a box by
   * nothing a closed disclosure holds, and the box was described without what
   * the checkpoint never holds, where it is kept and what refuses the run.
   */
  foldDetails?: boolean;
  /** Test id of the option; its checkbox takes `-toggle`. */
  testId: string;
  className?: string;
}

/**
 * Checkpoint first: the option to take a checkpoint of what the run writes
 * before its first write, to rewind the run to. Off unless ticked — it reads
 * whole tables of the target, not the run's rows, and keeps their values on
 * this machine —, it says what it holds, what it never holds — Chatter,
 * Knowledge versions, setup, and what an Apex trigger or a flow SandForge
 * could not read creates, which no checkpoint scope can name —, how long it
 * keeps it, and where its cost is said before anything is taken. A take
 * refused refuses the run, nothing written.
 *
 * Not offered on a target the registry does not call a sandbox, a scratch
 * org or a Developer Edition: the take would be refused there, and the box
 * is unticked and says why. A box ticked for one target and left for such
 * another is unticked: a run sent from a page that offered none takes none.
 */
export const CheckpointFirstOption: React.FC<CheckpointFirstOptionProps> = ({
  checked,
  onChange,
  orgId,
  costSaid,
  estimate,
  recommendation,
  foldDetails = false,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const detailsId = useId();
  const foldedId = useId();
  const [open, setOpen] = useState(false);
  const org = useOrgStore((s) => s.orgs.find((candidate) => candidate.id === orgId));
  const offered = org !== undefined && isDevelopmentOrg(org);
  useEffect(() => {
    if (!offered && checked) onChange(false);
  }, [offered, checked, onChange]);
  if (org === undefined) return null;
  const name = org.alias || org.username;
  /** One paragraph of the details, with its test id, or without for the copy that describes the box. */
  const line = (part: string, text: string, ids = true): React.ReactNode => (
    <p data-testid={ids ? `${testId}-${part}` : undefined} className="text-text-secondary">
      {text}
    </p>
  );
  const leavesOutText = t('runResults.checkpoint.option.leavesOut');
  const onMachineText = t('runResults.checkpoint.option.onMachine', {
    org: name,
    setting: KEEP_DAYS_SETTING,
  });
  const costSaidText = t(COST_SAID_KEYS[costSaid]);
  const leavesOut = line('leaves-out', leavesOutText);
  const onMachine = line('on-machine', onMachineText);
  const costSaidLine = line('cost-said', costSaidText);
  const refusedText = t('runResults.checkpoint.option.refused');
  const refused = <p className="text-text-secondary">{refusedText}</p>;
  const estimated = estimate ? (
    <CheckpointFirstEstimate
      estimate={estimate.of}
      lead={estimate.lead}
      testId={`${testId}-estimate`}
    />
  ) : null;
  /** Folded and closed, the box is also described by a hidden copy of what the fold holds. */
  const describedByFold = foldDetails && offered && !open;
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col gap-1 rounded-sm border border-subtle bg-surface-1 p-2 text-[11px] text-text-primary',
        className,
      )}
    >
      <label className={cn('flex items-start gap-2', offered && 'cursor-pointer')}>
        <input
          type="checkbox"
          checked={checked && offered}
          disabled={!offered}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={describedByFold ? `${detailsId} ${foldedId}` : detailsId}
          data-testid={`${testId}-toggle`}
          className="mt-0.5"
        />
        <span className="flex items-start gap-1 font-medium">
          <History size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          {t('runResults.checkpoint.option.label')}
        </span>
      </label>
      {describedByFold && (
        <div id={foldedId} hidden>
          {line('leaves-out', leavesOutText, false)}
          {line('on-machine', onMachineText, false)}
          {estimated ? null : line('cost-said', costSaidText, false)}
          {line('refused', refusedText, false)}
        </div>
      )}
      <div id={detailsId} className="ml-5 flex flex-col gap-1">
        {!offered ? (
          <p data-testid={`${testId}-not-offered`} className="text-text-secondary">
            {t('runResults.checkpoint.option.notOffered', { org: name })}
          </p>
        ) : (
          <>
            <p data-testid={`${testId}-holds`}>
              {t('runResults.checkpoint.option.holds', { org: name })}
            </p>
            {foldDetails ? (
              <>
                {estimated}
                <details
                  data-testid={`${testId}-more`}
                  onToggle={(event) => setOpen(event.currentTarget.open)}
                >
                  <summary className="cursor-pointer text-text-secondary">
                    {t('runResults.checkpoint.option.more')}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    {leavesOut}
                    {onMachine}
                    {estimated ? null : costSaidLine}
                    {refused}
                  </div>
                </details>
              </>
            ) : (
              <>
                {leavesOut}
                {onMachine}
                {estimated ?? costSaidLine}
                {refused}
              </>
            )}
            {recommendation !== undefined && !checked && (
              <p data-testid={`${testId}-recommended`} className="font-medium">
                {recommendation}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
