import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Square } from 'lucide-react';
import type {
  ForgeExecutionResult,
  ForgeFileObject,
  ForgeRemovalPlan,
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoResult,
  ForgeUndoStatus,
} from '@sandforge/shared';
import {
  forgeRemovalPlanCountsLeft,
  forgeRunCountsLeft,
  forgeRunLinkedKeptCount,
} from '@sandforge/shared';
import { cn } from '../../theme';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { ForgeRemovalAutomation } from './ForgeRemovalAutomation';
import { ForgeRemovalSweep, ForgeRunSweepResult } from './ForgeRemovalSweep';

/**
 * What a removal takes back — a Forge run, a Frozen load, what was added to
 * an org since a checkpoint its rewind deletes, or what a rewind brought back
 * that its undo sends back to the recycle bin — which is all its result's
 * words change with: the removal is the same.
 */
export type RemovalSubject = 'run' | 'load' | 'rewind' | 'rewindUndo';

/** What a removal's result says first, by what it took back and how it ended. */
const RESULT_TITLE_KEYS: Record<RemovalSubject, Record<ForgeUndoStatus, string>> = {
  run: {
    success: 'runRemoval.resultSuccess',
    partial: 'runRemoval.resultPartial',
    failure: 'runRemoval.resultFailure',
    cancelled: 'runRemoval.resultCancelled',
  },
  load: {
    success: 'runRemoval.load.resultSuccess',
    partial: 'runRemoval.load.resultPartial',
    failure: 'runRemoval.load.resultFailure',
    // Says nothing of what was taken back.
    cancelled: 'runRemoval.resultCancelled',
  },
  rewind: {
    success: 'runRemoval.rewind.resultSuccess',
    partial: 'runRemoval.rewind.resultPartial',
    failure: 'runRemoval.rewind.resultFailure',
    cancelled: 'runRemoval.resultCancelled',
  },
  rewindUndo: {
    success: 'runRemoval.rewindUndo.resultSuccess',
    partial: 'runRemoval.rewindUndo.resultPartial',
    failure: 'runRemoval.rewindUndo.resultFailure',
    cancelled: 'runRemoval.resultCancelled',
  },
};

/** What a record kept for a change since is said to have changed since. */
const CHANGED_KEYS: Record<RemovalSubject, string> = {
  run: 'runRemoval.resultChanged',
  load: 'runRemoval.load.resultChanged',
  rewind: 'runRemoval.rewind.resultChanged',
  rewindUndo: 'runRemoval.rewindUndo.resultChanged',
};

/** What the files a removal leaves in the org are said not to have come with. */
const FILES_LEFT_KEYS: Record<RemovalSubject, string> = {
  run: 'runRemoval.resultFilesLeft',
  load: 'runRemoval.load.resultFilesLeft',
  rewind: 'runRemoval.rewind.resultFilesLeft',
  rewindUndo: 'runRemoval.rewindUndo.resultFilesLeft',
};

/**
 * The objects a removal counts files under — a Salesforce File by its
 * document, a legacy attachment by itself — which its confirmation counts as
 * files: "ContentDocument: 1 record" read as a record of an object nobody
 * syncs.
 */
const FILE_OBJECTS: ReadonlySet<string> = new Set<ForgeFileObject>([
  'ContentDocument',
  'Attachment',
]);

/** The colour of that first line. */
const RESULT_TITLE_CLASSES: Record<ForgeUndoStatus, string> = {
  success: 'text-status-success',
  partial: 'text-status-warning',
  failure: 'text-status-error',
  cancelled: 'text-status-warning',
};

/** A count in a sentence: the plural the count picks, the number as the reader writes it. */
function counted(
  t: TFunction,
  key: string,
  count: number,
  extra: Record<string, string> = {},
): string {
  return t(key, { count, formatted: formatNumber(count), ...extra });
}

/** What became of one object's records, the counts that are not zero, in reading order. */
function outcomeParts(
  t: TFunction,
  object: ForgeUndoObjectResult,
  subject: RemovalSubject,
): string[] {
  const parts: string[] = [];
  if (object.deleted > 0) parts.push(counted(t, 'runRemoval.resultDeleted', object.deleted));
  if (object.alreadyGone > 0) {
    parts.push(counted(t, 'runRemoval.resultGone', object.alreadyGone));
  }
  // Not found, and not in the recycle bin: never said gone.
  if ((object.notVisible ?? 0) > 0) {
    parts.push(counted(t, 'runRemoval.resultNotVisible', object.notVisible ?? 0));
  }
  if (object.keptChanged > 0) {
    parts.push(counted(t, CHANGED_KEYS[subject], object.keptChanged));
  }
  if (object.keptDependents > 0) {
    parts.push(
      object.heldBy.length > 0
        ? counted(t, 'runRemoval.resultHeld', object.keptDependents, {
            objects: object.heldBy.join(', '),
          })
        : counted(t, 'runRemoval.resultHeldUnread', object.keptDependents),
    );
  }
  if (object.refused > 0) parts.push(counted(t, 'runRemoval.resultRefused', object.refused));
  // A removal stopped part way names what it never got to, an object it
  // never reached too: left in the org, for a removal of what it left.
  if ((object.notReached ?? 0) > 0) {
    parts.push(counted(t, 'runRemoval.resultNotReached', object.notReached ?? 0));
  }
  return parts;
}

/** Props for {@link ForgeRunRemovalPlan}. */
export interface ForgeRunRemovalPlanProps {
  /** How many records of each object the removal takes, in the order it takes them. */
  plan: ReadonlyArray<{ objectApiName: string; count: number }>;
  /** Records the run or load linked to, which the removal leaves where they are. */
  linked: number;
  /**
   * When the removal that left these records in the org ended, written as the
   * panel writes its dates: absent before any removal left some.
   */
  leftBy?: string;
}

/**
 * What a removal would take, object by object in the order it takes them,
 * and the linked records it leaves: the counts a confirmation names — once a
 * removal left records in the org, the ones it left, and it says so.
 */
export const ForgeRunRemovalPlan: React.FC<ForgeRunRemovalPlanProps> = ({
  plan,
  linked,
  leftBy,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" data-testid="forge-removal-plan">
      {leftBy !== undefined && (
        <p data-testid="forge-removal-left-by">{t('runRemoval.removeLeftBy', { date: leftBy })}</p>
      )}
      <ul className="flex flex-col gap-0.5">
        {plan.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`forge-removal-plan-${object.objectApiName}`}
            className="font-mono"
          >
            {counted(
              t,
              FILE_OBJECTS.has(object.objectApiName)
                ? 'runRemoval.removeFiles'
                : 'runRemoval.removeObject',
              object.count,
              { object: object.objectApiName },
            )}
          </li>
        ))}
      </ul>
      {linked > 0 && (
        <p data-testid="forge-removal-linked">{counted(t, 'runRemoval.removeLinked', linked)}</p>
      )}
    </div>
  );
};

/**
 * A run as its removal's confirmation reads it: what it created, and, to read
 * what the target runs as the records go, which run of the history it is and
 * the org it wrote to.
 */
type RemovableRun = Pick<
  ForgeExecutionResult,
  | 'idRemapTable'
  | 'idRemapExisting'
  | 'idRemapCreated'
  | 'idRemapWithTheirRecord'
  | 'undo'
  | 'removalLeft'
> &
  Partial<
    Pick<
      ForgeExecutionResult,
      | 'forgeId'
      | 'targetOrgId'
      | 'remapInJournal'
      | 'removalLeftByObject'
      | 'idRemapByObject'
      | 'linkedExistingCount'
      | 'journalGone'
    >
  >;

/** Whether a run is given by the removal plan kept of it, the history having dropped it. */
function isKeptPlan(run: RemovableRun | ForgeRemovalPlan): run is ForgeRemovalPlan {
  return 'objects' in run && Array.isArray(run.objects);
}

/** Props for {@link ForgeRunRemovalConfirm}. */
export interface ForgeRunRemovalConfirmProps {
  /**
   * The run whose removal is being confirmed — its history entry, or the plan
   * kept of it once the history dropped it; null while none is.
   */
  run: RemovableRun | ForgeRemovalPlan | null;
  /** The org it wrote to, as the user knows it: the word typed to confirm. */
  org: string;
  /** Whether the records changed since the run go too. */
  includeChanged: boolean;
  onIncludeChangedChange: (includeChanged: boolean) => void;
  /**
   * Whether a sweep follows the removal (`ForgeRemovalSweep`): offered for a
   * run the history holds, never ticked unasked. Absent, no sweep is offered.
   */
  sweep?: boolean;
  onSweepChange?: (sweep: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * The confirmation of a removal of a run's records, wherever it is asked for
 * — the history of runs, or the results of the run: the org named and typed,
 * the records it takes per object and the linked ones it keeps, what an
 * earlier removal left when one did, what the target runs as the records go,
 * and whether the records changed since the run go too. One confirmation, so
 * the two places never say two things.
 *
 * A run the history holds is offered a sweep beside its removal: what the
 * target's automation created during the run, as its user, that the run's id
 * map does not hold — listed once ticked, before the org's name is typed. A
 * run the history dropped keeps no id map, and is offered none.
 */
export const ForgeRunRemovalConfirm: React.FC<ForgeRunRemovalConfirmProps> = ({
  run,
  org,
  includeChanged,
  onIncludeChangedChange,
  sweep = false,
  onSweepChange,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();
  // Counted, as a run whose ids are in its journal counts them.
  const plan = useMemo(
    () =>
      run ? (isKeptPlan(run) ? forgeRemovalPlanCountsLeft(run) : forgeRunCountsLeft(run)) : [],
    [run],
  );
  const linked = run ? (isKeptPlan(run) ? run.linked : forgeRunLinkedKeptCount(run)) : 0;
  const sweepOffered =
    onSweepChange !== undefined && run !== null && !isKeptPlan(run) && run.forgeId !== undefined;
  return (
    <DangerConfirm
      open={run !== null}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('runRemoval.removeTitle', { org })}
      description={t('runRemoval.removeDescription', { org })}
      confirmText={org}
    >
      <ForgeRunRemovalPlan
        plan={plan}
        linked={linked}
        {...(run?.undo
          ? {
              leftBy:
                formatStoredDate(run.undo.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
            }
          : {})}
      />
      <ForgeRemovalAutomation forgeId={run?.forgeId} org={org} targetOrgId={run?.targetOrgId} />
      <label className="flex items-center gap-2 mt-2 cursor-pointer">
        <input
          type="checkbox"
          checked={includeChanged}
          onChange={(e) => onIncludeChangedChange(e.target.checked)}
          data-testid="forge-removal-include-changed"
        />
        {t('runRemoval.removeIncludeChanged')}
      </label>
      {sweepOffered && (
        <>
          <label className="flex items-center gap-2 mt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={sweep}
              onChange={(e) => onSweepChange?.(e.target.checked)}
              data-testid="forge-removal-sweep-toggle"
            />
            {t('runRemoval.removeSweep')}
          </label>
          {sweep && <ForgeRemovalSweep forgeId={run?.forgeId} org={org} />}
        </>
      )}
    </DangerConfirm>
  );
};

/** Props for {@link ForgeRunRemovalRunning}. */
export interface ForgeRunRemovalRunningProps {
  /** The id of the request that started the removal, which the extension runs it under. */
  requestId: string | null;
  /** The test id of the line that says it runs; its Stop takes it with `-stop`. */
  testId: string;
}

/**
 * A Forge run's removal under way, from the card that asked for it: that it
 * runs, and its Stop, as Seed's, Sync's and Frozen's removal cards offer one.
 * The extension runs it under the request's id, which the Stop names to
 * `execution:abort`; under an id of its own, only Live Operations could stop
 * it. Stopped, it ends once the call under way is answered, and says what it
 * removed by then.
 */
export const ForgeRunRemovalRunning: React.FC<ForgeRunRemovalRunningProps> = ({
  requestId,
  testId,
}) => {
  const { t } = useTranslation();
  const { requested, cancel } = useOperationCancel(requestId, {
    title: t('runRemoval.stopRefused'),
    message: t('runRemoval.stopRefusedDetail'),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="status" data-testid={testId} className="text-xs text-text-secondary">
        {requested ? t('runRemoval.stopping') : t('runRemoval.removing')}
      </p>
      {requestId && (
        <Button
          variant="danger"
          size="sm"
          icon={<Square size={11} />}
          disabled={requested}
          focusableWhenDisabled
          onClick={cancel}
          data-testid={`${testId}-stop`}
          className="text-[11px]"
        >
          {t('runRemoval.stopRemoval')}
        </Button>
      )}
    </div>
  );
};

/** Props for {@link ForgeRunRemovalResult}. */
export interface ForgeRunRemovalResultProps {
  /** What the removal did, and the removal whose leftovers it took up, if any. */
  result: Pick<
    ForgeUndoResult,
    'status' | 'objects' | 'leftBy' | 'mayHaveBeenWritten' | 'notLookedFor' | 'sweep'
  >;
  /** The org it removed from, as the user knows it. */
  org: string;
  /** What it took back: a Forge run unless said. */
  subject?: RemovalSubject;
}

/**
 * What a removal did, object by object — deleted, already gone, kept because
 * changed since the run or because records that stay depend on them, refused
 * — with what the org said about the refusals, the files attached to the
 * records deleted that stay in the org (the removal takes only what the run
 * created), and, for a removal of what an earlier one left, which one. A sweep
 * asked with it says what it did after; a sweep that ran alone, with nothing
 * of the run left to remove, says it alone.
 */
export const ForgeRunRemovalResult: React.FC<ForgeRunRemovalResultProps> = ({
  result,
  org,
  subject = 'run',
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  // Said once for the removal: the same objects go unchecked under every
  // object that has them.
  const unchecked = [...new Set(result.objects.flatMap((object) => object.unchecked))];
  if (result.sweep && result.objects.length === 0) {
    return <ForgeRunSweepResult result={result.sweep} org={org} />;
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-removal-result"
      className="flex flex-col gap-1 mt-1.5 text-[11px]"
    >
      <h4
        id={headingId}
        className={cn('text-[11px] font-semibold', RESULT_TITLE_CLASSES[result.status])}
      >
        {t(RESULT_TITLE_KEYS[subject][result.status], { org })}
      </h4>
      {result.leftBy !== undefined && (
        <p data-testid="forge-removal-result-left-by" className="text-text-secondary">
          {t('runRemoval.resultLeftBy', {
            date: formatStoredDate(result.leftBy, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
          })}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {result.objects.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`forge-removal-result-${object.objectApiName}`}
            className="text-text-secondary"
          >
            <span className="font-mono text-text-primary">{object.objectApiName}</span>
            {': '}
            {outcomeParts(t, object, subject).join(' · ')}
            {object.reasons.length > 0 && (
              <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
                {object.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {object.filesLeft && object.filesLeft.count > 0 && (
              <p
                data-testid={`forge-removal-files-${object.objectApiName}`}
                className="ml-3 mt-0.5 wrap-break-word"
              >
                {counted(t, FILES_LEFT_KEYS[subject], object.filesLeft.count, {
                  org,
                  names:
                    object.filesLeft.names.join(', ') +
                    (object.filesLeft.count > object.filesLeft.names.length ? ', …' : ''),
                })}
              </p>
            )}
          </li>
        ))}
      </ul>
      {unchecked.length > 0 && (
        <p data-testid="forge-removal-unchecked" className="text-text-secondary">
          {t('runRemoval.resultUnchecked', { objects: unchecked.join(', ') })}
        </p>
      )}
      {/* A call of the run whose answer was lost may have written its rows:
          the removal knows no id of theirs, and says so rather than read as
          one that took everything. */}
      {(result.mayHaveBeenWritten ?? 0) > 0 && (
        <p data-testid="forge-removal-unreachable" className="text-status-warning">
          {counted(t, 'runRemoval.resultMayHaveBeenWritten', result.mayHaveBeenWritten ?? 0, {
            org,
          })}
        </p>
      )}
      {/* Why some of them were never looked for in the org: counted with the
          rest, they read as rows the target was searched for. */}
      {(result.notLookedFor?.notJournaled ?? 0) > 0 && (
        <p data-testid="forge-removal-not-journaled" className="text-text-secondary">
          {counted(t, 'runRemoval.resultNotJournaled', result.notLookedFor?.notJournaled ?? 0, {
            org,
          })}
        </p>
      )}
      {(result.notLookedFor?.callsAfterRemoval ?? 0) > 0 && (
        <p data-testid="forge-removal-calls-not-looked-for" className="text-status-warning">
          {counted(
            t,
            'runRemoval.resultCallsNotLookedFor',
            result.notLookedFor?.callsAfterRemoval ?? 0,
            { org },
          )}
        </p>
      )}
      {result.sweep && <ForgeRunSweepResult result={result.sweep} org={org} />}
    </section>
  );
};

/** Props for {@link ForgeRunRemovalMark}. */
export interface ForgeRunRemovalMarkProps {
  /** What the history entry remembers of the removal. */
  mark: ForgeUndoMark;
  /** When the removal ended, written as the panel writes its dates. */
  date: string;
}

/**
 * The line a run whose records were removed carries above its action: what
 * every removal took, and what the last one left — kept, refused, or not
 * reached before a cancel.
 */
export const ForgeRunRemovalMark: React.FC<ForgeRunRemovalMarkProps> = ({ mark, date }) => {
  const { t } = useTranslation();
  const notReached = mark.notReached ?? 0;
  const notVisible = mark.notVisible ?? 0;
  const parts = [
    mark.deleted > 0 ? counted(t, 'runRemoval.resultDeleted', mark.deleted) : undefined,
    mark.alreadyGone > 0 ? counted(t, 'runRemoval.resultGone', mark.alreadyGone) : undefined,
    mark.kept > 0 ? counted(t, 'runRemoval.resultKept', mark.kept) : undefined,
    mark.refused > 0 ? counted(t, 'runRemoval.resultRefused', mark.refused) : undefined,
    notReached > 0 ? counted(t, 'runRemoval.resultNotReached', notReached) : undefined,
    notVisible > 0 ? counted(t, 'runRemoval.resultNotVisible', notVisible) : undefined,
  ].filter((part): part is string => part !== undefined);
  return (
    <p data-testid="forge-removal-mark" className="text-[10px] text-text-secondary">
      {t('runRemoval.removedOn', { date })} {parts.join(' · ')}
    </p>
  );
};
