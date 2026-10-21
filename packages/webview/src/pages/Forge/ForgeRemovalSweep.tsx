import React, { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  ForgeSweepListing,
  ForgeSweepMark,
  ForgeSweepObjectResult,
  ForgeSweepResult,
} from '@sandforge/shared';
import { cn } from '../../theme';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';

/** How long the read may take: the target's automation, then one read per object. */
const READ_TIMEOUT_MS = 150_000;

/** What `forge:undo-sweep:request` answers. */
interface SweepAnswer {
  forgeId: string;
  listing: ForgeSweepListing;
}

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

/** Props for {@link ForgeSweepListingView}. */
export interface ForgeSweepListingViewProps {
  listing: ForgeSweepListing;
}

/**
 * What a sweep would take, read before anything is deleted: the window and
 * the objects looked at, per object the records found — a few of their names
 * on demand, never an id — what could not be looked at, and why the sweep
 * would be refused.
 */
export const ForgeSweepListingView: React.FC<ForgeSweepListingViewProps> = ({ listing }) => {
  const { t } = useTranslation();
  return (
    <>
      {listing.window && (
        <p data-testid="forge-sweep-window" className="text-text-secondary">
          {t('runRemoval.sweep.window', {
            from: shownAt(t, listing.window.from),
            to: shownAt(t, listing.window.to),
            objects: listing.looked.join(', '),
          })}
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
      <SweepNotes notes={listing} />
    </>
  );
};

/** Props for {@link ForgeRemovalSweep}. */
export interface ForgeRemovalSweepProps {
  /** The run whose removal is being confirmed with a sweep; nothing is read while there is none. */
  forgeId: string | undefined;
  /** The org it wrote to, as the user knows it. */
  org: string;
}

/**
 * What a sweep asked with a removal would take, read as the confirmation's
 * sweep is ticked and listed before the user types the org's name: what the
 * target's automation created during the run, as its user, that the run's id
 * map does not hold. Read only; the sweep itself runs once the run's records
 * are gone, and finds again what is left by then.
 */
export const ForgeRemovalSweep: React.FC<ForgeRemovalSweepProps> = ({ forgeId, org }) => {
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

  if (!forgeId) return null;
  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="forge-sweep-error" className="text-status-warning">
        {t('runRemoval.sweep.error', { org, reason: read.error })}
      </p>
    );
  } else if (!read.data || read.data.forgeId !== forgeId) {
    body = (
      <p data-testid="forge-sweep-loading" className="text-text-secondary">
        {t('runRemoval.sweep.loading', { org })}
      </p>
    );
  } else {
    body = <ForgeSweepListingView listing={read.data.listing} />;
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
  return [
    object.deleted > 0 ? counted(t, 'runRemoval.resultDeleted', object.deleted) : '',
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
 * What a sweep did once the run's records were gone: how it ended, per object
 * what became of the records it found — deleted, already gone, kept as
 * changed since the run, refused with the org's words — and what it could not
 * look at, or why it was refused.
 */
export const ForgeRunSweepResult: React.FC<ForgeRunSweepResultProps> = ({ result, org }) => {
  const { t } = useTranslation();
  const headingId = useId();
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
        {t(RESULT_TITLE_KEYS[result.status], { org })}
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
