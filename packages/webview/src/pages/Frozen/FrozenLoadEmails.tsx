import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { FrozenLoadEmailCount, FrozenLoadEmailsInfo } from '@sandforge/shared';
import type { FrozenRun } from './frozenErrorWords';

/** Props for {@link FrozenLoadEmails}. */
export interface FrozenLoadEmailsProps {
  emails: FrozenLoadEmailsInfo;
  /** The org the load writes to, as the user knows it. */
  org: string;
  testId: string;
  /** What the run is to the person: a load, unless a replay of a checkpoint. */
  run?: FrozenRun;
}

/** The sentences that name the run, by what it is to the person; the rest say no run. */
const RUN_KEYS: Readonly<
  Record<FrozenRun, { refused: string; accepted: string; exceeded: string }>
> = {
  load: {
    refused: 'frozen.preview.emails.refused',
    accepted: 'frozen.preview.emails.accepted',
    exceeded: 'frozen.preview.emails.exceeded',
  },
  replay: {
    refused: 'frozen.replay.emails.refused',
    accepted: 'frozen.replay.emails.accepted',
    exceeded: 'frozen.replay.emails.exceeded',
  },
};

/** A daily email limit, in words. */
function limitWords(limit: FrozenLoadEmailCount['limit'], t: TFunction): string {
  return t(limit === 'SingleEmail' ? 'common.emailLimit.single' : 'common.emailLimit.workflow');
}

/** One limit's count, against what the org has left today when it said. */
function countWords(tally: FrozenLoadEmailCount, t: TFunction): string {
  const limit = limitWords(tally.limit, t);
  if (tally.verdict === 'unread') {
    return t('frozen.preview.emails.countUnread', { emails: tally.emails, limit });
  }
  return t(
    tally.verdict === 'exceeds'
      ? 'frozen.preview.emails.countExceeds'
      : 'frozen.preview.emails.count',
    { emails: tally.emails, limit, remaining: tally.remaining ?? 0, max: tally.max ?? 0 },
  );
}

/**
 * What a load's gate makes of the emails of what still runs as it writes, as
 * its preview reads them: whether the org delivers them and whether the load
 * would go on, what sends them, and how many against what the org has left
 * today. The load counted none and read nothing: its inserts fired the
 * target's flows, which emailed as a clone's do, and no page said it. A
 * replay of a checkpoint, which goes through the same load, says it of the
 * replay.
 */
export const FrozenLoadEmails: React.FC<FrozenLoadEmailsProps> = ({
  emails,
  org,
  testId,
  run = 'load',
}) => {
  const { t } = useTranslation();
  const keys = RUN_KEYS[run];
  const refused = emails.refused?.code;
  const senders = emails.deliverability?.senders ?? [];
  const verdict =
    refused === 'EMAILS_NOT_ACCEPTED'
      ? t(keys.refused, { org })
      : emails.verdict === 'asks'
        ? t(keys.accepted, { org })
        : emails.verdict === 'withheld'
          ? t('frozen.preview.emails.withheld', { org })
          : undefined;
  return (
    <div className="flex flex-col gap-1 text-[11px] text-text-primary" data-testid={testId}>
      {verdict !== undefined && <p data-testid={`${testId}-verdict`}>{verdict}</p>}
      {senders.length > 0 && (
        <p className="text-text-secondary" data-testid={`${testId}-senders`}>
          {t('frozen.preview.emails.senders', {
            senders: senders.map((sender) => `${sender.name} (${sender.objectApiName})`).join(', '),
          })}
        </p>
      )}
      {emails.counted.map((count) => (
        <p key={count.limit} data-testid={`${testId}-count-${count.limit}`}>
          {countWords(count, t)}
        </p>
      ))}
      {refused === 'FROZEN_EMAILS_EXCEEDED' && (
        <p data-testid={`${testId}-exceeded`}>{t(keys.exceeded, { org })}</p>
      )}
      {emails.uncounted !== undefined && (
        <p className="text-text-secondary" data-testid={`${testId}-uncounted`}>
          {t('frozen.preview.emails.uncounted', { why: emails.uncounted })}
        </p>
      )}
    </div>
  );
};
