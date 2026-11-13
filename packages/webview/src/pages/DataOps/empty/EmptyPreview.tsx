import React, { useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  firedOnRemovalStepsOf,
  formatDurationSec,
  mutePlanOf,
  removalStepsBypassesOf,
  removalStepsWrites,
  type CheckpointEmails,
  type DataOpsEmptyBudgetCheck,
  type DataOpsEmptyCounted,
  type DataOpsEmptyLeftOut,
  type DataOpsEmptyLikelyRefusalCode,
  type DataOpsEmptyPreviewResponse,
} from '@sandforge/shared';
import { useFocusOnChange } from '../../../hooks/useFocusOnChange';
import { Button } from '../../../components/ui/Button';
import { AutomationMuteBox } from '../../../components/ui/AutomationMuteBox';
import { CheckpointFirstEstimate } from '../../../components/ui/CheckpointFirstOption';
import {
  DELETE_WHEN_KEYS,
  RemovalAutomationView,
  type RemovalAutomationShown,
  type RemovalAutomationWords,
} from '../../Forge/ForgeRemovalAutomation';
import { RunDeliverabilityLine } from '../../shared/RunDeliverabilityLine';
import { dateTimeFormat, formatNumber, formatStoredDate } from '../../../utils/formatters';
import {
  asksBox,
  countShown,
  emptySize,
  holdingRefusals,
  holdsRecords,
  leftOutByReason,
  type EmptyBox,
  type EmptyBoxes,
} from './emptyFacts';

/** What `dataops:empty:preview` answers. */
export type EmptyPreviewAnswer = DataOpsEmptyPreviewResponse['payload'];

/** Why a scope leaves an object out, in the page's words. */
export const LEFT_OUT_KEYS: Readonly<Record<DataOpsEmptyLeftOut['reason'], string>> = {
  excludedByUser: 'dataopsEmpty.reason.excludedByUser',
  notFound: 'dataopsEmpty.reason.notFound',
  chatter: 'dataopsEmpty.reason.chatter',
  history: 'dataopsEmpty.reason.history',
  sharing: 'dataopsEmpty.reason.sharing',
  changeEvent: 'dataopsEmpty.reason.changeEvent',
  unsupportedKind: 'dataopsEmpty.reason.unsupportedKind',
  customSetting: 'dataopsEmpty.reason.customSetting',
  files: 'dataopsEmpty.reason.files',
  managedPackage: 'dataopsEmpty.reason.managedPackage',
  documents: 'dataopsEmpty.reason.documents',
  heldWithFiles: 'dataopsEmpty.reason.heldWithFiles',
  setup: 'dataopsEmpty.reason.setup',
  platformCreated: 'dataopsEmpty.reason.platformCreated',
  metadata: 'dataopsEmpty.reason.metadata',
  notDeletable: 'dataopsEmpty.reason.notDeletable',
  notDescribed: 'dataopsEmpty.reason.notDescribed',
  noRecycleBin: 'dataopsEmpty.reason.noRecycleBin',
  notForGood: 'dataopsEmpty.reason.notForGood',
};

/** What the org will likely refuse, or what the run does first so that it does not. */
const LIKELY_KEYS: Readonly<Record<DataOpsEmptyLikelyRefusalCode, string>> = {
  activatedOrder: 'dataopsEmpty.preview.likely.activatedOrder',
  standardPriceBook: 'dataopsEmpty.preview.likely.standardPriceBook',
  directContactRelation: 'dataopsEmpty.preview.likely.directContactRelation',
  personAccountContact: 'dataopsEmpty.preview.likely.personAccountContact',
};

/** Why the user is not proven to see every record of an object. */
const UNSEEN_KEYS: Readonly<Record<string, string>> = {
  noViewAll: 'dataopsEmpty.preview.access.why.noViewAll',
  noModifyAll: 'dataopsEmpty.preview.access.why.noModifyAll',
  activities: 'dataopsEmpty.preview.access.why.activities',
  catalog: 'dataopsEmpty.preview.access.why.catalog',
  filesNotProven: 'dataopsEmpty.preview.access.why.files',
  settingNotProven: 'dataopsEmpty.preview.access.why.setting',
  parentNotSeen: 'dataopsEmpty.preview.access.why.parent',
  permissionsUnread: 'dataopsEmpty.preview.access.why.unread',
};

/** The section of what the org runs as an emptying deletes, in the emptying's words. */
const AUTOMATION_WORDS: RemovalAutomationWords = {
  title: 'dataopsEmpty.automation.title',
  loading: 'dataopsEmpty.automation.loading',
  intro: 'dataopsEmpty.automation.intro',
  none: 'dataopsEmpty.automation.none',
  error: 'dataopsEmpty.automation.error',
};

/** How each daily email limit is named, as the other DataOps acts name it. */
const LIMIT_KEYS: Readonly<Record<CheckpointEmails['limit'], string>> = {
  SingleEmail: 'dataops.automation.limit.single',
  DailyWorkflowEmails: 'dataops.automation.limit.workflow',
};

/** A count, as the page writes it: a number, a bound on one, or that the org gave none. */
export function countWords(t: TFunction, counted: DataOpsEmptyCounted): string {
  const shown = countShown(counted);
  switch (shown.kind) {
    case 'unread':
      return t('dataopsEmpty.count.unread');
    case 'atMost':
      return t('dataopsEmpty.count.atMost', { formatted: formatNumber(shown.records) });
    case 'atLeast':
      return t('dataopsEmpty.count.atLeast', { formatted: formatNumber(shown.records) });
    default:
      return formatNumber(shown.records);
  }
}

/** "48,213 records", in the page's language, the count its plural. */
export function recordsWords(t: TFunction, records: number): string {
  return t('dataopsEmpty.size.records', { count: records, formatted: formatNumber(records) });
}

/** "37 objects", in the page's language. */
export function objectsWords(t: TFunction, objects: number): string {
  return t('dataopsEmpty.size.objects', { count: objects, formatted: formatNumber(objects) });
}

/**
 * What the button that empties says: the act and its size — "Delete 48,213
 * records from 37 objects" —, "at least" when objects the org would not
 * count leave the sum short.
 */
export function emptyButtonWords(
  t: TFunction,
  answer: Pick<EmptyPreviewAnswer, 'preview'>,
): string {
  const size = emptySize(answer.preview);
  return t(size.atLeast ? 'dataopsEmpty.size.buttonAtLeast' : 'dataopsEmpty.size.button', {
    records: recordsWords(t, size.records),
    objects: objectsWords(t, size.objects),
  });
}

/** The words of a count of calls against the day, by what is counted. */
const BUDGET_KEYS = {
  requests: {
    read: 'dataopsEmpty.preview.cost.requests',
    unread: 'dataopsEmpty.preview.cost.requestsUnread',
  },
  batches: {
    read: 'dataopsEmpty.preview.cost.batches',
    unread: 'dataopsEmpty.preview.cost.batchesUnread',
  },
} as const;

/** A count of calls against what the org has left of its day, as a line. */
function budgetLine(
  t: TFunction,
  check: DataOpsEmptyBudgetCheck,
  org: string,
  kind: keyof typeof BUDGET_KEYS,
): string {
  const estimate = formatNumber(check.estimate);
  if (check.verdict === 'unread') {
    return t(BUDGET_KEYS[kind].unread, {
      estimate,
      org,
      reason: check.unread,
    });
  }
  return t(BUDGET_KEYS[kind].read, {
    estimate,
    remaining: formatNumber(check.remaining),
    max: formatNumber(check.max),
  });
}

/** Props for {@link EmptyPreview}. */
export interface EmptyPreviewProps {
  orgId: string;
  orgName: string;
  answer: EmptyPreviewAnswer;
  boxes: EmptyBoxes;
  onBoxChange: (box: EmptyBox, checked: boolean) => void;
  /** Whether the preview was asked with the mute: ticking it asks it again. */
  muted: boolean;
  onMuteChange: (checked: boolean) => void;
  /** Read again: what fires, the counts and the cost, as they stand now. */
  onReadAgain: () => void;
  /** A read is on its way: what is shown is the last one's. */
  reading: boolean;
  /** The options changed since it was read: it no longer says what a run would do. */
  stale: boolean;
  /** Open the confirmation. */
  onEmpty: () => void;
  /** Take up the org's last emptying, stopped part way. */
  onResume: (runId: string) => void;
  /** Undo the org's last emptying, stopped part way. */
  onUndoOpen: (runId: string) => void;
  /** Something of the emptying is under way: no act is offered meanwhile. */
  busy: boolean;
}

/**
 * The dry run of an emptying, said in full before any button deletes: for
 * each object, in the order the run takes it, its records and how they go;
 * what other objects lose along with them; what the org will likely refuse
 * and what blocks the run; what goes before the record it names and what no
 * Undo would bring back; what fires as the records go, its emails and the
 * box that mutes it; what it costs against what the org has left today, and
 * the recycle bin it fills; what the user does not see; what is left out;
 * and what stops it now. The button that empties is drawn only under all of
 * that, and only while nothing holds it.
 */
export const EmptyPreview: React.FC<EmptyPreviewProps> = ({
  orgId,
  orgName,
  answer,
  boxes,
  onBoxChange,
  muted,
  onMuteChange,
  onReadAgain,
  reading,
  stale,
  onEmpty,
  onResume,
  onUndoOpen,
  busy,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusOnChange(headingRef, answer.previewId, { onMount: true });
  const { preview } = answer;
  const hard = preview.deleteMode === 'hard';
  const org = orgName;

  const automationAnswer = answer.automation;
  const automation = automationAnswer.automation;
  const shown: RemovalAutomationShown | undefined = useMemo(
    () =>
      automation
        ? {
            automation,
            entries: firedOnRemovalStepsOf(automation, automationAnswer.steps).map((fired) => ({
              part: fired.step,
              fired,
              whyKey:
                fired.step === 'delete'
                  ? DELETE_WHEN_KEYS[fired.when]
                  : 'dataopsEmpty.automation.drafted',
            })),
            bypasses: removalStepsBypassesOf(automation, automationAnswer.steps),
          }
        : undefined,
    [automation, automationAnswer.steps],
  );
  const planned = automation
    ? mutePlanOf(automation, removalStepsWrites(automationAnswer.steps))
    : null;
  const asksEmails =
    asksBox(answer.refusals, 'acceptEmails') ||
    (automationAnswer.emailsAsk && automationAnswer.deliverability !== undefined);
  const holding = holdingRefusals(answer.refusals, boxes);
  const size = emptySize(preview);
  const nothing = size.records === 0 && !size.atLeast;
  const readAt = formatStoredDate(
    answer.readAt,
    dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format,
  );
  const costPasses = new Map(preview.cost.passes.map((pass) => [pass.objectApiName, pass]));
  const along = preview.along.filter((object) => holdsRecords(object.records));
  const likely = preview.refusals.filter((refusal) => holdsRecords(refusal.records));
  const blockers = preview.blockers.filter((blocker) => holdsRecords(blocker.records));
  const undoLost = preview.undoLost.filter((lost) => holdsRecords(lost.records));
  const unseen = answer.access.kind === 'perObject' ? answer.access.unseen : [];
  const canEmpty = !stale && !reading && !busy && holding.length === 0 && !nothing;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={reading || undefined}
      className="flex flex-col gap-3 rounded-lg border border-status-warning p-3 text-xs text-text-primary"
      data-testid="empty-preview"
    >
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-text-primary focus:outline-hidden"
      >
        {preview.mode === 'org'
          ? t('dataopsEmpty.preview.titleOrg', { org })
          : t('dataopsEmpty.preview.titleObjects', { org })}
      </h3>

      <p data-testid="empty-preview-summary">
        {nothing
          ? t('dataopsEmpty.preview.nothing', { org })
          : t(hard ? 'dataopsEmpty.preview.summaryHard' : 'dataopsEmpty.preview.summary', {
              records: recordsWords(t, size.records),
              objects: objectsWords(t, size.objects),
            })}{' '}
        {readAt !== null && t('dataopsEmpty.preview.readAt', { at: readAt })}
      </p>
      {preview.total.uncounted.length > 0 && (
        <p className="text-status-warning" data-testid="empty-preview-uncounted">
          {t('dataopsEmpty.preview.uncounted', { objects: preview.total.uncounted.join(', ') })}
        </p>
      )}
      {hard && (
        <p className="font-medium text-status-error" data-testid="empty-preview-hard">
          {t('dataopsEmpty.preview.hard')}
        </p>
      )}
      {preview.stopped && (
        <p role="status" className="text-status-warning" data-testid="empty-preview-stopped">
          {t('dataopsEmpty.preview.stopped')}
        </p>
      )}
      {stale && (
        <p role="status" className="text-status-warning" data-testid="empty-preview-stale">
          {t('dataopsEmpty.preview.stale')}
        </p>
      )}

      {answer.openRun && (
        <div
          className="flex flex-col gap-2 rounded-sm border border-status-warning p-2"
          data-testid="empty-preview-open-run"
        >
          <p>
            {t('dataopsEmpty.preview.openRun', {
              org,
              runId: answer.openRun.runId,
              at:
                formatStoredDate(
                  answer.openRun.startedAt,
                  dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format,
                ) ?? t('common.dateUnknown'),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => answer.openRun && onResume(answer.openRun.runId)}
              disabled={busy}
              data-testid="empty-preview-resume"
            >
              {t('dataopsEmpty.preview.resume')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => answer.openRun && onUndoOpen(answer.openRun.runId)}
              disabled={busy}
              data-testid="empty-preview-undo-open"
            >
              {t('dataopsEmpty.preview.undoOpen')}
            </Button>
          </div>
        </div>
      )}

      {preview.passes.length > 0 && (
        <div
          role="region"
          aria-label={t('dataopsEmpty.preview.passes')}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a whole org's objects scroll, and none of the cells is a control to reach them by: the region takes the focus itself, so the keyboard can scroll it (axe scrollable-region-focusable).
          tabIndex={0}
          className="max-h-80 overflow-auto rounded-sm border border-subtle focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)"
        >
          <table className="w-full border-collapse text-left" data-testid="empty-preview-passes">
            <caption className="px-2 py-1 text-left font-medium">
              {t('dataopsEmpty.preview.passes')}
            </caption>
            <thead>
              <tr className="border-b border-subtle">
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('dataopsEmpty.preview.col.object')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('dataopsEmpty.preview.col.records')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('dataopsEmpty.preview.col.sent')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('dataopsEmpty.preview.col.how')}
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.passes.map((pass) => {
                const cost = costPasses.get(pass.objectApiName);
                return (
                  <tr
                    key={pass.objectApiName}
                    className="border-b border-subtle last:border-b-0"
                    data-testid={`empty-preview-pass-${pass.objectApiName}`}
                  >
                    <th scope="row" className="px-2 py-1 font-mono font-normal">
                      {pass.objectApiName}
                    </th>
                    <td className="px-2 py-1 text-right">{countWords(t, pass.records)}</td>
                    <td className="px-2 py-1 text-right">{countWords(t, pass.sent)}</td>
                    <td className="px-2 py-1">
                      {cost?.notSent
                        ? t('dataopsEmpty.preview.how.notSent')
                        : cost
                          ? [
                              cost.restCalls > 0
                                ? t('dataopsEmpty.preview.how.calls', {
                                    count: cost.restCalls,
                                    formatted: formatNumber(cost.restCalls),
                                  })
                                : null,
                              cost.jobs.length > 0
                                ? t('dataopsEmpty.preview.how.jobs', {
                                    count: cost.jobs.length,
                                    formatted: formatNumber(cost.jobs.length),
                                  })
                                : null,
                            ]
                              .filter((part): part is string => part !== null)
                              .join(', ')
                          : ''}
                      {pass.archived && holdsRecords(pass.archived) && (
                        <span className="block text-text-secondary">
                          {t('dataopsEmpty.preview.archived', {
                            records: countWords(t, pass.archived),
                          })}
                        </span>
                      )}
                      {pass.kept && holdsRecords(pass.kept) && (
                        <span className="block text-text-secondary">
                          {t('dataopsEmpty.preview.kept', { records: countWords(t, pass.kept) })}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {along.length > 0 && (
        <div data-testid="empty-preview-along">
          <p className="font-medium">{t('dataopsEmpty.preview.along')}</p>
          <ul className="ml-4 list-disc">
            {along.map((object) => (
              <li
                key={object.objectApiName}
                data-testid={`empty-preview-along-${object.objectApiName}`}
              >
                {t('dataopsEmpty.preview.alongLine', {
                  records: countWords(t, object.records),
                  object: object.objectApiName,
                  // Field and object names, the same in every language.
                  via: object.via.map((route) => `${route.field} → ${route.parent}`).join(', '),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {likely.length > 0 && (
        <div data-testid="empty-preview-likely">
          <p className="font-medium">{t('dataopsEmpty.preview.likelyTitle')}</p>
          <ul className="ml-4 list-disc">
            {likely.map((refusal) => (
              <li
                key={`${refusal.code}-${refusal.objectApiName}`}
                data-testid={`empty-preview-likely-${refusal.code}`}
              >
                {t(LIKELY_KEYS[refusal.code], {
                  records: countWords(t, refusal.records),
                  object: refusal.objectApiName,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blockers.length > 0 && (
        <div className="text-status-error" data-testid="empty-preview-blockers">
          <p className="font-medium">{t('dataopsEmpty.preview.blockersTitle')}</p>
          <ul className="ml-4 list-disc">
            {blockers.map((blocker) => (
              <li
                key={`${blocker.objectApiName}.${blocker.field}`}
                data-testid={`empty-preview-blocker-${blocker.objectApiName}`}
              >
                {t('dataopsEmpty.preview.blocker', {
                  records: countWords(t, blocker.records),
                  object: blocker.objectApiName,
                  field: blocker.field,
                  parent: blocker.parent,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.beforeParent.length > 0 && (
        <div data-testid="empty-preview-before-parent">
          <p className="font-medium">{t('dataopsEmpty.preview.beforeParentTitle')}</p>
          <ul className="ml-4 list-disc">
            {preview.beforeParent.map((pair) => (
              <li key={`${pair.objectApiName}.${pair.field}`}>
                {t(
                  pair.reason === 'customPrices'
                    ? 'dataopsEmpty.preview.beforeParentPrices'
                    : 'dataopsEmpty.preview.beforeParentRestricted',
                  { object: pair.objectApiName, field: pair.field, parent: pair.parent },
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {undoLost.length > 0 && (
        <div className="text-status-warning" data-testid="empty-preview-undo-lost">
          <p className="font-medium">{t('dataopsEmpty.preview.undoLostTitle')}</p>
          <ul className="ml-4 list-disc">
            {undoLost.map((lost) => (
              <li key={`${lost.objectApiName}.${lost.field}`}>
                {t('dataopsEmpty.preview.undoLost', {
                  records: countWords(t, lost.records),
                  object: lost.objectApiName,
                  parent: lost.parent,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {asksBox(answer.refusals, 'acceptNoUndo') && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={boxes.acceptNoUndo}
            onChange={(e) => onBoxChange('acceptNoUndo', e.target.checked)}
            data-testid="empty-preview-accept-no-undo"
          />
          <span>{t('dataopsEmpty.preview.acceptNoUndo')}</span>
        </label>
      )}

      <RemovalAutomationView
        testId="empty-automation"
        org={org}
        targetOrgId={orgId}
        words={AUTOMATION_WORDS}
        shown={shown}
        error={automationAnswer.automationUnread ?? null}
        reading={reading}
        onReadAgain={onReadAgain}
        after={
          <>
            <AutomationMuteBox
              offer={planned}
              checked={muted}
              onChange={onMuteChange}
              org={org}
              testId="empty-automation-mute"
            />
            {automationAnswer.emails.map((check) => (
              <p
                key={check.limit}
                className={check.verdict === 'exceeds' ? 'text-status-warning' : undefined}
                data-testid={`empty-automation-emails-${check.limit}`}
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
            {automationAnswer.deliverability && (
              <RunDeliverabilityLine
                reading={automationAnswer.deliverability.reading}
                senders={automationAnswer.deliverability.senders}
                unlisted={automationAnswer.deliverability.sendersUnread !== undefined}
                org={org}
                testId="empty-automation-deliverability"
              />
            )}
            {asksEmails && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={boxes.acceptEmails}
                  onChange={(e) => onBoxChange('acceptEmails', e.target.checked)}
                  data-testid="empty-automation-accept-emails"
                />
                <span>{t('dataops.automation.acceptEmails', { org })}</span>
              </label>
            )}
          </>
        }
      />

      <div data-testid="empty-preview-cost">
        <p className="font-medium">{t('dataopsEmpty.preview.cost.title', { org })}</p>
        <ul className="ml-4 list-disc">
          <li
            className={preview.cost.api.verdict === 'exceeds' ? 'text-status-error' : undefined}
            data-testid="empty-preview-cost-requests"
          >
            {budgetLine(t, preview.cost.api, org, 'requests')}
          </li>
          {preview.cost.batches && (
            <li
              className={
                preview.cost.batches.verdict === 'exceeds' ? 'text-status-error' : undefined
              }
              data-testid="empty-preview-cost-batches"
            >
              {budgetLine(t, preview.cost.batches, org, 'batches')}
            </li>
          )}
          <li data-testid="empty-preview-cost-time">
            {t('dataopsEmpty.preview.cost.time', { time: formatDurationSec(preview.cost.seconds) })}
          </li>
          <li data-testid="empty-preview-cost-bin">
            {hard || preview.cost.binRecords === 0
              ? t('dataopsEmpty.preview.cost.binNone')
              : t('dataopsEmpty.preview.cost.bin', {
                  records: recordsWords(t, preview.cost.binRecords),
                })}
            {preview.cost.bin?.past && (
              <span className="block text-status-warning" data-testid="empty-preview-cost-bin-past">
                {t('dataopsEmpty.preview.cost.binPast', {
                  capacity: formatNumber(preview.cost.bin.documentedCapacity),
                  org,
                })}
              </span>
            )}
          </li>
        </ul>
      </div>

      {unseen.length > 0 && (
        <div data-testid="empty-preview-unseen">
          <p className="font-medium">{t('dataopsEmpty.preview.access.title')}</p>
          <ul className="ml-4 list-disc">
            {unseen.map((object) => (
              <li key={object.objectApiName}>
                <span className="font-mono">{object.objectApiName}</span>
                {' · '}
                {UNSEEN_KEYS[object.reason] ? t(UNSEEN_KEYS[object.reason]) : object.reason}
                {object.detail !== undefined && ` (${object.detail})`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {answer.peopleActive.unread && answer.peopleActive.unread.length > 0 && (
        <p className="text-status-warning" data-testid="empty-preview-people-unread">
          {t('dataopsEmpty.preview.peopleUnread', {
            objects: answer.peopleActive.unread.join('; '),
          })}
        </p>
      )}

      {preview.leftOut.length > 0 && (
        <details data-testid="empty-preview-left-out">
          <summary className="cursor-pointer font-medium">
            {t('dataopsEmpty.preview.leftOut', {
              count: preview.leftOut.length,
              formatted: formatNumber(preview.leftOut.length),
            })}
          </summary>
          <LeftOutList leftOut={preview.leftOut} testId="empty-preview-left-out" />
        </details>
      )}

      {answer.checkpoint && (
        <CheckpointFirstEstimate
          estimate={answer.checkpoint}
          lead={t('dataopsEmpty.preview.checkpointLead')}
          testId="empty-preview-checkpoint"
        />
      )}

      {holding.length > 0 && (
        <div role="alert" className="text-status-error" data-testid="empty-preview-holding">
          <p className="font-medium">{t('dataopsEmpty.preview.holding')}</p>
          <ul className="ml-4 list-disc">
            {holding.map((refusal) => (
              <li key={refusal.code} data-testid={`empty-preview-holding-${refusal.code}`}>
                {refusal.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!nothing && (
          <Button
            variant="danger"
            size="sm"
            onClick={onEmpty}
            disabled={!canEmpty}
            data-testid="empty-preview-empty"
          >
            {`${emptyButtonWords(t, answer)}…`}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={onReadAgain}
          loading={reading}
          disabled={busy}
          data-testid="empty-preview-again"
        >
          {t('dataopsEmpty.preview.again')}
        </Button>
      </div>
    </section>
  );
};

/** Props for {@link LeftOutList}. */
export interface LeftOutListProps {
  leftOut: readonly DataOpsEmptyLeftOut[];
  testId: string;
}

/** Objects left out, grouped by why, each group its reason then its objects. */
export const LeftOutList: React.FC<LeftOutListProps> = ({ leftOut, testId }) => {
  const { t } = useTranslation();
  return (
    <ul className="mt-1 ml-4 flex list-disc flex-col gap-1" data-testid={`${testId}-groups`}>
      {leftOutByReason(leftOut).map((group) => (
        <li key={group.reason} data-testid={`${testId}-${group.reason}`}>
          <span className="font-medium">{t(LEFT_OUT_KEYS[group.reason])}</span>
          {': '}
          <span className="font-mono">
            {group.objects
              .map((out) =>
                out.detail !== undefined
                  ? `${out.objectApiName} (${out.detail})`
                  : out.objectApiName,
              )
              .join(', ')}
          </span>
        </li>
      ))}
    </ul>
  );
};
