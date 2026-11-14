import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useReducedMotion } from 'framer-motion';
import { ShieldAlert, X } from 'lucide-react';
import {
  FORGE_READ_CEILING_PER_OBJECT,
  FORGE_ROOTS_DEFAULT,
  FORGE_ROOTS_MAX,
  type ForgeRunGateCode,
  type ForgeRunGateStop,
  type ForgeSampleDraw,
  type WholeOrgSampleLimit,
} from '@sandforge/shared';
import { checkpointRefusalWords } from '../../utils/runCheckpoint';
import { RewindBeforeRun } from '../../components/ui/RewindBeforeRun';
import { Button } from '../../components/ui/Button';
import { useForgeStore } from '../../stores/useForgeStore';
import { uiLocale } from '../../utils/formatters';
import { useForgeRunGateStore } from './runGate';
import { clonesWholeOrg } from './forgeRunConfig';
import { startForgeRun } from './startForgeRun';
import { mbOf } from './sampleWords';
import { openSampleRoots } from './ReviewSampleRoots';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';

/**
 * The sentence each stop is said in, unless the run's checkpoint first has
 * one of its own ({@link sentenceOf}).
 */
const STOP_KEYS: Record<ForgeRunGateCode, string> = {
  PRODUCTION_TARGET: 'forgeRun.gate.productionTarget',
  AUTOMATION_DECLINED: 'forgeRun.gate.automationDeclined',
  READ_DECLINED: 'forgeRun.gate.readDeclined',
  WRITE_DECLINED: 'forgeRun.gate.writeDeclined',
  STORAGE_EXCEEDED: 'forgeRun.gate.storageExceeded',
  CONFIRMATION_UNAVAILABLE: 'forgeRun.gate.confirmationUnavailable',
  CHECKPOINT_REFUSED: 'forgeRun.gate.checkpointRefused',
  API_BUDGET_EXCEEDED: 'forgeRun.gate.apiBudgetExceeded',
  READ_BOUND_EXCEEDED: 'forgeRun.gate.readBoundExceeded',
  FILES_UNREAD: 'forgeRun.gate.filesUnread',
  FILE_STORAGE_UNREAD: 'forgeRun.gate.fileStorageUnread',
  // Of a run that clones no whole org, said as a clone of the whole org's
  // refusal for its files: what they take, and what the target has left.
  FILE_STORAGE_EXCEEDED: 'forgeRun.gate.storageExceededFiles',
  // A sample of the whole org refused before it wrote anything.
  SAMPLE_STORAGE_UNREAD: 'forgeRun.gate.sampleStorageUnread',
  SAMPLE_CANNOT_FIT: 'forgeRun.gate.sampleCannotFit',
  SAMPLE_TOO_LARGE: 'forgeRun.gate.sampleTooLarge',
  SAMPLE_PLAN_MISMATCH: 'forgeRun.gate.samplePlanMismatch',
  SAMPLE_PLAN_GONE: 'forgeRun.gate.samplePlanGone',
  SAMPLE_DRAW_INVALID: 'forgeRun.gate.sampleDrawInvalid',
  SAMPLE_DRAW_EMPTY: 'forgeRun.gate.sampleDrawEmpty',
  // A clone from the records a query chooses refused for them, before it
  // wrote anything.
  ROOTS_QUERY_REFUSED: 'forgeRun.gate.rootsQueryRefused',
  NO_ROOTS: 'forgeRun.gate.noRoots',
  ROOTS_EXCEEDED: 'forgeRun.gate.rootsExceeded',
  ROOTS_PLAN_MISMATCH: 'forgeRun.gate.rootsPlanMismatch',
  ROOTS_PLAN_GONE: 'forgeRun.gate.rootsPlanGone',
};

/**
 * The sentence of a sample that cannot fit, by what held it (`limitedBy`):
 * past the data storage the target has left, no setting lets it take more,
 * and the refusal said "let the sample take more" whatever held it. What it
 * needs and may take in MB is said of the two bounds in MB alone. A bound
 * that holds no sample that cannot fit — the heavy roots, the objects copied
 * whole —, and a refusal that names none, keep the words that promise no
 * bound to raise.
 */
const CANNOT_FIT_KEYS: Partial<Record<WholeOrgSampleLimit, string>> = {
  storage: 'forgeRun.gate.sampleCannotFitStorage',
  within: 'forgeRun.gate.sampleCannotFitWithin',
  maxTotal: 'forgeRun.gate.sampleCannotFitMaxTotal',
  targetRequests: 'forgeRun.gate.sampleCannotFitTargetRequests',
  bulkBatches: 'forgeRun.gate.sampleCannotFitBulkBatches',
  sourceRequests: 'forgeRun.gate.sampleCannotFitSourceRequests',
};

/** The sentence of a sample's drawing refused for the source's requests, by how it drew. */
const DRAWING_KEYS: Record<ForgeSampleDraw, string> = {
  uniform: 'forgeRun.gate.apiDrawingExceeded',
  recent: 'forgeRun.gate.apiDrawingExceededRecent',
  oldest: 'forgeRun.gate.apiDrawingExceededOldest',
};

/** The stops of a draw refused, whose way out is in Which roots, on Review. */
const DRAW_REFUSED: ReadonlySet<ForgeRunGateCode> = new Set([
  'SAMPLE_DRAW_INVALID',
  'SAMPLE_DRAW_EMPTY',
]);

/** A stop the user chose, at one of the run's questions, rather than one the extension made. */
const CANCELLED: ReadonlySet<ForgeRunGateCode> = new Set([
  'AUTOMATION_DECLINED',
  'READ_DECLINED',
  'WRITE_DECLINED',
]);

/**
 * The key of the sentence a stop is said in: a checkpoint refused by what
 * refused it; the day's API requests with the checkpoint among them only
 * when the run was to take one; and of a clone of the whole org, which
 * storage, which allowance of which org — its source's requests, its
 * target's Bulk API batches — refused it, in words that name what it can
 * leave out rather than a cap it does not have; files that could not be
 * looked up, by what looked them up; a sample whose target has less room
 * than it was fitted to, by what it was fitted to and what the target holds
 * now; a refusal of a sample as the executor raises it, with no figure, in
 * words that need none, and a run resumed otherwise than it was set up apart
 * from a plan of another org or setup.
 */
function sentenceOf(
  stop: ForgeRunGateStop,
  checkpointAsked: boolean,
  wholeOrg: boolean,
  muteOffered: boolean,
  sampled: boolean,
): string {
  if (stop.code === 'CHECKPOINT_REFUSED' && stop.reason !== undefined) {
    return 'forgeRun.gate.checkpointRefusedFor';
  }
  if (stop.code === 'SAMPLE_CANNOT_FIT') {
    const limit = stop.sample?.limitedBy;
    const sized = stop.sample?.needMB !== undefined;
    const held = limit !== undefined ? CANNOT_FIT_KEYS[limit] : undefined;
    if (held && (sized || (limit !== 'storage' && limit !== 'within'))) return held;
    if (!sized) return 'forgeRun.gate.sampleCannotFitNamed';
  }
  // Cancelled at the question of what the target runs: muting it is the way
  // to say only where Review offers it, ticking it is what is asked.
  if (stop.code === 'AUTOMATION_DECLINED' && muteOffered) {
    return 'forgeRun.gate.automationDeclinedMute';
  }
  // A sample's drawing past its share of what the source has left: said as
  // the drawing's, not as a run past all the source has left, with the way
  // its draw leaves — a drawing of the oldest in its own words, where it was
  // said in those of the newest.
  if (stop.code === 'API_BUDGET_EXCEEDED' && stop.api?.drawing) {
    return DRAWING_KEYS[stop.api.drawing.draw];
  }
  if (stop.code === 'SAMPLE_TOO_LARGE' && stop.sample?.rows === undefined) {
    return 'forgeRun.gate.sampleTooLargeUnsized';
  }
  if (stop.code === 'SAMPLE_PLAN_MISMATCH' && stop.sample?.plan === undefined) {
    return 'forgeRun.gate.samplePlanMismatchResume';
  }
  if (stop.code === 'STORAGE_EXCEEDED') {
    if (stop.sample?.fittedMB !== undefined) return 'forgeRun.gate.sampleTargetMoved';
    if (stop.storage?.kind === 'files') return 'forgeRun.gate.storageExceededFiles';
    if (wholeOrg) return 'forgeRun.gate.storageExceededAll';
  }
  if (stop.code === 'API_BUDGET_EXCEEDED' && stop.api) {
    // A sample that fits takes fewer requests and batches with its records:
    // named to a clone of every record of the whole org, never to a sample.
    const offered = wholeOrg && !sampled;
    if (stop.api.kind === 'bulkBatches') {
      return offered
        ? 'forgeRun.gate.bulkBatchesExceededSample'
        : 'forgeRun.gate.bulkBatchesExceeded';
    }
    if (stop.api.org === 'source') {
      return offered
        ? 'forgeRun.gate.apiRequestsExceededSourceSample'
        : 'forgeRun.gate.apiRequestsExceededSource';
    }
    return offered
      ? 'forgeRun.gate.apiRequestsExceededTargetSample'
      : 'forgeRun.gate.apiRequestsExceededTarget';
  }
  if (stop.code === 'API_BUDGET_EXCEEDED' && checkpointAsked) {
    return 'forgeRun.gate.apiBudgetExceededWithCheckpoint';
  }
  // Of any other run, its file copier refused the files of the records it
  // read, some of which it could not look up: the source did not fail to sum
  // the org's files, which only a clone of the whole org asks.
  if (stop.code === 'FILES_UNREAD' && !wholeOrg) return 'forgeRun.gate.filesUnreadRecords';
  return STOP_KEYS[stop.code];
}

/**
 * Whether a stop's words ask for the run to be simulated again: a sample
 * fitted to more room than the target has left now, or a plan drawn for
 * another org or setup. Of a resume set up otherwise, the words ask to
 * resume it as it was set up.
 */
function asksToSimulateAgain(stop: ForgeRunGateStop): boolean {
  if (stop.code === 'STORAGE_EXCEEDED') return stop.sample?.fittedMB !== undefined;
  return stop.code === 'SAMPLE_PLAN_MISMATCH' && stop.sample?.plan !== undefined;
}

/**
 * What a stop of a run's gate is said in, in the interface language: the
 * notice on Review says it of the run that stopped, the dry run of a clone of
 * the whole org of each refusal its run would meet.
 *
 * @param run.checkpointAsked - The run was to take a checkpoint first.
 * @param run.wholeOrg - The run clones the whole org.
 * @param run.muteOffered - Review offers to mute the target's automation and it is not ticked.
 * @param run.sampled - The run copies a sample of the whole org rather than every record.
 */
export function gateStopSentence(
  t: TFunction,
  stop: ForgeRunGateStop,
  run: { checkpointAsked: boolean; wholeOrg: boolean; muteOffered?: boolean; sampled?: boolean },
): string {
  const locale = uiLocale();
  return t(
    sentenceOf(
      stop,
      run.checkpointAsked,
      run.wholeOrg,
      run.muteOffered === true,
      run.sampled === true,
    ),
    {
      // The share of what the source has left a sample's drawing may read.
      share: Math.round((stop.api?.drawing?.share ?? 0) * 100).toLocaleString(locale),
      estimate: (stop.api?.estimate ?? stop.storage?.estimateMB ?? 0).toLocaleString(locale),
      remaining: (stop.api?.remaining ?? stop.storage?.remainingMB ?? 0).toLocaleString(locale),
      // The number the run held, which the settings may have raised.
      ceiling: (stop.ceiling ?? FORGE_READ_CEILING_PER_OBJECT).toLocaleString(locale),
      reason: checkpointRefusalWords(stop.reason, t),
      // A clone of the whole org refused for an object it reads whole: the
      // bound it held, and each object past it.
      bound: (stop.readBound?.bound ?? FORGE_READ_CEILING_PER_OBJECT).toLocaleString(locale),
      objects: (stop.readBound?.objects ?? []).map((o) => o.objectApiName).join(', '),
      // A sample refused: what it needs and may take, the heaviest objects,
      // the records it read and holds at once, and what it was fitted to.
      need: (stop.sample?.needMB ?? 0).toLocaleString(locale),
      budget: (stop.sample?.budgetMB ?? 0).toLocaleString(locale),
      heaviest: (stop.sample?.heaviest ?? []).join(', '),
      rows: (stop.sample?.rows ?? 0).toLocaleString(locale),
      most: (stop.sample?.most ?? 0).toLocaleString(locale),
      fitted: (stop.sample?.fittedMB ?? 0).toLocaleString(locale),
      holds: (stop.sample?.holdsMB ?? 0).toLocaleString(locale),
      // A clone from the records a query chooses: the object, the most it
      // takes, and that most as a LIMIT the query is given, never grouped.
      object: stop.roots?.objectApiName ?? '',
      cap: (stop.roots?.cap ?? FORGE_ROOTS_DEFAULT).toLocaleString(locale),
      limit: String(stop.roots?.cap ?? FORGE_ROOTS_DEFAULT),
    },
  );
}

/**
 * Why the last run stopped at its gate, said where the page goes back to —
 * Review, or the results a retry was started from: refused — a production
 * target, rows the target has no storage left for — or cancelled at a
 * question. Nothing was written either way. Shown until the next run starts
 * or it is dismissed.
 *
 * Brought into view and handed the keyboard once per stop. The page comes
 * back as far down as the execution screen was: followed down while the run
 * read and asked its questions, or, once that screen's step had loaded, kept
 * as far down as Review was when Execute was pressed at its foot. In a panel
 * too narrow for Review's run column, the notice at the head of the rows was
 * then above the fold, nothing changed where the user looked, and the
 * keyboard on the step around it. The scroll is smooth unless the system
 * asks for reduced motion — the stylesheet's rule for it does not stop a
 * smooth scroll asked for in code — and the focus is taken only when it is
 * free: nowhere, or within the page, as the phase group the page hands it to
 * on each phase. A control elsewhere keeps it.
 */
export const ForgeRunGateNotice: React.FC<{
  /**
   * Review offers to mute the target's automation for the run, unticked:
   * a run cancelled at the question of what the target runs is told to tick
   * it. Absent where nothing offers it, as on the results.
   */
  muteOffered?: boolean;
}> = ({ muteOffered = false }) => {
  const { t } = useTranslation();
  const stop = useForgeRunGateStore((s) => s.stop);
  const checkpointAsked = useForgeRunGateStore((s) => s.checkpointAsked);
  const checkpoint = useForgeRunGateStore((s) => s.checkpoint);
  const clear = useForgeRunGateStore((s) => s.clear);
  const revealed = useForgeRunGateStore((s) => s.revealed);
  const markRevealed = useForgeRunGateStore((s) => s.markRevealed);
  const sampleOffer = useForgeRunGateStore((s) => s.sampleOffer);
  const said = useForgeRunGateStore((s) => s.said);
  const targetOrgId = useForgeStore((s) => s.config?.targetOrgId);
  const wholeOrg = useForgeStore((s) => clonesWholeOrg(s.config));
  const sampled = useForgeStore((s) => s.config?.sample !== undefined);
  const sample = useForgeStore((s) => s.config?.sample);
  // What the notice offers to do is done from Review alone: the results a
  // retry stopped on are another run's.
  const onReview = useForgeStore((s) => s.phase === 'review');
  const setSample = useForgeStore((s) => s.setSample);
  const noticeRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  /*
   * A frame later rather than in the effect: the page hands the phase drawn
   * the focus in its own effect (`useFocusOnChange`), and a parent's effect
   * runs after its children's. Review drawn in the commit that changes the
   * phase would see the focus taken back; the transition between phases
   * draws it a commit later, which the frame does not count on. Marked
   * revealed within the frame, so a mount StrictMode undoes at once, its
   * frame cancelled, marks nothing.
   */
  useEffect(() => {
    if (!stop || revealed) return undefined;
    const id = requestAnimationFrame(() => {
      const el = noticeRef.current;
      if (!el) return;
      el.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      const focused = document.activeElement;
      if (focused === null || focused === document.body || focused.contains(el)) {
        el.focus({ preventScroll: true });
      }
      markRevealed();
    });
    return () => cancelAnimationFrame(id);
  }, [stop, revealed, reduceMotion, markRevealed]);

  if (!stop) return null;
  const cancelled = CANCELLED.has(stop.code);
  const simulateAgain = onReview && asksToSimulateAgain(stop);
  const offer = onReview && wholeOrg && !sampled && sampleOffer;
  // A clone of every record past the requests or the Bulk API batches left:
  // a sample takes fewer of them, offered as the words name it.
  const sampleForBudget =
    onReview &&
    wholeOrg &&
    !sampled &&
    stop.code === 'API_BUDGET_EXCEEDED' &&
    stop.api !== undefined &&
    stop.api.drawing === undefined;
  // The newest or the oldest records first read only those they keep:
  // offered to a sample drawn spread over the org whose drawing was refused,
  // from Review, where the draw is set — never the one it draws already.
  const spreadRefused = onReview && sampled && stop.api?.drawing?.draw === 'uniform';
  const newest = spreadRefused && sample?.draw !== 'recent';
  const oldest = spreadRefused && sample?.draw !== 'oldest';
  // Fewer roots read fewer requests, whatever the draw; and a draw refused
  // for the roots it was asked to draw among is set again where they are.
  const chooseRoots =
    onReview && sampled && (stop.api?.drawing !== undefined || DRAW_REFUSED.has(stop.code));
  return (
    <div
      ref={noticeRef}
      // Focusable from code only, never a stop of the Tab key.
      tabIndex={-1}
      role={cancelled ? 'status' : 'alert'}
      data-testid="forge-run-gate-notice"
      data-code={stop.code}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-text-primary focus:outline-hidden ${
        cancelled ? 'border-subtle bg-surface-1' : 'border-status-warning/40 bg-status-warning/10'
      }`}
    >
      <ShieldAlert
        size={14}
        aria-hidden="true"
        className={`mt-0.5 shrink-0 ${cancelled ? 'text-text-secondary' : 'text-status-warning'}`}
      />
      <div className="flex flex-1 flex-col gap-1">
        <p data-testid="forge-run-gate-reason">
          {gateStopSentence(t, stop, { checkpointAsked, wholeOrg, muteOffered, sampled })}
        </p>
        {/* What refused the draw — a field, a condition, a window, in its
            words or the source's —, which the sentence above can only list. */}
        {said !== undefined && (
          <p data-testid="forge-run-gate-said" className="[overflow-wrap:anywhere]">
            {t('forgeRun.gate.drawSaid', { said })}
          </p>
        )}
        {(newest || oldest || chooseRoots) && (
          <div className="flex flex-wrap items-center gap-2">
            {newest && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="forge-run-gate-draw-newest"
                onClick={() => {
                  setSample({ ...sample, draw: 'recent' });
                  clear();
                }}
              >
                {t('forgeRun.gate.drawNewest')}
              </Button>
            )}
            {oldest && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="forge-run-gate-draw-oldest"
                onClick={() => {
                  setSample({ ...sample, draw: 'oldest' });
                  clear();
                }}
              >
                {t('forgeRun.gate.drawOldest')}
              </Button>
            )}
            {/* Opens Which roots with the keyboard on it; the notice stays,
                its words beside what is changed. */}
            {chooseRoots && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="forge-run-gate-choose-roots"
                onClick={openSampleRoots}
              >
                {t('forgeRun.gate.chooseRoots')}
              </Button>
            )}
          </div>
        )}
        {/* Every record past the storage: the sample that fits, offered. */}
        {offer && (
          <div className="flex flex-wrap items-center gap-2">
            <p data-testid="forge-run-gate-sample-offer">
              {t('forgeRun.gate.sampleOffer', { mb: mbOf(offer.bytes) })}
            </p>
            <Button
              variant="secondary"
              size="sm"
              data-testid="forge-run-gate-copy-sample"
              onClick={() => {
                setSample({});
                clear();
              }}
            >
              {t('forgeRun.review.sample.offerAction')}
            </Button>
          </div>
        )}
        {sampleForBudget && (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            data-testid="forge-run-gate-copy-sample-budget"
            onClick={() => {
              setSample({});
              clear();
            }}
          >
            {t('forgeRun.review.sample.offerAction')}
          </Button>
        )}
        {/* A query choosing more records than a run takes: the setting
            that takes more, up to the most of all, opened where it is set. */}
        {stop.code === 'ROOTS_EXCEEDED' && (stop.roots?.cap ?? 0) < FORGE_ROOTS_MAX && (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            data-testid="forge-run-gate-roots-setting"
            onClick={() =>
              sendBridgeMessage<{ setting: string }>('workbench:open-setting', {
                setting: 'sandforge.forge.maxRoots',
              })
            }
          >
            {t('forge.roots.setting', { most: FORGE_ROOTS_MAX.toLocaleString(uiLocale()) })}
          </Button>
        )}
        {simulateAgain && (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            data-testid="forge-run-gate-simulate-again"
            onClick={() => startForgeRun({ dryRun: true })}
          >
            {t('forgeRun.gate.simulateAgain')}
          </Button>
        )}
        <RewindBeforeRun
          checkpoint={checkpoint}
          orgId={targetOrgId}
          beside="run"
          compact
          testId="forge-run-gate-checkpoint"
        />
      </div>
      <button
        type="button"
        data-testid="forge-run-gate-dismiss"
        onClick={clear}
        aria-label={t('common.dismiss')}
        className="shrink-0 rounded p-0.5 text-text-secondary hover:text-text-primary"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
};
