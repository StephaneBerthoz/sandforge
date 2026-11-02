import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  emailSendersOf,
  removalStepsWrites,
  stillRunningOf,
  type EmailSender,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type MutePlan,
  type RunDeliverability,
} from '@sandforge/shared';
import { formatNumber } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';

/**
 * The parts of the org's automation that send emails: one the read was
 * refused whole lists nothing it sends, which is not the same as sending
 * nothing, and the extension asks for them all the same.
 */
const SENDING_PARTS: ReadonlySet<ForgeTargetAutomation['unread'][number]['part']> = new Set([
  'flows',
  'processes',
  'workflowRules',
]);

/** How a sender of emails is named, by its kind. */
const SENDER_KEYS: Readonly<Record<EmailSender['kind'], string>> = {
  flow: 'checkpoint.preview.deliverability.sender.flow',
  process: 'checkpoint.preview.deliverability.sender.process',
  workflowRule: 'checkpoint.preview.deliverability.sender.workflowRule',
  assignmentRule: 'checkpoint.preview.deliverability.sender.assignmentRule',
};

/** The senders a line names before it says how many more there are. */
const SENDERS_NAMED = 10;

/**
 * What the preview makes of the emails a rewind's writes make the org send:
 *
 * - `asks`: the org delivers them all (All email), or would not say, and
 *   something that still runs sends some — accepted with their own box,
 *   which the automation's never stands for;
 * - `withheld`: the org delivers none of them (System email only, or No
 *   access), said in a line and asked about nowhere;
 * - `quiet`: what sends them tests a bypass the mute holds, so a muted
 *   rewind sends none and asks nothing;
 * - `none`: nothing sends, and nothing is said.
 */
export interface RewindEmailsAsk {
  verdict: 'asks' | 'withheld' | 'quiet' | 'none';
  /** What the extension named as sending, less what the mute keeps quiet. */
  senders: EmailSender[];
  /** What could not be read of the org's automation may send some besides. */
  unlisted: boolean;
}

/** One sender, as its object, kind and name tell it apart. */
function senderKey(sender: EmailSender): string {
  return `${sender.objectApiName}\u0000${sender.kind}\u0000${sender.name}`;
}

/**
 * The senders the mute's plan keeps quiet, among those that fire on the
 * rewind's writes: planned as the extension plans them (`stillRunningOf`,
 * `emailSendersOf`), the plan's bypasses taken as held. Only those are taken
 * off what the extension named: a sender the page cannot place stays asked
 * about.
 */
function quietedBy(
  automation: ForgeTargetAutomation,
  plan: Pick<MutePlan, 'assign'>,
  steps: ForgeRemovalSteps,
): ReadonlySet<string> {
  const writes = removalStepsWrites(steps);
  const unmuted = emailSendersOf(stillRunningOf(automation, undefined, writes), { writes });
  const muted = new Set(
    emailSendersOf(stillRunningOf(automation, plan, writes), { writes }).map(senderKey),
  );
  return new Set(unmuted.map(senderKey).filter((key) => !muted.has(key)));
}

/**
 * What the preview asks of the emails a rewind's writes make the org send,
 * from what the extension read: whether the org delivers them, and what
 * still runs that sends them ({@link RewindEmailsAsk}). A preview whose
 * refusal is the emails' (`EMAILS_DELIVERED`) asks whatever else it says.
 *
 * @param input.mute - The mute's plan, when the rewind is to mute: what it
 *   keeps quiet sends nothing.
 */
export function rewindEmailsAskOf(input: {
  deliverability: RunDeliverability | undefined;
  automation: ForgeTargetAutomation | undefined;
  steps: ForgeRemovalSteps;
  mute?: Pick<MutePlan, 'assign'> | undefined;
  refused?: boolean;
}): RewindEmailsAsk {
  const { deliverability, automation } = input;
  const named = deliverability?.senders ?? [];
  // A preview that names no sender and asks all the same asks for what
  // could not be read.
  const unlisted =
    (deliverability !== undefined && named.length === 0) ||
    (automation?.unread.some(({ part }) => SENDING_PARTS.has(part)) ?? false);
  if (input.refused === true) return { verdict: 'asks', senders: [...named], unlisted };
  if (!deliverability) return { verdict: 'none', senders: [], unlisted: false };
  const { reading } = deliverability;
  if ('level' in reading && reading.level === 'withheld') {
    return { verdict: 'withheld', senders: [...named], unlisted };
  }
  const quieted =
    input.mute && automation ? quietedBy(automation, input.mute, input.steps) : new Set<string>();
  const senders = named.filter((sender) => !quieted.has(senderKey(sender)));
  return {
    verdict: senders.length > 0 || unlisted ? 'asks' : 'quiet',
    senders,
    unlisted,
  };
}

/** Props for {@link RewindDeliverability}. */
export interface RewindDeliverabilityProps {
  ask: RewindEmailsAsk;
  /** Whether the org delivers them, as the extension read it; absent when it was not read. */
  reading: RunDeliverability['reading'] | undefined;
  orgName: string;
  testId: string;
}

/**
 * What a rewind's preview says of the emails its writes make the org send,
 * in the words of what the extension read: on All email, or an org that
 * would not say — its reason given —, who sends them, named, and where they
 * go: to the addresses the records hold, as a rewind writes back the org's
 * own values and never puts them under `.invalid`, to the records' owners
 * and to the addresses an alert names. On System email only or No access,
 * one line says none goes out; muted, one line says nothing left sends.
 */
export const RewindDeliverability: React.FC<RewindDeliverabilityProps> = ({
  ask,
  reading,
  orgName,
  testId,
}) => {
  const { t } = useTranslation();
  if (ask.verdict === 'none') return null;
  if (ask.verdict === 'withheld') {
    return (
      <p data-testid={`${testId}-withheld`}>
        {t('checkpoint.preview.deliverability.withheld', { org: orgName })}
      </p>
    );
  }
  if (ask.verdict === 'quiet') {
    return (
      <p data-testid={`${testId}-quiet`}>
        {t('checkpoint.preview.deliverability.quiet', { org: orgName })}
      </p>
    );
  }
  const shown = ask.senders.slice(0, SENDERS_NAMED);
  const more = ask.senders.length - shown.length;
  const names = [
    ...shown.map((sender) => {
      const named = t(SENDER_KEYS[sender.kind], {
        name: sender.name,
        object: sender.objectApiName,
      });
      return sender.why === 'notRead'
        ? t('checkpoint.preview.deliverability.notRead', { sender: named })
        : named;
    }),
    ...(more > 0
      ? [
          t('checkpoint.preview.deliverability.moreSenders', {
            count: more,
            formatted: formatNumber(more),
          }),
        ]
      : []),
    ...(ask.unlisted ? [t('checkpoint.preview.deliverability.unlisted')] : []),
  ];
  const senders = listWords(names, t);
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <p data-testid={`${testId}-reading`}>
        {reading !== undefined && 'unread' in reading
          ? t('checkpoint.preview.deliverability.unread', {
              org: orgName,
              reason: reading.unread,
              senders,
            })
          : t('checkpoint.preview.deliverability.all', { org: orgName, senders })}
      </p>
      <p data-testid={`${testId}-addresses`}>
        {t('checkpoint.preview.deliverability.addresses', { org: orgName })}
      </p>
    </div>
  );
};
