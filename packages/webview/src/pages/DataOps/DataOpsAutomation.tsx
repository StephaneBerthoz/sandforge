import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  firedOnRemovalStepsOf,
  mutePlanOf,
  removalStepsBypassesOf,
  removalStepsWrites,
  type CheckpointEmails,
  type DataOpsAct,
  type DataOpsAutomationAnswer,
  type DataOpsAutomationObject,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { AutomationMuteBox } from '../../components/ui/AutomationMuteBox';
import {
  DELETE_WHEN_KEYS,
  RemovalAutomationView,
  type RemovalAutomationShown,
  type RemovalAutomationWords,
} from '../Forge/ForgeRemovalAutomation';
import { RunDeliverabilityLine } from '../shared/RunDeliverabilityLine';
import { formatNumber } from '../../utils/formatters';

/** How long the read may take: the extension gives up on what the org runs after 60 seconds. */
const READ_TIMEOUT_MS = 90_000;

/** What the act's question carries of the section: the emails let through, the mute asked for. */
export interface DataOpsAutomationAccord {
  acceptEmails: boolean;
  muteAutomation: boolean;
}

/** Nothing let through and nothing muted: where every act's question starts. */
export const NO_ACCORD: DataOpsAutomationAccord = { acceptEmails: false, muteAutomation: false };

/**
 * What an act's request carries once its confirmation was answered with the
 * section shown: what fires accepted — the confirmation listed it —, the
 * emails as their box says, the mute as its box says. Nothing without a
 * section: the act is then refused on what it fires.
 */
export function accordPayloadOf(accord: DataOpsAutomationAccord | undefined): {
  acceptAutomation?: true;
  acceptEmails?: true;
  muteAutomation?: true;
} {
  if (!accord) return {};
  return {
    acceptAutomation: true,
    ...(accord.acceptEmails ? { acceptEmails: true } : {}),
    ...(accord.muteAutomation ? { muteAutomation: true } : {}),
  };
}

/** The words of the section, per act, each taking `{{org}}`. */
const WORDS: Readonly<Record<DataOpsAct, RemovalAutomationWords>> = {
  masking: {
    title: 'dataops.automation.masking.title',
    loading: 'dataops.automation.loading',
    intro: 'dataops.automation.masking.intro',
    none: 'dataops.automation.masking.none',
    error: 'dataops.automation.error',
  },
  restore: {
    title: 'dataops.automation.restore.title',
    loading: 'dataops.automation.loading',
    intro: 'dataops.automation.restore.intro',
    none: 'dataops.automation.restore.none',
    error: 'dataops.automation.error',
  },
  cleanup: {
    title: 'dataops.automation.cleanup.title',
    loading: 'dataops.automation.loading',
    intro: 'dataops.automation.cleanup.intro',
    none: 'dataops.automation.cleanup.none',
    error: 'dataops.automation.error',
  },
};

/** How each daily email limit is named. */
const LIMIT_KEYS: Readonly<Record<CheckpointEmails['limit'], string>> = {
  SingleEmail: 'dataops.automation.limit.single',
  DailyWorkflowEmails: 'dataops.automation.limit.workflow',
};

/** The codes of what refuses the act whatever its question answers: past the day's emails, a mute refused. */
function refusesWhateverIsAnswered(code: string): boolean {
  return code === 'EMAILS_EXCEEDED' || code.startsWith('MUTE_');
}

/** Props for {@link DataOpsAutomation}. */
export interface DataOpsAutomationProps {
  /** The org written to, by its id in the registry. */
  orgId: string;
  /** The org written to, as the user knows it. */
  org: string;
  act: DataOpsAct;
  /** The records of each object the act writes. */
  objects: readonly DataOpsAutomationObject[];
  accord: DataOpsAutomationAccord;
  onAccordChange: (accord: DataOpsAutomationAccord) => void;
  /**
   * Told why the act's confirmation is held — the read on its way or failed,
   * emails the org delivers not let through, past the day's emails, a mute
   * that cannot be —, and undefined once it may go.
   */
  onHeld: (held: string | undefined) => void;
}

/**
 * What the org runs as a masking, a restore or a cleanup writes its records,
 * read as the act's confirmation opens and listed before the user answers it:
 * each flow, trigger, process and rule that fires, as the records are written
 * over, brought back from the recycle bin, or deleted; the box that mutes what
 * a bypass silences; the emails it makes the org send against what it has
 * left today; and, when the org delivers them, the box that lets them go,
 * which the acceptance of the automation never stands for. A DataOps write
 * fired all of it with no question asked, where Forge, Sync, Seed and Frozen
 * list it and offer the mute. Read again as the mute is ticked: what still
 * runs, and sends, changes with it. The confirmation waits for the read.
 */
export const DataOpsAutomation: React.FC<DataOpsAutomationProps> = ({
  orgId,
  org,
  act,
  objects,
  accord,
  onAccordChange,
  onHeld,
}) => {
  const { t } = useTranslation();
  const emailsId = useId();
  const read = useBridgeMutation<DataOpsAutomationAnswer>('dataops:automation', {
    responseType: 'dataops:automation:response',
    errorType: 'dataops:error',
    timeoutMs: READ_TIMEOUT_MS,
  });
  const { mutate } = read;
  // By value: a new list of the same counts reads nothing again.
  const counted = JSON.stringify(objects);
  const muting = accord.muteAutomation;
  const readAgain = useCallback(
    () =>
      mutate({
        orgId,
        act,
        objects: JSON.parse(counted) as DataOpsAutomationObject[],
        ...(muting ? { muteAutomation: true } : {}),
      }),
    [orgId, act, counted, muting, mutate],
  );
  useEffect(() => {
    readAgain();
  }, [readAgain]);
  // A new request clears the answer it waits on: the last one is shown meanwhile.
  const [lastRead, setLastRead] = useState<DataOpsAutomationAnswer | null>(null);
  useEffect(() => {
    setLastRead(null);
  }, [orgId, act, counted]);
  useEffect(() => {
    if (read.data) setLastRead(read.data);
  }, [read.data]);
  const answer = read.data ?? lastRead;

  const automation = answer?.automation;
  const shown: RemovalAutomationShown | undefined = useMemo(
    () =>
      answer && automation
        ? {
            automation,
            entries: firedOnRemovalStepsOf(automation, answer.steps).map((fired) => ({
              part: fired.step,
              fired,
              whyKey:
                fired.step === 'delete'
                  ? DELETE_WHEN_KEYS[fired.when]
                  : fired.step === 'bringBack'
                    ? 'dataops.automation.why.undelete'
                    : act === 'restore'
                      ? 'dataops.automation.why.restore'
                      : 'dataops.automation.why.mask',
            })),
            bypasses: removalStepsBypassesOf(automation, answer.steps),
          }
        : undefined,
    [answer, automation, act],
  );
  const planned =
    answer && automation ? mutePlanOf(automation, removalStepsWrites(answer.steps)) : null;
  const refused = (answer?.refusals ?? []).filter((r) => refusesWhateverIsAnswered(r.code));
  const asksEmails = answer?.emailsAsk === true && answer.deliverability !== undefined;
  const error =
    read.error ?? (answer?.automationUnread !== undefined ? answer.automationUnread : null);

  // Why the confirmation waits, by value: told up as it changes.
  const held =
    read.error !== null
      ? t('dataops.automation.held.failed', { org })
      : read.loading || !read.data
        ? t('dataops.automation.held.reading', { org })
        : refused.length > 0
          ? t('dataops.automation.held.refused')
          : asksEmails && !accord.acceptEmails
            ? t('dataops.automation.held.emails', { org })
            : undefined;
  useEffect(() => {
    onHeld(held);
  }, [held, onHeld]);
  useEffect(() => () => onHeld(undefined), [onHeld]);

  const setMute = useCallback(
    (checked: boolean) => onAccordChange({ ...accord, muteAutomation: checked }),
    [accord, onAccordChange],
  );

  return (
    <RemovalAutomationView
      testId={`dataops-automation-${act}`}
      org={org}
      targetOrgId={orgId}
      words={WORDS[act]}
      shown={shown}
      error={error}
      reading={read.loading}
      onReadAgain={readAgain}
      after={
        <>
          <AutomationMuteBox
            offer={planned}
            checked={accord.muteAutomation}
            onChange={setMute}
            org={org}
            testId={`dataops-automation-${act}-mute`}
          />
          {(answer?.emails ?? []).map((check) => (
            <p
              key={check.limit}
              className={check.verdict === 'exceeds' ? 'text-status-warning' : undefined}
              data-testid={`dataops-automation-${act}-emails-${check.limit}`}
            >
              {check.verdict === 'unread'
                ? t('dataops.automation.emailsUnread', {
                    count: check.emails,
                    formatted: formatNumber(check.emails),
                    limit: t(LIMIT_KEYS[check.limit]),
                    org,
                  })
                : t('dataops.automation.emails', {
                    count: check.emails,
                    formatted: formatNumber(check.emails),
                    limit: t(LIMIT_KEYS[check.limit]),
                    remaining: formatNumber(check.remaining ?? 0),
                    max: formatNumber(check.max ?? 0),
                    org,
                  })}
            </p>
          ))}
          {answer?.deliverability && (
            <RunDeliverabilityLine
              reading={answer.deliverability.reading}
              senders={answer.deliverability.senders}
              unlisted={answer.deliverability.sendersUnread !== undefined}
              org={org}
              testId={`dataops-automation-${act}-deliverability`}
            />
          )}
          {asksEmails && (
            <label className="flex items-start gap-2" htmlFor={emailsId}>
              <input
                id={emailsId}
                type="checkbox"
                className="mt-0.5"
                checked={accord.acceptEmails}
                onChange={(e) => onAccordChange({ ...accord, acceptEmails: e.target.checked })}
                data-testid={`dataops-automation-${act}-accept-emails`}
              />
              <span>{t('dataops.automation.acceptEmails', { org })}</span>
            </label>
          )}
          {refused.map((r) => (
            <p
              key={r.code}
              role="alert"
              className="text-status-error"
              data-testid={`dataops-automation-${act}-refused-${r.code}`}
            >
              {t('dataops.automation.refused', { reason: r.message })}
            </p>
          ))}
        </>
      }
    />
  );
};
