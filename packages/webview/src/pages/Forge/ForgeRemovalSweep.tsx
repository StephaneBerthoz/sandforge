import React, { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  ForgeRemovalLeftCount,
  ForgeSweepClasses,
  ForgeSweepLeftClass,
  ForgeSweepListing,
  ForgeSweepMark,
  ForgeSweepObjectResult,
  ForgeSweepResult,
} from '@sandforge/shared';
import { cn } from '../../theme';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { MuteEntryList } from '../../components/ui/AutomationMuteBox';

/** How long the read may take: the target's automation, then one read per object. */
const READ_TIMEOUT_MS = 150_000;

/**
 * How many objects a line names. A sweep looks at the children of the run's
 * objects too, up to 300 of them: named in full, the line filled the
 * confirmation and pushed the org's name out of it.
 */
const OBJECTS_NAMED = 12;

/** Why what a sweep leaves stays, each in a line: the product says it, as `--help` does. */
const STAYS_KEYS = [
  'runRemoval.sweep.staysOtherUser',
  'runRemoval.sweep.staysUntied',
  'runRemoval.sweep.staysTooLate',
  'runRemoval.sweep.staysChanged',
  'runRemoval.sweep.staysUnreadable',
  'runRemoval.sweep.staysRefused',
  'runRemoval.sweep.staysNotCreated',
  'runRemoval.sweep.staysLeftTheOrg',
  'runRemoval.sweep.staysOverBound',
  'runRemoval.sweep.staysOtherMachines',
] as const;

/** What `forge:undo-sweep:request` answers. */
interface SweepAnswer {
  forgeId: string;
  listing: ForgeSweepListing;
}

/** What a sweep's result says of what it found and left, by class. */
const LEFT_KEYS: Record<ForgeSweepLeftClass['class'], string> = {
  late: 'runRemoval.sweep.leftLate',
  untied: 'runRemoval.sweep.leftUntied',
};

/** What a sweep's result says first, by how it ended. */
const RESULT_TITLE_KEYS: Record<ForgeSweepResult['status'], string> = {
  success: 'runRemoval.sweep.resultSuccess',
  partial: 'runRemoval.sweep.resultPartial',
  failure: 'runRemoval.sweep.resultFailure',
  cancelled: 'runRemoval.sweep.resultCancelled',
  refused: 'runRemoval.sweep.resultRefused',
};

/** The colour of that first line. */
const RESULT_TITLE_CLASSES: Record<ForgeSweepResult['status'], string> = {
  success: 'text-status-success',
  partial: 'text-status-warning',
  failure: 'text-status-error',
  cancelled: 'text-status-warning',
  refused: 'text-status-warning',
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

/** A window's date as the panel writes its dates, to the second. */
function shownAt(t: TFunction, iso: string): string {
  return formatStoredDate(iso, 'yyyy-MM-dd HH:mm:ss') ?? t('common.dateUnknown');
}

/** Objects by name, the first few when there are many, and how many more. */
function namedObjects(t: TFunction, names: readonly string[]): string {
  if (names.length <= OBJECTS_NAMED) return names.join(', ');
  return t('runRemoval.sweep.objectsMore', {
    objects: names.slice(0, OBJECTS_NAMED).join(', '),
    formatted: formatNumber(names.length - OBJECTS_NAMED),
  });
}

/** Records in all, of per-object counts. */
function totalOf(counts: readonly ForgeRemovalLeftCount[]): number {
  return counts.reduce((sum, { count }) => sum + count, 0);
}

/** Per-object counts in a sentence. */
function perObject(counts: readonly ForgeRemovalLeftCount[]): string {
  return counts.map((c) => `${c.objectApiName} (${formatNumber(c.count)})`).join(', ');
}

/** How one object's records fall in the classes the extension put them in, those it found. */
function classParts(t: TFunction, classes: ForgeSweepClasses): string[] {
  const { made, sameSave = 0, madeOver, late, untied, changed = 0 } = classes;
  return [
    made > 0 ? counted(t, 'runRemoval.sweep.classMade', made) : '',
    sameSave > 0 ? counted(t, 'runRemoval.sweep.classSameSave', sameSave) : '',
    madeOver > 0 ? counted(t, 'runRemoval.sweep.classMadeOver', madeOver) : '',
    late > 0 ? counted(t, 'runRemoval.sweep.classLate', late) : '',
    untied > 0 ? counted(t, 'runRemoval.sweep.classUntied', untied) : '',
    changed > 0 ? counted(t, 'runRemoval.sweep.classChanged', changed) : '',
  ].filter(Boolean);
}

/**
 * The records a sweep takes with no more asked: what it ties to the run, but
 * what changed since the run, which it keeps unless what changed is included,
 * and nothing past the bound. A list counted a task changed since among what
 * the sweep took, which the sweep then kept.
 */
function takenWithNoMoreAsked(found: ForgeSweepListing['found']): number {
  return found.reduce((sum, { classes, overBound }) => {
    if (!classes || overBound) return sum;
    const changed = (classes.changedIn?.made ?? 0) + (classes.changedIn?.madeOver ?? 0);
    return sum + Math.max(0, tiedOf(classes) - changed);
  }, 0);
}

/** The records of one object a sweep ties to the run: made for it, or on a record it wrote over. */
function tiedOf(classes: ForgeSweepClasses): number {
  return classes.made + classes.madeOver;
}

/**
 * The warning for what a sweep cannot tell from the automation's among what
 * it takes, as `--sweep-list` words it: a record made by hand as the run's
 * user under the run's records within a minute of them, within a quarter of
 * an hour once what came late is ticked, at any time of the run once what is
 * tied to nothing is. The page said only the first, and nothing at all once
 * the box of what is tied to nothing was ticked over a list that tied nothing
 * to the run: the box that takes the most hand work, refused only for the
 * hand work the extension sees. Said when what the sweep takes holds records
 * of those classes, none past the bound, which it does not sweep.
 */
function ownWorkKey(
  found: ForgeSweepListing['found'],
  taken: { late: boolean; untied: boolean },
): string | undefined {
  const holds = (count: (classes: ForgeSweepClasses) => number): boolean =>
    found.some(
      ({ classes, overBound }) => classes !== undefined && !overBound && count(classes) > 0,
    );
  const late = taken.late && holds((classes) => classes.late);
  if (taken.untied && holds((classes) => classes.untied)) {
    return late ? 'runRemoval.sweep.ownWorkLateUntied' : 'runRemoval.sweep.ownWorkUntied';
  }
  if (late) return 'runRemoval.sweep.ownWorkLate';
  // What it ties to the run, changed since or not: what a person made by
  // hand under the run's records reads as the automation's all the same.
  return holds(tiedOf) ? 'runRemoval.sweep.ownWork' : undefined;
}

/** What a sweep's result says of what went along with the run's records, by class. */
const GONE_ALONG_KEYS: Record<ForgeSweepLeftClass['class'], string> = {
  late: 'runRemoval.sweep.goneAlongLate',
  untied: 'runRemoval.sweep.goneAlongUntied',
};

/**
 * The two ticks under a sweep's list. A sweep takes what it ties to the run;
 * what came late and what is tied to nothing it lists and keeps, unless each
 * is ticked.
 */
export interface SweepTicks {
  /** Take too what the listing says came late (`ForgeSweepListing.late`). */
  sweepLate?: true;
  /** Take too what it says is tied to nothing of the run (`ForgeSweepListing.untied`). */
  sweepUntied?: true;
}

/** A confirmation's sweep: its tick, the two under its list, and what a removal's request says of them. */
export interface RemovalSweepAsked {
  sweep: boolean;
  setSweep: (sweep: boolean) => void;
  ticks: SweepTicks;
  setTicks: (ticks: SweepTicks) => void;
  /** What the request says of the sweep: nothing unless it is ticked. */
  asked: { sweep?: true } & SweepTicks;
}

/**
 * The state a confirmation's sweep is asked with. The tick of the sweep sets
 * both of the others back: they answer a list read for this opening, and a
 * record deleted on a tick left from the last one was never asked for.
 */
export function useRemovalSweep(): RemovalSweepAsked {
  const [state, setState] = useState<{ sweep: boolean; ticks: SweepTicks }>({
    sweep: false,
    ticks: {},
  });
  const setSweep = useCallback((sweep: boolean) => setState({ sweep, ticks: {} }), []);
  const setTicks = useCallback(
    (ticks: SweepTicks) => setState((current) => ({ ...current, ticks })),
    [],
  );
  return {
    sweep: state.sweep,
    setSweep,
    ticks: state.ticks,
    setTicks,
    asked: state.sweep ? { sweep: true, ...state.ticks } : {},
  };
}

/**
 * What a sweep could not look at, what of the target's automation it could
 * not read, and the hand work that refuses it: said under its listing and
 * under its result alike.
 */
const SweepNotes: React.FC<{
  notes: Pick<ForgeSweepListing, 'unread' | 'automationGaps' | 'handWork' | 'refusal'>;
}> = ({ notes }) => {
  const { t } = useTranslation();
  const gaps = notes.automationGaps;
  return (
    <>
      {gaps?.error && (
        <p data-testid="forge-sweep-automation-error" className="text-status-warning">
          {t('runRemoval.sweep.automationError', { reason: gaps.error })}
        </p>
      )}
      {(gaps?.flowsNotRead ?? 0) > 0 && (
        <p data-testid="forge-sweep-flows-not-read" className="text-status-warning">
          {counted(t, 'runRemoval.sweep.flowsNotRead', gaps?.flowsNotRead ?? 0)}
        </p>
      )}
      {(gaps?.triggers ?? 0) > 0 && (
        <p data-testid="forge-sweep-triggers" className="text-status-warning">
          {counted(t, 'runRemoval.sweep.triggers', gaps?.triggers ?? 0)}
        </p>
      )}
      {notes.unread.map((unread) => (
        <p
          key={unread.objectApiName}
          data-testid={`forge-sweep-unread-${unread.objectApiName}`}
          className="text-text-secondary wrap-break-word"
        >
          {t('runRemoval.sweep.unread', {
            object: unread.objectApiName,
            reason: unread.reason,
          })}
        </p>
      ))}
      {notes.handWork.map((count) => (
        <p
          key={count.objectApiName}
          data-testid={`forge-sweep-hand-work-${count.objectApiName}`}
          className="text-status-warning"
        >
          {counted(t, 'runRemoval.sweep.handWork', count.count, {
            object: count.objectApiName,
          })}
        </p>
      ))}
      {notes.refusal !== undefined && (
        <p data-testid="forge-sweep-refusal" className="text-status-warning wrap-break-word">
          {t('runRemoval.sweep.refused', { reason: notes.refusal })}
        </p>
      )}
    </>
  );
};

/** Props for {@link SweepKeptTicks}. */
interface SweepKeptTicksProps {
  listing: ForgeSweepListing;
  ticks: SweepTicks;
  onTicksChange: (ticks: SweepTicks) => void;
}

/**
 * The ticks that take what a sweep lists and keeps: what came late, and what
 * is tied to nothing of the run. The second is refused, in the extension's
 * words, when hand work or another run of this machine is seen: its box stays
 * on the page, unticked, so that what is kept keeps saying why.
 */
const SweepKeptTicks: React.FC<SweepKeptTicksProps> = ({ listing, ticks, onTicksChange }) => {
  const { t } = useTranslation();
  const refusalId = useId();
  const late = listing.late ?? [];
  const untied = listing.untied?.objects ?? [];
  const refusal = listing.untied?.refusal;
  const refused = refusal !== undefined;
  const { sweepLate, sweepUntied } = ticks;
  return (
    <>
      {late.length > 0 && (
        <label className="flex items-start gap-2 mt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={sweepLate === true}
            onChange={(e) =>
              onTicksChange({
                ...(e.target.checked ? { sweepLate: true } : {}),
                ...(sweepUntied ? { sweepUntied } : {}),
              })
            }
            data-testid="forge-sweep-late-tick"
          />
          <span>
            {counted(t, 'runRemoval.sweep.tickLate', totalOf(late), { objects: perObject(late) })}
          </span>
        </label>
      )}
      {untied.length > 0 && (
        <label className={cn('flex items-start gap-2 mt-1', !refused && 'cursor-pointer')}>
          <input
            type="checkbox"
            checked={sweepUntied === true && !refused}
            disabled={refused}
            {...(refused ? { 'aria-describedby': refusalId } : {})}
            onChange={(e) =>
              onTicksChange({
                ...(sweepLate ? { sweepLate } : {}),
                ...(e.target.checked ? { sweepUntied: true } : {}),
              })
            }
            data-testid="forge-sweep-untied-tick"
          />
          <span>
            {counted(t, 'runRemoval.sweep.tickUntied', totalOf(untied), {
              objects: perObject(untied),
            })}
          </span>
        </label>
      )}
      {untied.length > 0 && refused && (
        <p
          id={refusalId}
          data-testid="forge-sweep-untied-refused"
          className="ml-5 text-status-warning wrap-break-word"
        >
          {t('runRemoval.sweep.untiedRefused', { reason: refusal })}
        </p>
      )}
    </>
  );
};

/** Props for {@link ForgeSweepListingView}. */
export interface ForgeSweepListingViewProps {
  listing: ForgeSweepListing;
  /** The ticks under the list. Absent, what it keeps is listed, and nothing is offered. */
  ticks?: SweepTicks;
  onTicksChange?: (ticks: SweepTicks) => void;
}

/**
 * What a sweep would take, read before anything is deleted: the window and
 * the objects looked at, what it takes with no more asked, per object the
 * records found and how the extension classed them — a few of their names on
 * demand, never an id —, the ticks that take what it keeps, what could not be
 * looked at, why the sweep would be refused, and what stays whatever is
 * ticked, and why.
 *
 * Every class is the extension's, read from the listing: this page adds
 * counts up, and tells no record from another.
 */
export const ForgeSweepListingView: React.FC<ForgeSweepListingViewProps> = ({
  listing,
  ticks,
  onTicksChange,
}) => {
  const { t } = useTranslation();
  // A sweep told the run's ties always says what it keeps, if only that it is nothing.
  const told = listing.untied !== undefined;
  const taken = takenWithNoMoreAsked(listing.found);
  const tied = listing.found.some(
    ({ classes, overBound }) => classes !== undefined && !overBound && tiedOf(classes) > 0,
  );
  // A tick takes only where it is offered, and the box of what is tied to
  // nothing takes nothing while it is refused, ticked or not.
  const offered =
    ticks !== undefined && onTicksChange !== undefined && listing.refusal === undefined;
  const ownWork = ownWorkKey(listing.found, {
    late: offered && ticks.sweepLate === true,
    untied: offered && ticks.sweepUntied === true && listing.untied?.refusal === undefined,
  });
  return (
    <>
      {listing.window && (
        <p data-testid="forge-sweep-window" className="text-text-secondary wrap-break-word">
          {t('runRemoval.sweep.window', {
            from: shownAt(t, listing.window.from),
            to: shownAt(t, listing.window.to),
            objects: namedObjects(t, listing.looked),
          })}
        </p>
      )}
      {told && listing.refusal === undefined && listing.found.length > 0 && (
        <p data-testid="forge-sweep-takes">
          {taken > 0
            ? counted(t, 'runRemoval.sweep.takes', taken)
            : t(tied ? 'runRemoval.sweep.takesNothingChanged' : 'runRemoval.sweep.takesNothing')}
        </p>
      )}
      {listing.found.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {listing.found.map((found) => (
            <li key={found.objectApiName} data-testid={`forge-sweep-found-${found.objectApiName}`}>
              <span className="font-mono">
                {found.overBound
                  ? counted(t, 'runRemoval.sweep.overBound', found.count, {
                      object: found.objectApiName,
                    })
                  : counted(t, 'runRemoval.sweep.found', found.count, {
                      object: found.objectApiName,
                    })}
              </span>
              {found.classes && (
                <p
                  data-testid={`forge-sweep-classes-${found.objectApiName}`}
                  className="ml-3 text-text-secondary"
                >
                  {classParts(t, found.classes).join(' · ')}
                </p>
              )}
              {found.names.length > 0 && (
                <details className="ml-3">
                  <summary className="cursor-pointer text-text-secondary">
                    {t('runRemoval.sweep.names')}
                  </summary>
                  <span className="wrap-break-word">
                    {found.names.join(', ')}
                    {found.count > found.names.length ? ', …' : ''}
                  </span>
                </details>
              )}
            </li>
          ))}
        </ul>
      ) : (
        listing.refusal === undefined && (
          <p data-testid="forge-sweep-none">{t('runRemoval.sweep.none')}</p>
        )
      )}
      {ownWork !== undefined && (
        <p data-testid="forge-sweep-own-work" className="text-status-warning">
          {t(ownWork)}
        </p>
      )}
      {ticks && onTicksChange && listing.refusal === undefined && (
        <SweepKeptTicks listing={listing} ticks={ticks} onTicksChange={onTicksChange} />
      )}
      {(listing.notLooked ?? []).length > 0 && (
        <p data-testid="forge-sweep-not-looked" className="text-status-warning wrap-break-word">
          {t('runRemoval.sweep.notLooked', {
            objects: namedObjects(t, listing.notLooked ?? []),
          })}
        </p>
      )}
      {listing.muted && (
        <div data-testid="forge-sweep-muted" className="flex flex-col gap-0.5">
          <MuteEntryList
            title={t('automationMute.result.silenced')}
            entries={listing.muted.silenced}
            testId="forge-sweep-muted-silenced"
          />
          <MuteEntryList
            title={t('automationMute.result.stillRan')}
            entries={listing.muted.stillRan}
            testId="forge-sweep-muted-still-ran"
          />
          <p className="text-text-secondary">{t('runRemoval.sweep.noBypass')}</p>
        </div>
      )}
      <SweepNotes notes={listing} />
      {told && (
        <details data-testid="forge-sweep-stays">
          <summary className="cursor-pointer text-text-secondary">
            {t('runRemoval.sweep.staysTitle')}
          </summary>
          <ul className="ml-3 flex list-disc flex-col gap-0.5">
            {STAYS_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
};

/** Props for {@link ForgeRemovalSweep}. */
export interface ForgeRemovalSweepProps {
  /** The run whose removal is being confirmed with a sweep; nothing is read while there is none. */
  forgeId: string | undefined;
  /** The org it wrote to, as the user knows it. */
  org: string;
  /** The ticks under the list: what it keeps, taken too. */
  ticks?: SweepTicks;
  onTicksChange?: (ticks: SweepTicks) => void;
  /** Told what it read, null until it has: what the confirmation reads the automation of. */
  onListing?: (listing: ForgeSweepListing | null) => void;
}

/**
 * What a sweep asked with a removal would take, read as the confirmation's
 * sweep is ticked and listed before the user types the org's name: what the
 * target's automation made for the run, as its user, that the run's id map
 * does not hold, and what it lists and keeps. Read only. The sweep itself
 * reads again once the removal has read the run's records, before its first
 * delete, while the links that tie a record to them are still there: it takes
 * what it can before them, and what a record of theirs points at once they
 * are gone.
 */
export const ForgeRemovalSweep: React.FC<ForgeRemovalSweepProps> = ({
  forgeId,
  org,
  ticks,
  onTicksChange,
  onListing,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const read = useBridgeMutation<SweepAnswer>('forge:undo-sweep:request', {
    responseType: 'forge:undo-sweep:response',
    errorType: 'forge:undo-sweep:error',
    timeoutMs: READ_TIMEOUT_MS,
  });
  const { mutate, reset } = read;
  useEffect(() => {
    if (forgeId) mutate({ forgeId });
    else reset();
  }, [forgeId, mutate, reset]);
  const listing = read.data?.forgeId === forgeId ? (read.data?.listing ?? null) : null;
  useEffect(() => {
    onListing?.(listing);
  }, [listing, onListing]);
  useEffect(() => () => onListing?.(null), [onListing]);

  if (!forgeId) return null;
  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="forge-sweep-error" className="text-status-warning">
        {t('runRemoval.sweep.error', { org, reason: read.error })}
      </p>
    );
  } else if (!listing) {
    body = (
      <p data-testid="forge-sweep-loading" className="text-text-secondary">
        {t('runRemoval.sweep.loading', { org })}
      </p>
    );
  } else {
    body = (
      <ForgeSweepListingView
        listing={listing}
        {...(ticks ? { ticks } : {})}
        {...(onTicksChange ? { onTicksChange } : {})}
      />
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-removal-sweep"
      className="mt-2 flex flex-col gap-1 text-[11px] text-text-primary"
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t('runRemoval.sweep.title', { org })}
      </h4>
      {body}
    </section>
  );
};

/** What became of one object's records in a sweep, the counts that are not zero. */
function sweepParts(t: TFunction, object: ForgeSweepObjectResult): string[] {
  const after = object.afterRemoval ?? 0;
  return [
    object.deleted > 0 ? counted(t, 'runRemoval.resultDeleted', object.deleted) : '',
    // Why they went last: the org refuses them while a record of the run names them.
    after > 0 ? counted(t, 'runRemoval.sweep.resultAfterRemoval', after) : '',
    object.alreadyGone > 0 ? counted(t, 'runRemoval.resultGone', object.alreadyGone) : '',
    object.keptChanged > 0 ? counted(t, 'runRemoval.resultChanged', object.keptChanged) : '',
    object.refused > 0 ? counted(t, 'runRemoval.resultRefused', object.refused) : '',
  ].filter(Boolean);
}

/** Props for {@link ForgeRunSweepResult}. */
export interface ForgeRunSweepResultProps {
  result: ForgeSweepResult;
  /** The org it swept, as the user knows it. */
  org: string;
}

/**
 * What a sweep did around the run's records: how it ended, per object what
 * became of the records it found — deleted, those of them that waited for the
 * run's own, already gone, kept as changed since the run, refused with the
 * org's words —, what it found and left, by class, and what it could not look
 * at, or why it was refused. A sweep that took all it was asked to and left
 * what came late or is tied to nothing is a success: its first line no longer
 * says that nothing it found is left.
 */
export const ForgeRunSweepResult: React.FC<ForgeRunSweepResultProps> = ({ result, org }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const left = result.left ?? [];
  const title =
    result.status === 'success' && left.length > 0
      ? 'runRemoval.sweep.resultSuccessLeft'
      : RESULT_TITLE_KEYS[result.status];
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-sweep-result"
      className="flex flex-col gap-1 mt-1.5 text-[11px]"
    >
      <h4
        id={headingId}
        className={cn('text-[11px] font-semibold', RESULT_TITLE_CLASSES[result.status])}
      >
        {t(title, { org })}
      </h4>
      <ul className="flex flex-col gap-1">
        {result.objects.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`forge-sweep-result-${object.objectApiName}`}
            className="text-text-secondary"
          >
            <span className="font-mono text-text-primary">{object.objectApiName}</span>
            {': '}
            {sweepParts(t, object).join(' · ') || t('runRemoval.sweep.nothing')}
            {object.reasons.length > 0 && (
              <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
                {object.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {left.map(({ class: kept, objects, refusal }) => (
        <div
          key={kept}
          data-testid={`forge-sweep-left-${kept}`}
          className="flex flex-col gap-0.5 wrap-break-word text-status-warning"
        >
          <p>{counted(t, LEFT_KEYS[kept], totalOf(objects), { objects: perObject(objects) })}</p>
          <p>
            {refusal !== undefined
              ? t('runRemoval.sweep.untiedRefused', { reason: refusal })
              : t('runRemoval.sweep.leftTick')}
          </p>
        </div>
      ))}
      {(result.goneAlong ?? []).map(({ class: went, objects }) => (
        <p
          key={went}
          data-testid={`forge-sweep-gone-along-${went}`}
          className="text-text-secondary wrap-break-word"
        >
          {counted(t, GONE_ALONG_KEYS[went], totalOf(objects), {
            objects: perObject(objects),
            org,
          })}
        </p>
      ))}
      <SweepNotes notes={result} />
    </section>
  );
};

/** Props for {@link ForgeRunSweepMark}. */
export interface ForgeRunSweepMarkProps {
  mark: ForgeSweepMark;
}

/** The line a run that was swept carries: when, what every sweep deleted, what the last one left. */
export const ForgeRunSweepMark: React.FC<ForgeRunSweepMarkProps> = ({ mark }) => {
  const { t } = useTranslation();
  const parts = [
    counted(t, 'runRemoval.resultDeleted', mark.deleted),
    mark.keptChanged > 0 ? counted(t, 'runRemoval.resultChanged', mark.keptChanged) : '',
    mark.refused > 0 ? counted(t, 'runRemoval.resultRefused', mark.refused) : '',
  ].filter(Boolean);
  return (
    <p data-testid="forge-sweep-mark" className="text-[10px] text-text-secondary">
      {t('runRemoval.sweep.sweptOn', {
        date: formatStoredDate(mark.sweptAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
      })}{' '}
      {parts.join(' · ')}
    </p>
  );
};
