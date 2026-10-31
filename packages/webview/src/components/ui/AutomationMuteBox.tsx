import React, { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { BellOff } from 'lucide-react';
import type {
  MuteLiftsUnread,
  MutedAutomationAlsoLifted,
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
const KIND_KEYS: Readonly<
  Record<MutedAutomationEntry['kind'] | MutedAutomationAlsoLifted['kind'], string>
> = {
  flow: 'automationMute.kind.flow',
  trigger: 'automationMute.kind.trigger',
  process: 'automationMute.kind.process',
  workflowRule: 'automationMute.kind.workflowRule',
  validationRule: 'automationMute.kind.validationRule',
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
  /** What the list is of, said above it: what is silenced, still runs, or is lifted beside. */
  title: string;
  entries:
    | ReadonlyArray<
        MutedAutomationSilenced | MutedAutomationStillRunning | MutedAutomationAlsoLifted
      >
    | undefined;
  /** What could not be read of what the sets lift beside, said under the list. */
  unread?: readonly MuteLiftsUnread[] | undefined;
  testId: string;
}

/**
 * The automations a mute silences, leaves running or lifts beside, one a
 * line: the object, the flow, process, rule, trigger or validation rule by
 * its kind and name, then the bypass that silences it, why it still runs, or
 * the permission and the set that lift it — on the trap org, the set
 * assigned for a flow's bypass let through a contact two validation rules
 * refused, unsaid —, and what of that could not be read.
 */
export const MuteEntryList: React.FC<MuteEntryListProps> = ({
  title,
  entries = [],
  unread = [],
  testId,
}) => {
  const { t } = useTranslation();
  if (entries.length === 0 && unread.length === 0) return null;
  return (
    <div data-testid={testId}>
      {entries.length > 0 && <p>{title}</p>}
      <ul className="ml-3 flex list-disc flex-col gap-0.5" hidden={entries.length === 0}>
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
              {'permissionSet' in entry
                ? t('automationMute.liftedBy', {
                    permission: entry.permission,
                    set: entry.permissionSet,
                  })
                : 'permission' in entry
                  ? t('automationMute.bypass', { permission: entry.permission })
                  : t(WHY_KEYS[entry.why])}
            </span>
          </li>
        ))}
      </ul>
      {unread.map((u) => (
        <p key={`${u.part}-${u.permissionSet}`} className="text-status-warning">
          {u.permissionSet
            ? t('automationMute.liftsUnread.grants', { set: u.permissionSet })
            : t('automationMute.liftsUnread.validationRules')}
        </p>
      ))}
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
      className={`flex flex-col gap-1 rounded-sm border border-subtle bg-surface-1 p-2 text-[11px] text-text-primary ${className ?? ''}`}
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
            <MuteEntryList
              title={t('automationMute.box.alsoLifts')}
              entries={offer.alsoLifts}
              unread={offer.liftsUnread}
              testId={`${testId}-also-lifts`}
            />
          </>
        )}
        <p className="text-text-secondary">{t('automationMute.box.never')}</p>
      </div>
    </div>
  );
};
