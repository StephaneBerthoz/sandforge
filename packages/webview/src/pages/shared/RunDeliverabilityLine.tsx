import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EmailDeliverability, EmailSender } from '@sandforge/shared';
import { cn } from '../../theme';
import { formatNumber } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';

/** How a sender of emails is named, by its kind. */
const SENDER_KEYS: Readonly<Record<EmailSender['kind'], string>> = {
  flow: 'runResults.deliverability.sender.flow',
  process: 'runResults.deliverability.sender.process',
  workflowRule: 'runResults.deliverability.sender.workflowRule',
  assignmentRule: 'runResults.deliverability.sender.assignmentRule',
};

/** What a sender's name is followed by, by why it counts; nothing for one with an email action. */
const SENDER_WHY_KEYS: Readonly<Partial<Record<EmailSender['why'], string>>> = {
  notRead: 'runResults.deliverability.notRead',
  assignment: 'runResults.deliverability.assignment',
};

/** The senders a line names before it says how many more there are. */
const SENDERS_NAMED = 10;

/** Props for {@link RunDeliverabilityLine}. */
export interface RunDeliverabilityLineProps {
  /** Whether the org delivers the emails of its automation, as read before the run. */
  reading: EmailDeliverability;
  /** What still runs that may send one as the run writes. */
  senders: readonly EmailSender[];
  /** A part of the automation that sends emails could not be read: it may send some besides. */
  unlisted: boolean;
  /** The target org, as the user knows it. */
  org: string;
  testId: string;
  className?: string;
}

/**
 * What a page says of a run's emails before it writes, from a read made ahead
 * of it (Forge's Review, Sync's Simulate): whether the org delivers them, what
 * still runs that sends them, where they go when they do, and that the run
 * reads the org again, as the setting can change before it starts. Said on
 * both pages before the question that, on All email, asks for them by name.
 */
export const RunDeliverabilityLine: React.FC<RunDeliverabilityLineProps> = ({
  reading,
  senders,
  unlisted,
  org,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const shown = senders.slice(0, SENDERS_NAMED);
  const more = senders.length - shown.length;
  const names = [
    ...shown.map((sender) => {
      const named = t(SENDER_KEYS[sender.kind], {
        name: sender.name,
        object: sender.objectApiName,
      });
      const why = SENDER_WHY_KEYS[sender.why];
      return why !== undefined ? t(why, { sender: named }) : named;
    }),
    ...(more > 0
      ? [
          t('runResults.deliverability.moreSenders', {
            count: more,
            formatted: formatNumber(more),
          }),
        ]
      : []),
    ...(unlisted ? [t('runResults.deliverability.unlisted')] : []),
  ];
  const named = listWords(names, t);
  const withheld = 'level' in reading && reading.level === 'withheld';
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid={testId}>
      <p data-testid={`${testId}-reading`}>
        {'unread' in reading
          ? t('runResults.deliverability.unread', {
              org,
              reason: reading.unread,
              senders: named,
            })
          : withheld
            ? t('runResults.deliverability.withheld', { org, senders: named })
            : t('runResults.deliverability.all', { org, senders: named })}
      </p>
      {!withheld && (
        <p data-testid={`${testId}-addresses`}>
          {t('runResults.deliverability.addresses', { org })}
        </p>
      )}
      <p data-testid={`${testId}-read-again`}>
        {t('runResults.deliverability.readAgain', { org })}
      </p>
    </div>
  );
};
