import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MutedAutomation } from '@sandforge/shared';
import { formatStoredDate } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';
import { MuteEntryList } from './AutomationMuteBox';

/** Props for {@link MutedAutomationResult}. */
export interface MutedAutomationResultProps {
  /** What the run muted, as its result says it; absent when it was not asked to mute. */
  muted: MutedAutomation | undefined;
  /** The org the run wrote to, as the user knows it. */
  org: string;
  /** Test id of the section; its lists take `-silenced` and `-still-ran`. */
  testId: string;
  className?: string;
}

/**
 * What a run asked to mute the target's automation did of it, in its
 * results: the permission sets it assigned to the user it wrote as, for the
 * run alone, those that user held already, what was taken back as it ended,
 * what stays assigned for another run that needs it, and when the lease that
 * holds what is left ends — or that the journal still names it —, what they
 * silenced and what still ran, and why. A run that found nothing to mute
 * says so, and went as without the option; a simulation says what a real
 * run would assign. Nothing for a run that was not asked to mute.
 */
export const MutedAutomationResult: React.FC<MutedAutomationResultProps> = ({
  muted,
  org,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  if (!muted) return null;
  const list = (items: readonly string[]): string => listWords(items, (key) => t(key));
  let said: string;
  if (muted.state === 'nothing') {
    said = t('automationMute.result.nothing', { org });
  } else if (muted.state === 'planned') {
    // A plan assigns nothing: it names the bypasses the sets would hold.
    said = t('automationMute.result.planned', {
      count: muted.permissions.length,
      bypasses: list(muted.permissions),
      org,
    });
  } else if (muted.assigned.length === 0) {
    said = t('automationMute.result.allHeld', { org });
  } else {
    said = t('automationMute.result.assigned', {
      count: muted.assigned.length,
      sets: list(muted.assigned),
      org,
    });
  }
  const leaseEnds = formatStoredDate(muted.leaseEndsAt, 'yyyy-MM-dd HH:mm');
  // What another run kept for this one and this one took back as it ended is
  // no longer held: the result said "neither assigned nor taken back" of it.
  const takenBack = muted.takenBack;
  const heldKept = muted.held.filter((set) => !takenBack?.includes(set));
  // A result kept before it said what it took back took back what it assigned, when released.
  const tookBackSaid =
    takenBack !== undefined
      ? takenBack.length > 0
        ? t('automationMute.result.takenBack', { sets: list(takenBack) })
        : undefined
      : muted.released === true && muted.assigned.length > 0
        ? t('automationMute.result.released')
        : undefined;
  // Nothing of the run's left in the org: what is left is the journal's line of its lease.
  const leaseOnly = muted.notTakenBack !== undefined && muted.notTakenBack.length === 0;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      data-state={muted.state}
      className={`flex flex-col gap-1 rounded-sm border border-subtle bg-surface-1 p-2 text-[11px] text-text-primary ${className ?? ''}`}
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t('automationMute.result.title')}
      </h4>
      <p data-testid={`${testId}-said`}>{said}</p>
      {muted.tookBackOfEnded && muted.tookBackOfEnded.length > 0 && (
        <p data-testid={`${testId}-took-back-of-ended`} className="text-status-warning">
          {t('automationMute.result.tookBackOfEnded', {
            count: muted.tookBackOfEnded.length,
            sets: list(muted.tookBackOfEnded),
          })}
        </p>
      )}
      {muted.state === 'muted' && muted.assigned.length > 0 && heldKept.length > 0 && (
        <p data-testid={`${testId}-held`}>
          {t('automationMute.result.held', { sets: list(heldKept) })}
        </p>
      )}
      {tookBackSaid !== undefined && <p data-testid={`${testId}-released`}>{tookBackSaid}</p>}
      {muted.passed && muted.passed.length > 0 && (
        <p data-testid={`${testId}-passed`}>
          {t('automationMute.result.passed', {
            count: muted.passed.length,
            sets: list(muted.passed),
            org,
          })}
        </p>
      )}
      {muted.released === false && (
        <p data-testid={`${testId}-not-released`} className="text-status-warning">
          {leaseOnly
            ? t('automationMute.result.journalUnwritten', { org })
            : leaseEnds !== null
              ? t('automationMute.result.notReleased', { org, date: leaseEnds })
              : t('automationMute.result.notReleasedNoDate', { org })}
        </p>
      )}
      <MuteEntryList
        title={
          muted.state === 'planned'
            ? t('automationMute.box.silences')
            : t('automationMute.result.silenced')
        }
        entries={muted.silenced}
        testId={`${testId}-silenced`}
      />
      <MuteEntryList
        title={
          muted.state === 'planned'
            ? t('automationMute.box.stillRuns')
            : t('automationMute.result.stillRan')
        }
        entries={muted.stillRan}
        testId={`${testId}-still-ran`}
      />
      <MuteEntryList
        title={t(
          muted.state === 'planned'
            ? 'automationMute.box.alsoLifts'
            : 'automationMute.result.alsoLifted',
        )}
        entries={muted.alsoLifted}
        unread={muted.liftsUnread}
        testId={`${testId}-also-lifted`}
      />
    </section>
  );
};
