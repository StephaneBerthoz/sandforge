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
 * run alone, those that user held already, whether they were taken back as
 * it ended — or when the lease that holds what is left ends —, what they
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
      {muted.state === 'muted' && muted.assigned.length > 0 && muted.held.length > 0 && (
        <p data-testid={`${testId}-held`}>
          {t('automationMute.result.held', { sets: list(muted.held) })}
        </p>
      )}
      {muted.released === true && muted.assigned.length > 0 && (
        <p data-testid={`${testId}-released`}>{t('automationMute.result.released')}</p>
      )}
      {muted.released === false && (
        <p data-testid={`${testId}-not-released`} className="text-status-warning">
          {leaseEnds !== null
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
    </section>
  );
};
