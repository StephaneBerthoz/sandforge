import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CheckCircle } from 'lucide-react';
import {
  blindedBy,
  firedOnRemovalStepsOf,
  mutedAutomationOf,
  mutePermissionsOf,
  mutePlanOf,
  removalStepsBypassesOf,
  removalStepsWrites,
} from '@sandforge/shared';
import type {
  CheckpointEmails,
  CheckpointPlanSelectionResponse,
  CheckpointPreviewResponse,
  CheckpointRefusalCode,
  ForgeRemovalStep,
  OrgCheckpoint,
  RewindDiff,
  RewindDiffObject,
  RewindSelectionLeftReason,
  RewindSelectionPlan,
  RewindUndoCannotReason,
  SalesforceOrg,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useFocusOnChange } from '../../hooks/useFocusOnChange';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { muteOffered, type MuteOffer } from '../../utils/muteOffer';
import { listWords } from '../../utils/listWords';
import {
  dateTimeFormat,
  formatDate,
  formatDurationSec,
  formatFileSize,
  formatNumber,
  formatStoredDate,
} from '../../utils/formatters';
import {
  DELETE_WHEN_KEYS,
  RemovalAutomationView,
  type RemovalAutomationShown,
  type RemovalAutomationWords,
} from '../Forge/ForgeRemovalAutomation';
import { roughSeconds, undoCannotReasonOf } from './checkpointFacts';
import {
  FILE_LINK_OBJECT,
  FILE_OBJECT,
  REWIND_UNDO_DAYS,
  cannotUndoLines,
  carriersOf,
  carriersTotal,
  deletedAgain,
  deletesPicked,
  filesBroughtBack,
  heldAsItWas,
  lastChangers,
  linkWrites,
  outsideLines,
  pickedDiff,
  recreateLines,
  rewindSteps,
  rewindTotals,
  rewindWrites,
  rowOf,
  selectionDiff,
  unseenChildren,
  type CannotUndoLine,
  type RewindRow,
} from './rewindPreviewFacts';

/** What `checkpoint:preview` answers. */
type PreviewAnswer = CheckpointPreviewResponse['payload'];

/** What `checkpoint:plan-selection` answers. */
type PlanAnswer = CheckpointPlanSelectionResponse['payload'];

/**
 * How long the ticks of the Rewind column rest before the plan of what is
 * ticked is asked for: made on this machine from the preview's reads, the
 * org not read, it comes back quickly, and a click is rarely the last one.
 */
const SELECTION_SETTLE_MS = 400;

/**
 * How long the plan of a selection is waited for: read from the preview's
 * folder and the checkpoint on this machine's disk, as long as the command
 * line waits for it.
 */
const PLAN_TIMEOUT_MS = 5 * 60_000;

/** What the preview says a rewind of some objects leaves of them, by reason. */
const SELECTION_LEFT_KEYS: Readonly<Record<RewindSelectionLeftReason, string>> = {
  needsUnpickedParent: 'checkpoint.preview.selection.left.needsUnpickedParent',
  heldByUnpicked: 'checkpoint.preview.selection.left.heldByUnpicked',
  outsideNotAccepted: 'checkpoint.preview.selection.left.outsideNotAccepted',
  holdsLeft: 'checkpoint.preview.selection.left.holdsLeft',
  keyTaken: 'checkpoint.preview.selection.left.keyTaken',
};

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * How long a preview is waited for. It reads the org, writing nothing: a
 * describe of each object again, a one-row check of each, what moved since
 * and the values of what moved, the automation on the objects a rewind
 * writes — about forty seconds on a Developer Edition, more on an org of
 * many objects or changes. It has no Stop and sends no progress.
 */
const PREVIEW_TIMEOUT_MS = 10 * 60_000;

/** One day. */
const DAY_MS = 86_400_000;

/**
 * The refusals the preview's boxes lift: what the org runs as a rewind
 * writes, the records Undo could not bring back, the records made again with
 * new Ids, and what the deletions take along out of the user's sight. Any
 * other the preview names — a SandForge run writing to the org, too few API
 * requests left today — holds the rewind whatever is ticked.
 */
const LIFTED_BY: Partial<
  Record<CheckpointRefusalCode, 'automation' | 'noUndo' | 'recreate' | 'unseen'>
> = {
  AUTOMATION: 'automation',
  NO_UNDO: 'noUndo',
  RECREATE: 'recreate',
  UNSEEN: 'unseen',
};

/** What the preview's automation section says, as a rewind writes. */
const AUTOMATION_WORDS: RemovalAutomationWords = {
  title: 'checkpoint.preview.automation.title',
  loading: 'checkpoint.preview.automation.loading',
  intro: 'checkpoint.preview.automation.intro',
  none: 'checkpoint.preview.automation.none',
  error: 'checkpoint.preview.automation.error',
};

/**
 * Why a step of a rewind other than its delete writes the record it fires on.
 * A rewind's delete sets an activated order created since back to Draft
 * first, as a removal does, and says so in the removal's words.
 */
const STEP_KEYS: Readonly<Record<Exclude<ForgeRemovalStep, 'delete'>, string>> = {
  bringBack: 'checkpoint.preview.automation.broughtBack',
  recreate: 'runRemoval.automation.recreated',
  giveBack: 'checkpoint.preview.automation.givenBack',
  setToDraft: 'runRemoval.automation.drafted',
};

/** What each class of an object's diff says beside the table, in the order the rewind acts. */
const DETAIL_LINES: ReadonlyArray<{ key: string; count: (object: RewindDiffObject) => number }> = [
  {
    key: 'checkpoint.preview.detail.deletedWhileTaken',
    count: (o) => o.toBringBack.deletedWhileTaken,
  },
  { key: 'checkpoint.preview.detail.withParent', count: (o) => o.toBringBack.withParent },
  // What brings them back: a record the checkpoint does not hold, back for a
  // moment and deleted again, in none of the numbers.
  { key: 'checkpoint.preview.detail.carriers', count: carriersOf },
  { key: 'checkpoint.preview.detail.fields', count: (o) => o.toGiveBack.fields },
  { key: 'checkpoint.preview.detail.clearedLookups', count: (o) => o.toGiveBack.clearedLookups },
  { key: 'checkpoint.preview.detail.broughtBackSince', count: (o) => o.toDelete.broughtBackSince },
  {
    key: 'checkpoint.preview.detail.comesBackWithParent',
    count: (o) => o.toDelete.comesBackWithParent,
  },
  { key: 'checkpoint.preview.detail.touched', count: (o) => o.touched },
  { key: 'checkpoint.preview.detail.unexplained', count: (o) => o.unexplained },
];

/** What the preview says a rewind cannot take back, by reason. */
const CANNOT_UNDO_KEYS: Readonly<Record<CannotUndoLine['reason'], string>> = {
  goneForGood: 'checkpoint.preview.cannot.goneForGood',
  deletedWithCreatedParent: 'checkpoint.preview.cannot.deletedWithCreatedParent',
  deletedWithParentOutside: 'checkpoint.preview.cannot.deletedWithParentOutside',
  convertedLead: 'checkpoint.preview.cannot.convertedLead',
  activatedContract: 'checkpoint.preview.cannot.activatedContract',
  newFileVersion: 'checkpoint.preview.cannot.newFileVersion',
  deletedByOther: 'checkpoint.preview.cannot.deletedByOther',
  outOfReach: 'checkpoint.preview.cannot.outOfReach',
};

/** What the preview says Undo could not bring back of what a rewind deletes, by reason. */
const UNDO_CANNOT_KEYS: Readonly<Record<RewindUndoCannotReason, string>> = {
  onlyWithParent: 'checkpoint.preview.undoCannot.line',
  deletedBeforeParent: 'checkpoint.preview.undoCannot.beforeParent',
};

/** What the user ticked in a preview, for the rewind it confirms. */
export interface RewindAcceptances {
  /** The preview the rewind acts on: what it confirmed that still differs. */
  previewId: string;
  acceptAutomation: boolean;
  acceptNoUndo: boolean;
  acceptRecreate: boolean;
  acceptOutside: boolean;
  /**
   * Delete records whose delete takes along what the user, read object by
   * object, is not proven to see (`RewindDiff.unseen`): unaccepted, such a
   * rewind is refused (`UNSEEN`), writing nothing.
   */
  acceptUnseen: boolean;
  /**
   * The objects the rewind is limited to, those ticked in the Rewind column,
   * in the checkpoint's reading order; absent when every object is, a rewind
   * of every object.
   */
  objects?: string[];
  /**
   * Mute the org's automation for the rewind, through its own bypass, as the
   * box beside what it fires was ticked; absent, nothing is muted.
   */
  muteAutomation?: true;
}

/** Props for {@link RewindPreview}. */
export interface RewindPreviewProps {
  /** The org the checkpoint is of: a sandbox, a scratch org or a Developer Edition. */
  org: SalesforceOrg;
  /** The checkpoint to rewind the org to: a usable one. */
  checkpoint: OrgCheckpoint;
  /** Back to the org's checkpoints. */
  onClose: () => void;
  /**
   * Rewind, with what the preview's boxes accepted, once the org's name was
   * typed to confirm it, and the diff the user confirmed: the run goes on
   * from there. Without it the preview offers no Rewind.
   */
  onRewind?: (acceptances: RewindAcceptances, diff: RewindDiff) => void;
  /**
   * The box that mutes what the rewind fires, beside it, drawn by the page
   * that starts the rewind (`AutomationMuteBox`) from the offer this preview
   * plans of its read: whether it is ticked, and its toggle. Without it, no
   * box is offered, and the rewind is not asked to mute: the Automation
   * page's Rewind step shows this preview, and runs no mute.
   */
  muteBox?: MuteBoxOf;
}

/** Draws the box that mutes a rewind's automation from the offer of a preview. */
export type MuteBoxOf = (
  offer: MuteOffer | null,
  checked: boolean,
  onChange: (mute: boolean) => void,
) => React.ReactNode;

/** The boxes of a preview, ticked for that preview alone: one read again starts unticked. */
interface Ticked {
  automation: boolean;
  noUndo: boolean;
  recreate: boolean;
  outside: boolean;
  unseen: boolean;
}

/**
 * What a rewind of the org to a checkpoint would do, read from the org as the
 * preview opens and written nowhere: how many records it deletes, gives back
 * and brings back, who last changed them, object by object; what it cannot
 * undo, what its Undo could not bring back, what its deletions take along
 * outside the checkpoint, the fields it does not compare, what the org runs
 * as it writes and what it costs — or that the org is as it was, with
 * nothing to rewind.
 *
 * Every number is the extension's diff's: the page adds an object's classes
 * into a column and the objects into a total, and counts nothing itself.
 *
 * What Undo could not bring back, the records the recycle bin no longer gives
 * back, which the rewind makes again with new Ids, the automation the org
 * runs as the rewind writes, and, for a user without View All Data and Modify
 * All Data, what the rewind's deletions take along that the user is not
 * proven to see, are each accepted with a box before Rewind can be pressed;
 * in a checkpoint of
 * picked objects, the records outside it that its deletions take along go
 * only when their box is ticked, and their parents stay otherwise. A box is
 * ticked for the preview it was read with: read again, the org may differ.
 * Rewind then asks for the org's name, typed, under what it deletes, gives
 * back and brings back, as every removal that deletes does.
 *
 * Read object by object, the preview says so: what another user deleted
 * since stays in the recycle bin, and an object the user no longer holds
 * whole is among those it could not read, named with the user.
 *
 * The table's Rewind column, every object ticked to begin with, limits the
 * rewind to some objects. As the ticks settle, the page asks the extension
 * for the plan of the objects ticked (`checkpoint:plan-selection`), made on
 * this machine from the preview's reads by the rewind's own plan, the org not
 * read: the numbers, the boxes and the confirmation are then that plan's,
 * with what it leaves of the objects ticked and why, and the objects it needs
 * to rewind those too, each with a button that ticks it. A dependency is
 * proposed, never added; Rewind waits for the plan of what is ticked.
 */
export const RewindPreview: React.FC<RewindPreviewProps> = ({
  org,
  checkpoint,
  onClose,
  onRewind,
  muteBox,
}) => {
  const { t } = useTranslation();
  const orgName = org.alias || org.username;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useFocusOnChange(headingRef, checkpoint.checkpointId, { onMount: true });

  const preview = useBridgeQuery<PreviewAnswer>(
    'checkpoint:preview',
    { checkpointId: checkpoint.checkpointId },
    { timeoutMs: PREVIEW_TIMEOUT_MS },
  );
  const takenFrom =
    formatStoredDate(checkpoint.readFrom, (d) =>
      dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(d),
    ) ?? t('common.dateUnknown');

  let body: React.ReactNode;
  if (preview.data === null && preview.error) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner
          message={preview.error}
          code={preview.errorCode}
          data-testid="checkpoint-preview-error"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={preview.refetch}
          data-testid="checkpoint-preview-retry"
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  } else if (preview.data === null) {
    body = (
      <div className="flex flex-col gap-2" aria-busy="true">
        <p
          role="status"
          className="text-sm text-text-primary"
          data-testid="checkpoint-preview-reading"
        >
          {t('checkpoint.preview.reading', { org: orgName, name: checkpoint.name })}
        </p>
        <Skeleton variant="rect" height="48px" />
        <Skeleton variant="rect" height="96px" />
      </div>
    );
  } else {
    body = (
      <PreviewBody
        key={preview.data.diff.previewId}
        org={org}
        checkpoint={checkpoint}
        takenFrom={takenFrom}
        answer={preview.data}
        readingAgain={preview.loading}
        onReadAgain={preview.refetch}
        onRewind={onRewind}
        {...(muteBox ? { muteBox } : {})}
      />
    );
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-sm border border-subtle bg-surface-1 p-4"
      aria-labelledby={headingId}
      data-testid="checkpoint-preview"
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-text-primary break-words"
      >
        {t('checkpoint.preview.title', { org: orgName, name: checkpoint.name, date: takenFrom })}
      </h2>
      {/* A read again that failed leaves the last answer up, and says why. */}
      {preview.data !== null && preview.error && (
        <ErrorBanner
          message={preview.error}
          code={preview.errorCode}
          data-testid="checkpoint-preview-error"
        />
      )}
      {body}
      <div>
        <Button variant="secondary" onClick={onClose} data-testid="checkpoint-preview-back">
          {t('common.back')}
        </Button>
      </div>
    </section>
  );
};

/**
 * The emails the rewind's writes make the org send, per daily limit, against
 * what it has left today: past them, the rewind is refused whatever is
 * ticked, as the refusal above says.
 */
const Emails: React.FC<{ emails: readonly CheckpointEmails[]; orgName: string }> = ({
  emails,
  orgName,
}) => {
  const { t } = useTranslation();
  return (
    <ul className="ml-4 list-disc" data-testid="checkpoint-preview-emails">
      {emails.map((check) => {
        const senders = [...new Set(check.objects.flatMap((object) => object.sentBy))];
        const values = {
          limit: t(
            check.limit === 'SingleEmail'
              ? 'common.emailLimit.single'
              : 'common.emailLimit.workflow',
          ),
          emails: formatNumber(check.emails),
          org: orgName,
          senders: listWords(senders, t),
          remaining: formatNumber(check.remaining ?? 0),
          max: formatNumber(check.max ?? 0),
          reason: check.unread ?? '',
        };
        return (
          <li key={check.limit} data-testid={`checkpoint-preview-emails-${check.limit}`}>
            {check.verdict === 'unread'
              ? t('checkpoint.preview.emails.unread', values)
              : check.verdict === 'exceeds'
                ? t('checkpoint.preview.emails.exceeds', values)
                : t('checkpoint.preview.emails.fits', values)}
            {check.alertsCounted &&
              ` ${t('checkpoint.preview.emails.alertsCounted', { org: orgName })}`}
          </li>
        );
      })}
    </ul>
  );
};

/** Props for the preview once the org answered. */
interface PreviewBodyProps {
  org: SalesforceOrg;
  checkpoint: OrgCheckpoint;
  /** When its take began, as the heading says it. */
  takenFrom: string;
  answer: PreviewAnswer;
  /** The preview is being read again: what is shown is the last answer. */
  readingAgain: boolean;
  onReadAgain: () => void;
  onRewind?: (acceptances: RewindAcceptances, diff: RewindDiff) => void;
  muteBox?: MuteBoxOf;
}

/** What a rewind would do, as the org answered: see {@link RewindPreview}. */
const PreviewBody: React.FC<PreviewBodyProps> = ({
  org,
  checkpoint,
  takenFrom,
  answer,
  readingAgain,
  onReadAgain,
  onRewind,
  muteBox,
}) => {
  const { t } = useTranslation();
  const orgName = org.alias || org.username;
  const { diff, automation, emails, emailsUncounted, estimate, refusal } = answer;
  const settings = customSettingsOf(checkpoint);
  const undoCannotId = useId();
  const recreateId = useId();
  const unseenId = useId();
  const [ticked, setTicked] = useState<Ticked>({
    automation: false,
    noUndo: false,
    recreate: false,
    outside: false,
    unseen: false,
  });
  // What Rewind accepted as it was pressed, while the org's name is typed.
  const [confirming, setConfirming] = useState<RewindAcceptances | null>(null);
  // The box beside what the rewind fires: mute it, through the org's own
  // bypass. Not among the boxes that lift a refusal: ticked, it asks for
  // something more of the org, which may refuse it.
  const [mute, setMute] = useState(false);
  const tick = (box: keyof Ticked, value: boolean): void =>
    setTicked((was) => ({ ...was, [box]: value }));

  // The objects left unticked in the Rewind column: none, a rewind of every
  // object, which asks for no plan.
  const [unticked, setUnticked] = useState<readonly string[]>([]);
  const rowNames = diff.objects.map((object) => object.objectApiName);
  const picks = rowNames.filter((name) => !unticked.includes(name));
  const selecting = unticked.length > 0;
  const pickRow = (name: string, value: boolean): void =>
    setUnticked((was) =>
      value ? was.filter((each) => each !== name) : was.includes(name) ? was : [...was, name],
    );
  // The plan of what is ticked, asked once the ticks have settled, by what it
  // is asked: the same choice is asked once, and an answer is the plan of
  // the choice it was asked for alone.
  const askedKey =
    selecting && picks.length > 0
      ? JSON.stringify({
          checkpointId: diff.checkpointId,
          previewId: diff.previewId,
          objects: picks,
          acceptOutside: ticked.outside,
        })
      : '';
  const settledKey = useSettled(askedKey, SELECTION_SETTLE_MS);
  const planning = useBridgeMutation<PlanAnswer>('checkpoint:plan-selection', {
    timeoutMs: PLAN_TIMEOUT_MS,
  });
  const askPlan = planning.mutate;
  const [sentKey, setSentKey] = useState('');
  const sent = useRef('');
  useEffect(() => {
    if (settledKey === '' || settledKey === sent.current) return;
    sent.current = settledKey;
    setSentKey(settledKey);
    askPlan(JSON.parse(settledKey) as Record<string, unknown>);
  }, [settledKey, askPlan]);
  const asked = askedKey !== '' && sentKey === askedKey;
  const plan: RewindSelectionPlan | null =
    asked && planning.data !== null ? planning.data.plan : null;
  const planError = asked && planning.error !== null;
  // What the rewind writes, by which every number, box and step is counted:
  // the whole diff, or the plan of what is ticked — the diff of those objects
  // until it comes.
  const counted = !selecting ? diff : plan ? selectionDiff(diff, plan) : pickedDiff(diff, picks);

  // The table stays while a rewind of every object writes anything: what is
  // unticked is ticked again there.
  const writesAny = rewindWrites(diff);
  const writes = rewindWrites(counted);
  const steps = rewindSteps(counted);
  const fired = automation
    ? firedOnRemovalStepsOf(automation, steps).map((each) => ({
        part: each.step,
        fired: each,
        whyKey: each.step === 'delete' ? DELETE_WHEN_KEYS[each.when] : STEP_KEYS[each.step],
      }))
    : [];
  const shown: RemovalAutomationShown | undefined = automation
    ? { automation, entries: fired, bypasses: removalStepsBypassesOf(automation, steps) }
    : undefined;
  // What the rewind's writes fire that a bypass silences, planned as the
  // extension plans it: offered beside what fires.
  const muteOffer = automation ? mutePlanOf(automation, removalStepsWrites(steps)) : null;
  const muting = muteBox !== undefined && mute && muteOffer !== null && muteOffered(muteOffer);
  // Muted, the rewind asks acceptance only for what still runs, as its gate
  // does: what the bypasses keep quiet is read as held.
  const gated =
    automation && muteOffer && muting
      ? mutedAutomationOf(automation, mutePermissionsOf(muteOffer))
      : automation;
  const stillFires = gated ? firedOnRemovalStepsOf(gated, steps) : [];
  // A part of the automation the org would not let be read may run as well
  // as what was read: it is accepted as automation found. So is what sends
  // emails that could not be counted, as Sync and Autopilot ask for it.
  const automationFound =
    automation !== undefined &&
    (stillFires.length > 0 || blindedBy(automation.unread) || emailsUncounted !== undefined);
  const outside = outsideLines(counted);
  const remade = recreateLines(counted);
  // Read object by object: what the deletions take along out of the user's
  // sight, which no read counts.
  const unseen = counted.unseen ?? [];
  // Salesforce lists a record emptied from the bin as deleted: only the
  // undelete's answer says it is gone. The box is offered whenever records
  // come back, and required only for those counted to make again.
  const bringsBack = rewindTotals(counted).toBringBack > 0;
  const picked = checkpoint.scope.mode === 'picked';
  // Of a rewind of some objects, records of an object not ticked made since
  // under a record it deletes are outside it too: the plan keeps that record
  // unless deleting them is accepted, by the same box as what goes along
  // outside a checkpoint of picked objects, offered where that one is not.
  const outsideBoxed = picked && outside.length > 0;
  const leftForOutside = plan?.left.some((entry) => entry.reason === 'outsideNotAccepted') ?? false;
  const unpickedBox = selecting && !outsideBoxed && (leftForOutside || ticked.outside);

  const lifted = refusal ? LIFTED_BY[refusal.code] : undefined;
  const refused = refusal !== undefined && (lifted === undefined || !ticked[lifted]);
  const canRewind =
    writes &&
    !readingAgain &&
    !refused &&
    (!selecting || plan !== null) &&
    (counted.undoCannot.length === 0 || ticked.noUndo) &&
    (remade.length === 0 || ticked.recreate) &&
    (unseen.length === 0 || ticked.unseen) &&
    (!automationFound || ticked.automation);

  const rewind = (): void => {
    if (!canRewind || !onRewind) return;
    setConfirming({
      previewId: diff.previewId,
      acceptAutomation: automationFound && ticked.automation,
      acceptNoUndo: counted.undoCannot.length > 0 && ticked.noUndo,
      acceptRecreate: (remade.length > 0 || bringsBack) && ticked.recreate,
      // A checkpoint of everything people work in takes them along, as the
      // preview said: only a checkpoint of picked objects asks — and a rewind
      // of some objects, for the records of the others, as its plan was asked.
      acceptOutside: selecting ? ticked.outside : outside.length > 0 && (!picked || ticked.outside),
      acceptUnseen: unseen.length > 0 && ticked.unseen,
      ...(selecting ? { objects: picks } : {}),
      ...(muting ? { muteAutomation: true as const } : {}),
    });
  };
  const confirmed = (): void => {
    if (confirming && onRewind) onRewind(confirming, counted);
    setConfirming(null);
  };

  return (
    <div className="flex flex-col gap-4 text-xs text-text-primary">
      {readingAgain && (
        <p
          role="status"
          className="text-text-secondary"
          data-testid="checkpoint-preview-reading-again"
        >
          {t('checkpoint.preview.readingAgain', { org: orgName })}
        </p>
      )}
      {refusal && (
        <p role="alert" className="text-sm font-medium" data-testid="checkpoint-preview-refusal">
          {refusal.message}
        </p>
      )}
      {diff.access.kind === 'perObject' && (
        <p data-testid="checkpoint-preview-per-object">
          {t('checkpoint.preview.access.perObject', { user: org.username })}
        </p>
      )}

      {writesAny ? (
        <>
          <Numbers diff={counted} />
          <People diff={counted} checkpoint={checkpoint} org={org} />
          <ObjectTable
            diff={diff}
            counted={counted}
            settings={settings}
            {...(onRewind && rowNames.length > 1 ? { unticked, onPick: pickRow } : {})}
          />
          {selecting && (
            <Selection
              picks={picks}
              rows={rowNames}
              plan={plan}
              planning={picks.length > 0 && plan === null && !planError}
              error={planError ? planning.error : null}
              errorCode={planError ? planning.errorCode : null}
              onRetry={() => askPlan(JSON.parse(sentKey) as Record<string, unknown>)}
              onAdd={(name) => pickRow(name, true)}
              writes={writes}
              {...(unpickedBox
                ? {
                    outsideBox: {
                      checked: ticked.outside,
                      onChange: (value: boolean) => tick('outside', value),
                    },
                  }
                : {})}
            />
          )}
        </>
      ) : (
        <p
          role="status"
          className="flex items-start gap-2 text-sm"
          data-testid="checkpoint-preview-nothing"
        >
          {heldAsItWas(diff) && (
            <CheckCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-status-success"
              aria-hidden="true"
            />
          )}
          <span>
            {heldAsItWas(diff)
              ? t('checkpoint.preview.nothing', { org: orgName, name: checkpoint.name })
              : t('checkpoint.preview.nothingToWrite')}
          </span>
        </p>
      )}

      <Details diff={counted} />
      <Unread diff={diff} />
      <Files diff={counted} orgName={orgName} username={org.username} />
      <CannotUndo
        diff={counted}
        orgName={orgName}
        user={org.username}
        writes={writes}
        holdsFiles={diff.files !== undefined}
      />

      {counted.undoCannot.length > 0 && (
        <section
          aria-labelledby={undoCannotId}
          className="flex flex-col gap-1.5"
          data-testid="checkpoint-preview-undo-cannot"
        >
          <h3 id={undoCannotId} className="text-sm font-semibold">
            {t('checkpoint.preview.undoCannot.title')}
          </h3>
          <ul className="ml-4 list-disc">
            {counted.undoCannot.map((item) => {
              // Each reason its own sentence: a record deleted before a
              // record it points at is said apart from one Salesforce
              // undeletes only with a parent that stays.
              const reason = undoCannotReasonOf(item);
              const named =
                reason === 'onlyWithParent'
                  ? item.objectApiName
                  : `${item.objectApiName}-${reason}`;
              return (
                <li key={named} data-testid={`checkpoint-preview-undo-cannot-${named}`}>
                  {t(UNDO_CANNOT_KEYS[reason], {
                    count: item.count,
                    formatted: formatNumber(item.count),
                    object: item.objectApiName,
                  })}
                </li>
              );
            })}
          </ul>
          <Box
            checked={ticked.noUndo}
            onChange={(value) => tick('noUndo', value)}
            label={t('checkpoint.preview.undoCannot.accept')}
            testId="checkpoint-preview-accept-no-undo"
          />
        </section>
      )}

      {(remade.length > 0 || bringsBack) && (
        <section
          aria-labelledby={recreateId}
          className="flex flex-col gap-1.5"
          data-testid="checkpoint-preview-recreate"
        >
          <h3 id={recreateId} className="text-sm font-semibold">
            {remade.length > 0
              ? t('checkpoint.preview.recreate.title')
              : t('checkpoint.preview.recreate.ifEmptiedTitle')}
          </h3>
          {remade.length > 0 && (
            <ul className="ml-4 list-disc">
              {remade.map((line) => (
                <li
                  key={line.objectApiName}
                  data-testid={`checkpoint-preview-recreate-${line.objectApiName}`}
                >
                  {t('checkpoint.preview.recreate.line', {
                    count: line.count,
                    formatted: formatNumber(line.count),
                    object: line.objectApiName,
                  })}
                </li>
              ))}
            </ul>
          )}
          {bringsBack && (
            <p data-testid="checkpoint-preview-recreate-if-emptied">
              {t('checkpoint.preview.recreate.ifEmptied')}
            </p>
          )}
          <p>{t('checkpoint.preview.recreate.newIds')}</p>
          <Box
            checked={ticked.recreate}
            onChange={(value) => tick('recreate', value)}
            label={t('checkpoint.preview.recreate.accept')}
            testId="checkpoint-preview-accept-recreate"
          />
        </section>
      )}

      {unseen.length > 0 && (
        <section
          aria-labelledby={unseenId}
          className="flex flex-col gap-1.5"
          data-testid="checkpoint-preview-unseen"
        >
          <h3 id={unseenId} className="text-sm font-semibold">
            {t('checkpoint.preview.unseen.title')}
          </h3>
          <ul className="ml-4 list-disc">
            {unseen.map((line) => (
              <li
                key={line.objectApiName}
                data-testid={`checkpoint-preview-unseen-${line.objectApiName}`}
              >
                {t('checkpoint.preview.unseen.line', {
                  count: line.records,
                  formatted: formatNumber(line.records),
                  object: line.objectApiName,
                  user: org.username,
                  children: listWords(line.children, t),
                })}
              </li>
            ))}
          </ul>
          <p>{t('checkpoint.preview.unseen.why', { user: org.username })}</p>
          <Box
            checked={ticked.unseen}
            onChange={(value) => tick('unseen', value)}
            label={t('checkpoint.preview.unseen.accept', { user: org.username })}
            testId="checkpoint-preview-accept-unseen"
          />
        </section>
      )}

      {outside.length > 0 && (
        <OutsideBox
          lines={outside}
          picked={picked}
          checked={ticked.outside}
          onChange={(value) => tick('outside', value)}
        />
      )}

      {checkpoint.ignoredFields.length > 0 && (
        <p data-testid="checkpoint-preview-not-compared">
          {t('checkpoint.preview.notCompared', {
            fields: listWords(checkpoint.ignoredFields, t),
          })}
        </p>
      )}

      {writes && shown && (
        <div className="flex flex-col gap-1.5">
          <RemovalAutomationView
            testId="checkpoint-preview-automation"
            org={orgName}
            targetOrgId={org.id}
            words={AUTOMATION_WORDS}
            shown={shown}
            error={null}
            reading={readingAgain}
            onReadAgain={onReadAgain}
            {...(muteBox ? { after: muteBox(muteOffer, mute, setMute) } : {})}
          />
          {emails && emails.length > 0 && <Emails emails={emails} orgName={orgName} />}
          {/* Said whether or not anything else sends: a package's flow is never read. */}
          {emailsUncounted !== undefined && (
            <p data-testid="checkpoint-preview-emails-uncounted">
              {t('checkpoint.preview.emails.uncounted', {
                org: orgName,
                reason: emailsUncounted,
              })}
            </p>
          )}
          {automationFound && (
            <Box
              checked={ticked.automation}
              onChange={(value) => tick('automation', value)}
              label={t('checkpoint.preview.automation.accept', { org: orgName })}
              testId="checkpoint-preview-accept-automation"
            />
          )}
        </div>
      )}

      {writes && (
        <div className="flex flex-col gap-1">
          <p data-testid="checkpoint-preview-cost">
            {t('checkpoint.preview.cost', {
              time: formatDurationSec(roughSeconds(estimate.seconds)),
              requests: formatNumber(estimate.apiRequests),
              left: formatNumber(estimate.apiRequestsLeft),
            })}
          </p>
          <p data-testid="checkpoint-preview-journal">
            {t('checkpoint.preview.journal', {
              date: formatDate(new Date(Date.now() + REWIND_UNDO_DAYS * DAY_MS)),
            })}
          </p>
        </div>
      )}

      {writesAny && onRewind && (
        <div>
          <Button
            variant="danger"
            onClick={rewind}
            disabled={!canRewind}
            data-testid="checkpoint-preview-rewind"
          >
            {t('checkpoint.preview.rewind', { org: orgName })}
          </Button>
        </div>
      )}

      <DangerConfirm
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={confirmed}
        title={
          selecting
            ? t('checkpoint.preview.confirm.titleObjects', {
                objects: listWords(picks, t),
                org: orgName,
                name: checkpoint.name,
              })
            : t('checkpoint.preview.confirm.title', { org: orgName, name: checkpoint.name })
        }
        description={confirmDescription(
          t,
          counted,
          orgName,
          takenFrom,
          settings,
          org.username,
          selecting
            ? { objects: picks, deletesAgain: plan ? deletedAgain(plan).length > 0 : false }
            : undefined,
        )}
        confirmText={orgName}
      />
    </div>
  );
};

/**
 * The custom settings a checkpoint keeps, by name: their rows are the org's
 * configuration, which a rewind sets back as the checkpoint holds them.
 */
function customSettingsOf(checkpoint: Pick<OrgCheckpoint, 'objects'>): ReadonlySet<string> {
  return new Set(
    checkpoint.objects
      .filter((object) => object.customSetting !== undefined)
      .map((object) => object.objectApiName),
  );
}

/** The rows of custom settings a rewind writes: deletes, gives back, brings back or makes again. */
function settingRowsWritten(diff: RewindDiff, settings: ReadonlySet<string>): number {
  return diff.objects
    .filter((object) => settings.has(object.objectApiName))
    .map(rowOf)
    .reduce(
      (sum, row) => sum + row.toDelete + row.toGiveBack + row.toBringBack + row.toRecreate,
      0,
    );
}

/**
 * What the typed confirmation of a rewind says it does: to what moment it
 * returns the org, and only the parts of it that apply — the records it
 * deletes, gives back, brings back and makes again, those it brings back
 * for a moment to delete again, and the links between files and records it
 * removes, puts back or gives their sharing back — whoever made the changes;
 * then, of those records, the rows of custom settings: configuration, which
 * the user named at the take, and which the rewind sets back too; and, read
 * object by object, what its deletions take along that `user` can't see,
 * which no number counts. A rewind of some objects names them, and says what
 * it does to the others: nothing, or delete again what comes back with a
 * record it brings back.
 */
function confirmDescription(
  t: TFunction,
  diff: RewindDiff,
  orgName: string,
  takenFrom: string,
  settings: ReadonlySet<string>,
  user: string,
  limited?: { objects: readonly string[]; deletesAgain: boolean },
): string {
  const totals = rewindTotals(diff);
  const parts: Array<[count: number, key: string]> = [
    [totals.toDelete, 'checkpoint.preview.confirm.delete'],
    [totals.toGiveBack, 'checkpoint.preview.confirm.giveBack'],
    [totals.toBringBack, 'checkpoint.preview.confirm.bringBack'],
    [totals.toRecreate, 'checkpoint.preview.confirm.recreate'],
    [carriersTotal(diff), 'checkpoint.preview.confirm.carriers'],
    [linkWrites(diff), 'checkpoint.preview.confirm.links'],
  ];
  const changes = parts
    .filter(([count]) => count > 0)
    .map(([count, key]) => t(key, { count, formatted: formatNumber(count) }));
  const description = limited
    ? t('checkpoint.preview.confirm.descriptionObjects', {
        objects: listWords(limited.objects, t),
        org: orgName,
        date: takenFrom,
        changes: listWords(changes, t),
      })
    : t('checkpoint.preview.confirm.description', {
        org: orgName,
        date: takenFrom,
        changes: listWords(changes, t),
      });
  const rows = settingRowsWritten(diff, settings);
  const unseen = unseenChildren(diff);
  return [
    description,
    ...(limited
      ? [
          limited.deletesAgain
            ? t('checkpoint.preview.confirm.othersDeletedAgain')
            : t('checkpoint.preview.confirm.othersLeft'),
        ]
      : []),
    ...(rows > 0
      ? [
          t('checkpoint.preview.confirm.customSettings', {
            count: rows,
            formatted: formatNumber(rows),
          }),
        ]
      : []),
    ...(unseen.length > 0
      ? [t('checkpoint.preview.confirm.unseen', { user, children: listWords(unseen, t) })]
      : []),
  ].join(' ');
}

/** A box the user ticks to accept what the preview names. */
const Box: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId: string;
}> = ({ checked, onChange, label, testId }) => (
  <label className="flex items-start gap-2 text-xs font-medium">
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      data-testid={testId}
    />
    <span>{label}</span>
  </label>
);

/** The preview's three numbers: to delete, to give back, to bring back. */
const Numbers: React.FC<{ diff: RewindDiff }> = ({ diff }) => {
  const { t } = useTranslation();
  const totals = rewindTotals(diff);
  const numbers = [
    {
      key: 'checkpoint.preview.toDelete',
      hint: 'checkpoint.preview.toDeleteHint',
      count: totals.toDelete,
      testId: 'delete',
    },
    {
      key: 'checkpoint.preview.toGiveBack',
      hint: 'checkpoint.preview.toGiveBackHint',
      count: totals.toGiveBack,
      testId: 'give-back',
    },
    {
      key: 'checkpoint.preview.toBringBack',
      hint: 'checkpoint.preview.toBringBackHint',
      count: totals.toBringBack,
      testId: 'bring-back',
    },
    // Only when some are: most rewinds bring everything back from the bin.
    ...(totals.toRecreate > 0
      ? [
          {
            key: 'checkpoint.preview.toRecreate',
            hint: 'checkpoint.preview.toRecreateHint',
            count: totals.toRecreate,
            testId: 'recreate',
          },
        ]
      : []),
  ];
  return (
    <ul className="flex flex-wrap gap-2" data-testid="checkpoint-preview-numbers">
      {numbers.map((number) => (
        <li
          key={number.key}
          className="flex min-w-32 flex-1 flex-col rounded-sm border border-subtle p-2"
        >
          <span
            className="text-base font-semibold"
            data-testid={`checkpoint-preview-number-${number.testId}`}
          >
            {t(number.key, { count: number.count, formatted: formatNumber(number.count) })}
          </span>
          <span className="text-text-secondary">{t(number.hint)}</span>
        </li>
      ))}
    </ul>
  );
};

/**
 * Who last changed the records a rewind deletes or gives back, and who
 * worked in the org in the hour before the preview read it: a tester who
 * signs in as the user the rewind writes as cannot be told from the rewind.
 */
const People: React.FC<{ diff: RewindDiff; checkpoint: OrgCheckpoint; org: SalesforceOrg }> = ({
  diff,
  checkpoint,
  org,
}) => {
  const { t } = useTranslation();
  const orgName = org.alias || org.username;
  const changers = lastChangers(diff);
  const active = diff.activeLastHour.map((userId) => diff.userNames[userId] ?? userId);
  const sharedUser = diff.activeLastHour.includes(checkpoint.takenBy.userId);
  if (changers.length === 0 && active.length === 0) return null;
  // "Alice Martin 120": a name and a number, which no noun follows.
  const people = changers
    .map(({ name, userId, count: changed }) => {
      const formatted = formatNumber(changed);
      return t('checkpoint.preview.person', { name: name ?? userId, formatted });
    })
    .join(' · ');
  return (
    <div className="flex flex-col gap-1">
      {changers.length > 0 && (
        <p data-testid="checkpoint-preview-last-changed">
          {t('checkpoint.preview.lastChangedBy', { people })}
        </p>
      )}
      {active.length > 0 && (
        <p data-testid="checkpoint-preview-active">
          {t('checkpoint.preview.activeLastHour', { org: orgName, people: listWords(active, t) })}
        </p>
      )}
      {sharedUser && (
        <p data-testid="checkpoint-preview-shared-user">
          {t('checkpoint.preview.sharedUser', { user: org.username })}
        </p>
      )}
    </div>
  );
};

/** Props for the preview's table. */
interface ObjectTableProps {
  /** The whole diff: a row for each of its objects, ticked or not. */
  diff: RewindDiff;
  /** What the rewind writes: its numbers are each row's. */
  counted: RewindDiff;
  settings: ReadonlySet<string>;
  /** The objects left unticked in the Rewind column; the column is offered with {@link onPick}. */
  unticked?: readonly string[];
  /** Tick an object for the rewind, or untick it. */
  onPick?: (objectApiName: string, picked: boolean) => void;
}

/**
 * Object by object: what a rewind deletes, gives back, brings back, makes
 * again and cannot undo; a custom setting named as one, configuration. With
 * a Rewind column, every object ticked to begin with, each object can be
 * left out of the rewind: its row then says it is not rewound, and its
 * numbers are what the rewind of the others does to it — nothing, or the
 * records made since it deletes again with a record it brings back.
 */
const ObjectTable: React.FC<ObjectTableProps> = ({
  diff,
  counted,
  settings,
  unticked = [],
  onPick,
}) => {
  const { t } = useTranslation();
  const rewindHeaderId = useId();
  const nameId = useId();
  const writtenTo = new Map(counted.objects.map((object) => [object.objectApiName, object]));
  const rows = diff.objects.map((object): RewindRow => {
    const written = writtenTo.get(object.objectApiName);
    return written
      ? rowOf(written)
      : {
          objectApiName: object.objectApiName,
          toDelete: 0,
          toGiveBack: 0,
          toBringBack: 0,
          toRecreate: 0,
          cannotUndo: 0,
        };
  });
  // A column of its own only when the rewind makes any record again.
  const remakes = rows.some((row) => row.toRecreate > 0);
  const cell = 'py-1 pr-3';
  const header = `${cell} font-medium text-text-secondary`;
  const number = `${cell} text-right tabular-nums`;
  return (
    <table className="w-full text-xs" data-testid="checkpoint-preview-table">
      <caption className="sr-only">{t('checkpoint.preview.table.caption')}</caption>
      <thead>
        <tr className="border-b border-subtle">
          <th scope="col" className={`${header} text-left`}>
            {t('checkpoint.preview.table.object')}
          </th>
          <th scope="col" className={`${header} text-right`}>
            {t('checkpoint.preview.table.delete')}
          </th>
          <th scope="col" className={`${header} text-right`}>
            {t('checkpoint.preview.table.giveBack')}
          </th>
          <th scope="col" className={`${header} text-right`}>
            {t('checkpoint.preview.table.bringBack')}
          </th>
          {remakes && (
            <th scope="col" className={`${header} text-right`}>
              {t('checkpoint.preview.table.recreate')}
            </th>
          )}
          <th scope="col" className={`${header} text-right`}>
            {t('checkpoint.preview.table.cannotUndo')}
          </th>
          {onPick && (
            <th scope="col" id={rewindHeaderId} className={`${header} text-center`}>
              {t('checkpoint.preview.table.rewind')}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, at) => {
          const left = unticked.includes(row.objectApiName);
          return (
            <tr
              key={row.objectApiName}
              className="border-b border-subtle last:border-0"
              data-testid={`checkpoint-preview-row-${row.objectApiName}`}
            >
              <th scope="row" className={`${cell} text-left font-mono font-normal break-all`}>
                <span id={`${nameId}-${at}`}>{row.objectApiName}</span>
                {settings.has(row.objectApiName) && (
                  <span
                    className="block font-sans text-text-secondary"
                    data-testid={`checkpoint-preview-setting-${row.objectApiName}`}
                  >
                    {t('checkpoint.preview.table.customSetting')}
                  </span>
                )}
                {left && (
                  <span
                    className="block font-sans text-text-secondary"
                    data-testid={`checkpoint-preview-not-rewound-${row.objectApiName}`}
                  >
                    {t('checkpoint.preview.table.notRewound')}
                  </span>
                )}
              </th>
              <td className={number}>{formatNumber(row.toDelete)}</td>
              <td className={number}>{formatNumber(row.toGiveBack)}</td>
              <td className={number}>{formatNumber(row.toBringBack)}</td>
              {remakes && <td className={number}>{formatNumber(row.toRecreate)}</td>}
              <td className={number}>{formatNumber(row.cannotUndo)}</td>
              {onPick && (
                <td className={`${cell} text-center`}>
                  {/* Named by its column and its object, as the row reads. */}
                  <input
                    type="checkbox"
                    checked={!left}
                    onChange={(event) => onPick(row.objectApiName, event.target.checked)}
                    aria-labelledby={`${rewindHeaderId} ${nameId}-${at}`}
                    data-testid={`checkpoint-preview-pick-${row.objectApiName}`}
                  />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/** Props for what a rewind of some objects would do and leave. */
interface SelectionProps {
  /** The objects ticked, in the checkpoint's reading order. */
  picks: readonly string[];
  /** The objects of the table: those a dependency can be ticked among. */
  rows: readonly string[];
  /** The plan of what is ticked, once the extension answered it. */
  plan: RewindSelectionPlan | null;
  /** The plan of what is ticked is being asked for. */
  planning: boolean;
  error: string | null;
  errorCode: string | null;
  onRetry: () => void;
  /** Tick an object a record ticked needs. */
  onAdd: (objectApiName: string) => void;
  /** Whether the rewind of what is ticked writes anything. */
  writes: boolean;
  /**
   * The box that accepts deleting the records of objects not ticked made
   * since under a record the rewind deletes, when no other box offers it.
   */
  outsideBox?: { checked: boolean; onChange: (checked: boolean) => void };
}

/**
 * What a rewind limited to the objects ticked would do and leave, as its own
 * plan says it: the objects it is limited to, and that the others are left
 * as they are; what it deletes again of the others; the records of the
 * objects ticked it leaves, by why; the objects those need, each with a
 * button that ticks it; and that a lookup of another object to a record it
 * deletes is emptied by Salesforce.
 */
const Selection: React.FC<SelectionProps> = ({
  picks,
  rows,
  plan,
  planning,
  error,
  errorCode,
  onRetry,
  onAdd,
  writes,
  outsideBox,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const objects = listWords(picks, t);
  const counted = (count: number): { count: number; formatted: string } => ({
    count,
    formatted: formatNumber(count),
  });
  const lines: Array<{ id: string; text: string }> = plan
    ? [
        ...deletedAgain(plan).map((act) => ({
          id: `again-${act.objectApiName}`,
          text: t('checkpoint.preview.selection.deletedAgain', {
            ...counted(act.toDelete),
            object: act.objectApiName,
          }),
        })),
        ...plan.left.map((entry) => ({
          id: `left-${entry.objectApiName}-${entry.reason}`,
          text: t(SELECTION_LEFT_KEYS[entry.reason], {
            ...counted(entry.count),
            object: entry.objectApiName,
          }),
        })),
        ...(deletesPicked(plan)
          ? [{ id: 'lookups', text: t('checkpoint.preview.selection.lookupsEmptied') }]
          : []),
      ]
    : [];
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1.5"
      data-testid="checkpoint-preview-selection"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {picks.length > 0
          ? t('checkpoint.preview.selection.title', { objects })
          : t('checkpoint.preview.selection.noneTitle')}
      </h3>
      {picks.length > 0 ? (
        <p>{t('checkpoint.preview.selection.limited')}</p>
      ) : (
        <p role="status" data-testid="checkpoint-preview-selection-none">
          {t('checkpoint.preview.selection.none')}
        </p>
      )}
      {planning && (
        <p
          role="status"
          className="text-text-secondary"
          data-testid="checkpoint-preview-selection-planning"
        >
          {t('checkpoint.preview.selection.planning', { objects })}
        </p>
      )}
      {error !== null && (
        <div className="flex flex-col items-start gap-2">
          <ErrorBanner
            message={error}
            code={errorCode}
            data-testid="checkpoint-preview-selection-error"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            data-testid="checkpoint-preview-selection-retry"
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {lines.length > 0 && (
        <ul className="ml-4 list-disc" data-testid="checkpoint-preview-selection-lines">
          {lines.map((line) => (
            <li key={line.id} data-testid={`checkpoint-preview-selection-${line.id}`}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {plan && plan.needs.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="checkpoint-preview-selection-needs">
          {plan.needs.map((need) => (
            <li
              key={need.objectApiName}
              className="flex flex-wrap items-center gap-2"
              data-testid={`checkpoint-preview-needs-${need.objectApiName}`}
            >
              <span>
                {t('checkpoint.preview.selection.needs', {
                  ...counted(need.records),
                  object: need.objectApiName,
                })}
              </span>
              {rows.includes(need.objectApiName) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAdd(need.objectApiName)}
                  data-testid={`checkpoint-preview-add-${need.objectApiName}`}
                >
                  {t('checkpoint.preview.selection.add', { object: need.objectApiName })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {outsideBox && (
        <Box
          checked={outsideBox.checked}
          onChange={outsideBox.onChange}
          label={t('checkpoint.preview.selection.acceptOutside')}
          testId="checkpoint-preview-accept-outside-unpicked"
        />
      )}
      {plan && !writes && (
        <p data-testid="checkpoint-preview-selection-writes-nothing">
          {t('checkpoint.preview.selection.writesNothing')}
        </p>
      )}
    </section>
  );
};

/**
 * What each object's numbers hold beyond the table, and the objects whose
 * fields the preview did not describe, nothing having moved in them: only the
 * lines that apply.
 */
const Details: React.FC<{ diff: RewindDiff }> = ({ diff }) => {
  const { t } = useTranslation();
  const notChecked = diff.fieldsNotChecked ?? 0;
  const lines = [
    ...diff.objects.flatMap((object) =>
      DETAIL_LINES.flatMap(({ key, count }) => {
        const n = count(object);
        return n > 0
          ? [
              {
                id: `${object.objectApiName}-${key}`,
                text: t(key, {
                  count: n,
                  formatted: formatNumber(n),
                  object: object.objectApiName,
                }),
              },
            ]
          : [];
      }),
    ),
    ...(notChecked > 0
      ? [
          {
            id: 'fieldsNotChecked',
            text: t('checkpoint.preview.detail.fieldsNotChecked', {
              count: notChecked,
              formatted: formatNumber(notChecked),
            }),
          },
        ]
      : []),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="ml-4 list-disc" data-testid="checkpoint-preview-details">
      {lines.map((line) => (
        <li key={line.id}>{line.text}</li>
      ))}
    </ul>
  );
};

/** The objects the preview could not read: never read as unchanged, so a rewind leaves them as they are. */
const Unread: React.FC<{ diff: RewindDiff }> = ({ diff }) => {
  const { t } = useTranslation();
  const headingId = useId();
  if (diff.unread.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="checkpoint-preview-unread"
    >
      <h3 id={headingId} className="text-sm font-semibold text-status-warning">
        {t('checkpoint.preview.unread', {
          count: diff.unread.length,
          formatted: formatNumber(diff.unread.length),
        })}
      </h3>
      <ul className="ml-4 list-disc">
        {diff.unread.map((object) => (
          <li key={object.objectApiName}>
            <span className="font-mono">{object.objectApiName}</span>
            {' — '}
            {object.reason}
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * What a rewind of a checkpoint that holds files does to the links between
 * its files and its records, and what it leaves of the org's files, only the
 * lines that apply: the links it removes, puts back and gives their sharing
 * back; the files added or deleted since that no record of the checkpoint
 * links to, left as they are; the file storage the files it brings back take
 * against what the org has left, and what Undo would take again; and what the
 * user cannot see without Query All Files. The files it deletes, brings back
 * and gives their fields back are in the table, as `ContentDocument`.
 */
const Files: React.FC<{ diff: RewindDiff; orgName: string; username: string }> = ({
  diff,
  orgName,
  username,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const files = diff.files;
  if (files === undefined) return null;
  const counted = (key: string, count: number, extra: Record<string, string> = {}): string =>
    t(key, { count, formatted: formatNumber(count), ...extra });
  const back = filesBroughtBack(diff);
  const { storage } = files;
  const lines: Array<{ id: string; text: string }> = [
    ...(files.unlink > 0
      ? [{ id: 'unlink', text: counted('checkpoint.preview.files.unlink', files.unlink) }]
      : []),
    ...(files.relink > 0
      ? [{ id: 'relink', text: counted('checkpoint.preview.files.relink', files.relink) }]
      : []),
    // The org refuses to change the sharing type of a link to an account: a
    // link of which only that changed is named once the rewind is through.
    ...(files.updateLinks > 0
      ? [
          {
            id: 'update-links',
            text:
              counted('checkpoint.preview.files.updateLinks', files.updateLinks) +
              ' ' +
              t('checkpoint.preview.files.shareTypeFixed'),
          },
        ]
      : []),
    ...(files.outsideAdded > 0
      ? [
          {
            id: 'outside-added',
            text: counted('checkpoint.preview.files.outsideAdded', files.outsideAdded),
          },
        ]
      : []),
    ...(files.outsideDeleted > 0
      ? [
          {
            id: 'outside-deleted',
            text: counted('checkpoint.preview.files.outsideDeleted', files.outsideDeleted),
          },
        ]
      : []),
    ...(back > 0 && storage.bringBack > 0
      ? [
          {
            id: 'storage',
            text:
              storage.remaining === undefined
                ? counted('checkpoint.preview.files.storageUnsaid', back, {
                    size: formatFileSize(storage.bringBack),
                    org: orgName,
                  })
                : counted('checkpoint.preview.files.storage', back, {
                    size: formatFileSize(storage.bringBack),
                    remaining: formatFileSize(storage.remaining),
                    org: orgName,
                  }),
          },
        ]
      : []),
    ...(storage.undo > 0
      ? [
          {
            id: 'undo-storage',
            text: t('checkpoint.preview.files.undoStorage', {
              size: formatFileSize(storage.undo),
            }),
          },
        ]
      : []),
    ...(files.blindSpot
      ? [{ id: 'blind-spot', text: t('checkpoint.preview.files.blindSpot', { user: username }) }]
      : []),
  ];
  if (lines.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="checkpoint-preview-files"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('checkpoint.preview.files.title')}
      </h3>
      <ul className="ml-4 list-disc">
        {lines.map((line) => (
          <li key={line.id} data-testid={`checkpoint-preview-files-${line.id}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * What a rewind cannot undo, only the lines that apply: records the recycle
 * bin no longer holds and the like, by reason; the fields deleted, hidden
 * from `user` by field-level security, either of the two, added or changed
 * since; and, when the rewind writes anything, what the org keeps itself,
 * what already left it, and its metadata.
 */
const CannotUndo: React.FC<{
  diff: RewindDiff;
  orgName: string;
  /** The user the preview read the org as: who field-level security hides a field from. */
  user: string;
  writes: boolean;
  /**
   * Whether the checkpoint holds files, which `diff` does not say when it is
   * of a rewind of some objects that leaves the files out.
   */
  holdsFiles: boolean;
}> = ({ diff, orgName, user, writes, holdsFiles }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const field = (object: string, name: string): string => `${object}.${name}`;
  const removed = diff.objects.flatMap((object) =>
    (object.schemaDrift?.removed ?? []).map((name) => field(object.objectApiName, name)),
  );
  // Gone from the describe as a deleted field is, but still there: Deleted
  // Fields gives nothing back, an access given does.
  const hidden = diff.objects.flatMap((object) =>
    (object.schemaDrift?.hidden ?? []).map((name) => field(object.objectApiName, name)),
  );
  const uncertain = diff.objects.flatMap((object) =>
    (object.schemaDrift?.uncertain?.fields ?? []).map((name) => field(object.objectApiName, name)),
  );
  const added = diff.objects.flatMap((object) =>
    (object.schemaDrift?.added ?? []).map((name) => field(object.objectApiName, name)),
  );
  const changed = diff.objects.flatMap((object) =>
    (object.schemaDrift?.changed ?? []).map((name) => field(object.objectApiName, name)),
  );
  const lines: Array<{ id: string; text: string }> = [
    ...cannotUndoLines(diff).map((line) => ({
      id: line.reason,
      text: t(CANNOT_UNDO_KEYS[line.reason], {
        count: line.count,
        formatted: formatNumber(line.count),
        objects: listWords(line.objects, t),
      }),
    })),
    ...removed.map((name) => ({
      id: `removed-${name}`,
      text: t('checkpoint.preview.cannot.fieldRemoved', { field: name }),
    })),
    ...hidden.map((name) => ({
      id: `hidden-${name}`,
      text: t('checkpoint.preview.cannot.fieldHidden', { field: name, user }),
    })),
    ...uncertain.map((name) => ({
      id: `uncertain-${name}`,
      text: t('checkpoint.preview.cannot.fieldRemovedOrHidden', {
        field: name,
        org: orgName,
        user,
      }),
    })),
    ...(added.length > 0
      ? [
          {
            id: 'added',
            text: t('checkpoint.preview.cannot.fieldsAdded', {
              count: added.length,
              fields: listWords(added, t),
            }),
          },
        ]
      : []),
    ...(changed.length > 0
      ? [
          {
            id: 'changed',
            text: t('checkpoint.preview.cannot.fieldsChanged', {
              count: changed.length,
              fields: listWords(changed, t),
            }),
          },
        ]
      : []),
    ...(writes
      ? [
          { id: 'computed', text: t('checkpoint.preview.cannot.computed') },
          { id: 'left', text: t('checkpoint.preview.cannot.leftTheOrg', { org: orgName }) },
          { id: 'metadata', text: t('checkpoint.preview.cannot.metadata') },
          // A checkpoint taken before files were held, or whose scope left
          // them out, rewinds as SandForge 1.69 did: what was attached since
          // stays.
          ...(!holdsFiles
            ? [{ id: 'filesNotHeld', text: t('checkpoint.preview.cannot.filesNotHeld') }]
            : []),
        ]
      : []),
  ];
  if (lines.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="checkpoint-preview-cannot"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('checkpoint.preview.cannot.title')}
      </h3>
      <ul className="ml-4 list-disc">
        {lines.map((line) => (
          <li key={line.id} data-testid={`checkpoint-preview-cannot-${line.id}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * Whether a line of what goes along outside the checkpoint is of files the
 * rewind deletes that are attached outside it too: their links to a library,
 * a group or a record of another object, which their deletion takes along.
 */
function isFileShared(
  line: Pick<ReturnType<typeof outsideLines>[number], 'objectApiName' | 'outside'>,
): boolean {
  return line.objectApiName === FILE_OBJECT && line.outside === FILE_LINK_OBJECT;
}

/** Props for what a rewind's deletions take along outside the checkpoint. */
interface OutsideBoxProps {
  lines: ReturnType<typeof outsideLines>;
  /** A checkpoint of picked objects: they go only once their box is ticked. */
  picked: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The records outside the checkpoint created under records a rewind deletes,
 * that go with them. A checkpoint of everything people work in takes them
 * along; one of picked objects only once they are accepted, and keeps their
 * parents otherwise.
 */
const OutsideBox: React.FC<OutsideBoxProps> = ({ lines, picked, checked, onChange }) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1.5"
      data-testid="checkpoint-preview-outside"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('checkpoint.preview.outside.title')}
      </h3>
      <ul className="ml-4 list-disc">
        {lines.map((line) => {
          const parents = t('checkpoint.preview.outside.parents', {
            count: line.parents,
            formatted: formatNumber(line.parents),
            object: line.objectApiName,
          });
          return (
            <li
              key={`${line.objectApiName}-${line.outside}`}
              data-testid={`checkpoint-preview-outside-${line.objectApiName}-${line.outside}`}
            >
              {/* A file to delete attached outside the checkpoint too leaves
                  it as well: its links there are what goes along, said as
                  the file's, not as records created under it. */}
              {isFileShared(line)
                ? t('checkpoint.preview.outside.files', {
                    count: line.parents,
                    formatted: formatNumber(line.parents),
                    links: t('checkpoint.take.fileLinks', {
                      count: line.count,
                      formatted: formatNumber(line.count),
                    }),
                  })
                : t('checkpoint.preview.outside.line', {
                    count: line.count,
                    formatted: formatNumber(line.count),
                    outside: line.outside,
                    parents,
                  })}
            </li>
          );
        })}
      </ul>
      {picked ? (
        <>
          <Box
            checked={checked}
            onChange={onChange}
            label={t('checkpoint.preview.outside.accept')}
            testId="checkpoint-preview-accept-outside"
          />
          {!checked && (
            <p className="text-text-secondary" data-testid="checkpoint-preview-outside-otherwise">
              {t('checkpoint.preview.outside.otherwise')}
            </p>
          )}
        </>
      ) : (
        <p className="text-text-secondary">{t('checkpoint.preview.outside.everything')}</p>
      )}
    </section>
  );
};
