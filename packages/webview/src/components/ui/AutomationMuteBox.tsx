import React, { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { BellOff } from 'lucide-react';
import type {
  MutedAutomationEntry,
  MutedAutomationSilenced,
  MutedAutomationStillRunning,
  MuteStillRunsWhy,
} from '@sandforge/shared';
import { listWords } from '../../utils/listWords';
import { muteOffered, type MuteOffer } from '../../utils/muteOffer';

/**
 * What fires, by its kind, in the words the automation the pages list says
 * it in: kept in the box's own namespace, as a page that offers the box need
 * load no other.
 */
const KIND_KEYS: Readonly<Record<MutedAutomationEntry['kind'], string>> = {
  flow: 'automationMute.kind.flow',
  trigger: 'automationMute.kind.trigger',
  process: 'automationMute.kind.process',
  workflowRule: 'automationMute.kind.workflowRule',
};

/** Why an automation still runs for a run that mutes. */
const WHY_KEYS: Readonly<Record<MuteStillRunsWhy, string>> = {
  noBypass: 'automationMute.why.noBypass',
  managedPackage: 'automationMute.why.managedPackage',
  notRead: 'automationMute.why.notRead',
  noPermissionSet: 'automationMute.why.noPermissionSet',
};

/** Props for {@link MuteEntryList}. */
export interface MuteEntryListProps {
  /** What the list is of, said above it: what is silenced, or what still runs. */
  title: string;
  entries: ReadonlyArray<MutedAutomationSilenced | MutedAutomationStillRunning>;
  testId: string;
}

/**
 * The automations a mute silences or leaves running, one a line: the object,
 * the flow, process, rule or trigger by its kind and name, then the bypass
 * that silences it or why it still runs.
 */
export const MuteEntryList: React.FC<MuteEntryListProps> = ({ title, entries, testId }) => {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div data-testid={testId}>
      <p>{title}</p>
      <ul className="ml-3 flex list-disc flex-col gap-0.5">
        {entries.map((entry) => (
          <li
            key={`${entry.objectApiName}-${entry.kind}-${entry.name}`}
            data-testid={`${testId}-${entry.objectApiName}`}
          >
            <span className="font-mono">{entry.objectApiName}</span>
            {': '}
            {t(KIND_KEYS[entry.kind], { name: entry.name })}
            <span className="text-text-secondary">
              {' · '}
              {'permission' in entry
                ? t('automationMute.bypass', { permission: entry.permission })
                : t(WHY_KEYS[entry.why])}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Props for {@link AutomationMuteBox}. */
export interface AutomationMuteBoxProps {
  /**
   * What the mute would do; null while the page has no read, or when its
   * read found nothing the org's own bypass silences: no box then.
   */
  offer: MuteOffer | null | undefined;
  /** Whether the run is to mute: off unless ticked. */
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The org the run writes to, as the user knows it. */
  org: string;
  /** Test id of the box; its checkbox takes `-toggle`, its lists `-silenced` and `-still-runs`. */
  testId: string;
  className?: string;
}

/**
 * The option to mute the target's automation for one run, through the org's
 * own bypass, beside the automation the run would fire: off unless ticked,
 * and offered only when the read the page shows found something a bypass
 * silences — the permission sets it would assign to the user the run writes
 * as, for the run alone, what they silence, and what still runs and why. On a
 * page that reads none, the run's gate reads it as the run starts, and the
 * box says so.
 *
 * A box no longer offered — read again, the org found nothing to silence — is
 * unticked: a run sent from a page that showed no box mutes nothing.
 */
export const AutomationMuteBox: React.FC<AutomationMuteBoxProps> = ({
  offer,
  checked,
  onChange,
  org,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const detailsId = useId();
  const offered = muteOffered(offer);
  useEffect(() => {
    if (!offered && checked) onChange(false);
  }, [offered, checked, onChange]);
  if (!offered || offer == null) return null;
  const list = (items: readonly string[]): string => listWords(items, (key) => t(key));
  const sets = offer === 'atStart' ? [] : offer.assign.map((set) => set.permissionSet);
  return (
    <div
      data-testid={testId}
      className={`flex flex-col gap-1 rounded-sm border border-subtle bg-surface-2 p-2 text-[11px] text-text-primary ${className ?? ''}`}
    >
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={detailsId}
          data-testid={`${testId}-toggle`}
          className="mt-0.5"
        />
        <span className="flex items-start gap-1 font-medium">
          <BellOff size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          {t('automationMute.box.label')}
        </span>
      </label>
      <div id={detailsId} className="ml-5 flex flex-col gap-1">
        {offer === 'atStart' ? (
          <p data-testid={`${testId}-at-start`}>{t('automationMute.box.atStart', { org })}</p>
        ) : (
          <>
            <p data-testid={`${testId}-assigns`}>
              {t('automationMute.box.assigns', { count: sets.length, sets: list(sets), org })}
            </p>
            <MuteEntryList
              title={t('automationMute.box.silences')}
              entries={offer.silenced}
              testId={`${testId}-silenced`}
            />
            <MuteEntryList
              title={t('automationMute.box.stillRuns')}
              entries={offer.stillRuns}
              testId={`${testId}-still-runs`}
            />
          </>
        )}
        <p className="text-text-secondary">{t('automationMute.box.never')}</p>
      </div>
    </div>
  );
};
