import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, Square, Trash2 } from 'lucide-react';
import type {
  ForgeRemovalSteps,
  ForgeSweepListing,
  ForgeTargetAutomation,
  FrozenLoadRecordsInfo,
  FrozenLoadReportInfo,
  FrozenRemovalResult,
} from '@sandforge/shared';
import {
  firedOnRemovalStepsOf,
  mutePlanOf,
  removalStepsBypassesOf,
  removalStepsWrites,
  sweepTakenObjects,
} from '@sandforge/shared';
import { formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { AutomationMuteBox } from '../../components/ui/AutomationMuteBox';
import { RewindBeforeRun } from '../../components/ui/RewindBeforeRun';
import { RewoundMark } from '../../components/ui/RewoundMark';
import { useRewoundMarks } from '../../hooks/useRewoundMarks';
import { muteOffered } from '../../utils/muteOffer';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
  removalConfirmLabel,
} from '../Forge/ForgeRunRemovalView';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import {
  ForgeSweepListingView,
  useRemovalSweep,
  type SweepTicks,
} from '../Forge/ForgeRemovalSweep';
import {
  DELETE_WHEN_KEYS,
  RemovalAutomationView,
  type RemovalAutomationShown,
  type RemovalAutomationWords,
} from '../Forge/ForgeRemovalAutomation';
import { FrozenReloadRefused } from './FrozenReloadRefused';
import { frozenErrorWords } from './frozenErrorWords';

/**
 * How long a removal may keep the page waiting: Production Guard may wait on
 * a person, and a load can hold as many records as the dataset's budget.
 */
const REMOVAL_TIMEOUT_MS = 1_800_000;

/** How long the read of what a sweep would take may take: the target's automation, then one read per object. */
const SWEEP_READ_TIMEOUT_MS = 150_000;

/** How long the read of what the removal fires may take: the extension gives up after 60 seconds. */
const AUTOMATION_READ_TIMEOUT_MS = 90_000;

/** What `frozen:remove` answers. */
interface RemoveAnswer {
  result: FrozenRemovalResult;
  operationId: string;
}

/** What `frozen:remove:sweep` answers. */
interface SweepAnswer {
  loadedAt: string;
  listing: ForgeSweepListing;
}

/** What `frozen:remove:automation` answers. */
interface AutomationAnswer {
  loadedAt: string;
  automation: ForgeTargetAutomation;
  steps: ForgeRemovalSteps;
}

/** What the confirmation's automation section says, as a removal takes a load back. */
const AUTOMATION_WORDS: RemovalAutomationWords = {
  title: 'frozen.removal.automationTitle',
  loading: 'frozen.removal.automationLoading',
  intro: 'frozen.removal.automationIntro',
  none: 'frozen.removal.automationNone',
  error: 'frozen.removal.automationError',
};

/** Props for {@link FrozenRemovalAutomation}. */
interface FrozenRemovalAutomationProps {
  /** The org the load wrote to, registered. */
  orgId: string;
  /** When the load wrote its last record: which load. */
  loadedAt: string;
  /** The org as the user knows it. */
  org: string;
  /** The objects a sweep ticked with the removal deletes records of. */
  sweptObjects: readonly string[];
  /** Read for a reload's purge, which takes what every load before it left. */
  reload?: boolean;
  mute: { checked: boolean; onChange: (checked: boolean) => void };
  /**
   * Told what the read shown covers — the objects it read what fires on —,
   * `'failed'` once the read failed, which the section says, and undefined
   * while none answered: what the removal's confirmation waits for.
   */
  onRead?: (covered: readonly string[] | 'failed' | undefined) => void;
}

/**
 * What the target runs as the removal takes the load back, read as the
 * confirmation opens and listed before the user types the org's name: what
 * fires as it sets an activated order back to Draft, then before and after
 * each delete, what a sweep ticked with it deletes among them, read again as
 * the ticks change it. A removal of a load fired the target's flows with no
 * question and no way to keep them quiet. Where a bypass silences something of
 * it, the box that mutes it for the removal is offered under it, planned from
 * the same steps; the read shown stays until the answer lands. A reload's
 * confirmation shows it too: its purge deletes as a removal does.
 */
export const FrozenRemovalAutomation: React.FC<FrozenRemovalAutomationProps> = ({
  orgId,
  loadedAt,
  org,
  sweptObjects,
  reload = false,
  mute,
  onRead,
}) => {
  const read = useBridgeMutation<AutomationAnswer>('frozen:remove:automation', {
    responseType: 'frozen:remove:automation:response',
    errorType: 'frozen:remove:automation:error',
    timeoutMs: AUTOMATION_READ_TIMEOUT_MS,
  });
  const { mutate } = read;
  // A new request clears the answer it waits on: the last one is shown
  // meanwhile.
  const [lastRead, setLastRead] = useState<AutomationAnswer | null>(null);
  // By value: a new list of the same objects reads nothing again.
  const swept = sweptObjects.join(',');
  const readAgain = useCallback(
    () =>
      mutate({
        targetOrgId: orgId,
        loadedAt,
        ...(swept !== '' ? { sweptObjects: swept.split(',') } : {}),
        ...(reload ? { reload: true } : {}),
      }),
    [orgId, loadedAt, swept, reload, mutate],
  );
  useEffect(() => {
    setLastRead(null);
  }, [orgId, loadedAt]);
  useEffect(() => {
    readAgain();
  }, [readAgain]);
  useEffect(() => {
    if (read.data) setLastRead(read.data);
  }, [read.data]);
  const answer = read.data ?? lastRead;
  const shown: RemovalAutomationShown | undefined =
    answer && answer.loadedAt === loadedAt
      ? {
          automation: answer.automation,
          entries: firedOnRemovalStepsOf(answer.automation, answer.steps).map((fired) => ({
            part: fired.step,
            fired,
            whyKey:
              fired.step === 'delete'
                ? DELETE_WHEN_KEYS[fired.when]
                : 'runRemoval.automation.drafted',
          })),
          bypasses: removalStepsBypassesOf(answer.automation, answer.steps),
        }
      : undefined;
  const planned =
    shown && answer ? mutePlanOf(answer.automation, removalStepsWrites(answer.steps)) : null;
  // A reload's box is the one beside Load, whose mute the load plans as it
  // starts, from its inserts and its purge: offered whatever this read of the
  // purge finds. Offered nothing while the read was on its way, it unticked
  // the box beside Load, and the reload ran unmuted.
  const offer = reload && !muteOffered(planned) ? 'atStart' : planned;
  // By value: what the read shown covers, told up as it changes. A failed
  // read is said by the section, and covers nothing.
  const covered = read.error
    ? null
    : shown && answer
      ? [...(answer.steps.setToDraft ?? []), ...(answer.steps.delete ?? [])].join(',')
      : undefined;
  useEffect(() => {
    onRead?.(covered === null ? 'failed' : covered?.split(','));
  }, [covered, onRead]);
  useEffect(() => () => onRead?.(undefined), [onRead]);
  return (
    <RemovalAutomationView
      testId="frozen-removal-automation"
      org={org}
      targetOrgId={orgId}
      words={AUTOMATION_WORDS}
      shown={shown}
      error={read.error}
      reading={read.loading}
      onReadAgain={readAgain}
      after={
        <AutomationMuteBox
          offer={offer}
          checked={mute.checked}
          onChange={mute.onChange}
          org={org}
          testId="frozen-removal-automation-mute"
        />
      }
    />
  );
};

/** Props for {@link FrozenRemovalSweep}. */
interface FrozenRemovalSweepProps {
  /** The org the load wrote to, registered. */
  orgId: string;
  /** When the load wrote its last record: which load. */
  loadedAt: string;
  /** The org as the user knows it. */
  org: string;
  /** The ticks under the list: what it keeps, taken too. */
  ticks: SweepTicks;
  onTicksChange: (ticks: SweepTicks) => void;
  /**
   * Told what it read, `'failed'` once its read failed, null until it has:
   * what the confirmation reads the automation of, and waits for.
   */
  onListing: (listing: ForgeSweepListing | 'failed' | null) => void;
}

/**
 * What a sweep asked with the removal would take, read as the confirmation's
 * sweep is ticked and listed before the user types the org's name: what the
 * target's automation made for the load, as its user, that the load's mapping
 * does not hold, what it keeps and the ticks that take that too — Forge's
 * sweep, listed as Forge lists it. Read only; the sweep reads again as the
 * removal begins, and takes what it can before the load's records go.
 */
const FrozenRemovalSweep: React.FC<FrozenRemovalSweepProps> = ({
  orgId,
  loadedAt,
  org,
  ticks,
  onTicksChange,
  onListing,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const read = useBridgeMutation<SweepAnswer>('frozen:remove:sweep', {
    responseType: 'frozen:remove:sweep:response',
    errorType: 'frozen:remove:sweep:error',
    timeoutMs: SWEEP_READ_TIMEOUT_MS,
  });
  const { mutate } = read;
  useEffect(() => {
    mutate({ targetOrgId: orgId, loadedAt });
  }, [orgId, loadedAt, mutate]);
  const listing = read.data?.loadedAt === loadedAt ? read.data.listing : null;
  const failed = read.error !== null;
  useEffect(() => {
    onListing(failed ? 'failed' : listing);
  }, [listing, failed, onListing]);
  useEffect(() => () => onListing(null), [onListing]);

  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="frozen-sweep-error" className="text-status-warning">
        {t('frozen.removal.sweepError', { org, reason: read.error })}
      </p>
    );
  } else if (!listing) {
    body = (
      <p data-testid="frozen-sweep-loading" className="text-text-secondary">
        {t('frozen.removal.sweepLoading', { org })}
      </p>
    );
  } else {
    body = <ForgeSweepListingView listing={listing} ticks={ticks} onTicksChange={onTicksChange} />;
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="frozen-removal-sweep"
      className="mt-2 flex flex-col gap-1 text-[11px] text-text-primary"
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t('frozen.removal.sweepTitle', { org })}
      </h4>
      {body}
    </section>
  );
};

/** The records a load created that the platform does not delete, per object, in words. */
function keptObjects(kept: NonNullable<FrozenLoadRecordsInfo['keptByThePlatform']>): string {
  return kept.map((object) => `${object.objectApiName} (${object.count})`).join(', ');
}

/** How far a load's last write may lie past its report's end, as two clocks read it. */
const REPORT_MARGIN_MS = 2 * 60_000;

/**
 * The report of the load the card shows, when the load is the one this tab
 * has the report of: the mapping keeps neither when a load began nor the
 * checkpoint it took, which only its report says. Undefined for a load of an
 * earlier session, or of another org.
 */
function reportOfTheLoad(
  records: FrozenLoadRecordsInfo,
  report: FrozenLoadReportInfo | undefined,
): FrozenLoadReportInfo | undefined {
  if (!report || report.orgId !== records.orgId || records.earlier) return undefined;
  const started = Date.parse(report.startedAt);
  const lastWrite = Date.parse(records.loadedAt);
  if (!Number.isFinite(started) || !Number.isFinite(lastWrite)) return undefined;
  const ended = started + report.durationMs + REPORT_MARGIN_MS;
  return lastWrite >= started - REPORT_MARGIN_MS && lastWrite <= ended ? report : undefined;
}

/** Props for {@link FrozenLoadRemoval}. */
export interface FrozenLoadRemovalProps {
  /**
   * The records of the last load into the target the tab has selected, as the
   * sas mapping of that org names them; absent when no load went into it.
   */
  records: FrozenLoadRecordsInfo | undefined;
  /**
   * Read the module status again, once per answer to a removal: once the
   * load's records went, it carries the mark; once a removal is refused for a
   * load the sas no longer holds as shown, it names the one a removal takes now.
   */
  onAnswered: () => void;
  /** A load runs from this page: nothing is removed until it ends. */
  busy?: boolean;
  /** The report of the last load this tab ran: what took it back, and what it took first. */
  lastReport?: FrozenLoadReportInfo;
  /**
   * A reload into this org the extension refused, in its words, before it
   * wrote anything: a removal of the loads it replaces would leave records.
   * The card says so and offers to take this load back first, the records
   * changed since included, with the removal's own typed confirmation;
   * `onDismiss` once that removal is confirmed, or cancelled from the card.
   */
  reloadRefusal?: { message: string; onDismiss: () => void };
}

/**
 * The last load, and the removal of the records it created.
 *
 * Taking a load back used to mean a reload, whose purge deletes what the last
 * load wrote only to write the dataset again. This removes what the load
 * created and nothing else — the extension reads which records from the sas
 * mapping — with Forge's removal: the confirmation names the org, typed, the
 * records per object and what the target runs as they go, with the box that
 * mutes it; what the load linked to or reused stays. A removal
 * that left some of them in the org — kept, or refused — says so on the card,
 * which then offers to remove what is left. Once the last load's records all
 * went, the card offers the load before it whose records the loads after it
 * left in the org, and says so. A removal under way can be cancelled from the
 * card, as from Live Operations: it stops between two calls to the org, and
 * what it did not reach is offered for the next removal.
 */
export const FrozenLoadRemoval: React.FC<FrozenLoadRemovalProps> = ({
  records,
  onAnswered,
  busy = false,
  lastReport,
  reloadRefusal,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const report = records ? reportOfTheLoad(records, lastReport) : undefined;
  const markOf = useRewoundMarks(report === undefined);
  const [confirming, setConfirming] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const { sweep, setSweep, ticks, setTicks, asked } = useRemovalSweep();
  /** What the sweep's list says, while it is shown: what fires as its records go is read with the load's. */
  const [sweepListing, setSweepListing] = useState<ForgeSweepListing | 'failed' | null>(null);
  /** What the automation section's read covers, or that it failed: see `FrozenRemovalAutomation`. */
  const [automationRead, setAutomationRead] = useState<readonly string[] | 'failed' | undefined>(
    undefined,
  );
  /** The confirmation's box: the removal mutes what it fires, through the target's own bypass. */
  const [muteAutomation, setMuteAutomation] = useState(false);
  const removal = useBridgeMutation<RemoveAnswer>('frozen:remove', {
    responseType: 'frozen:remove:response',
    errorType: 'frozen:remove:error',
    timeoutMs: REMOVAL_TIMEOUT_MS,
  });
  // The removal runs under the id of the request that started it, as a load
  // does: Cancel stops it between two calls to the org, never in one, and its
  // answer says what went and what stays, which a removal later takes. Only
  // Live Operations could stop it, while the card said it was removing.
  const { requested: cancelRequested, cancel: cancelRemoval } = useOperationCancel(
    removal.requestId,
    {
      title: t('frozen.removal.cancelRefused'),
      message: t('frozen.removal.cancelRefusedDetail'),
    },
  );

  // Once per answer, whatever the caller hands in: a callback made anew on
  // every render of the page asked for the status again on every render the
  // status itself caused.
  const onAnsweredRef = useRef(onAnswered);
  useEffect(() => {
    onAnsweredRef.current = onAnswered;
  }, [onAnswered]);
  const answered = removal.data;
  useEffect(() => {
    if (answered) onAnsweredRef.current();
  }, [answered]);
  // A refusal is an answer too. Refused for a load the sas no longer held as
  // shown — another load recorded since — the card went on offering the one
  // it showed, and was refused again: the status is the page's, read once
  // when it opens, and opening the Load tab again read nothing.
  const refused = removal.error;
  useEffect(() => {
    if (refused) onAnsweredRef.current();
  }, [refused]);

  if (!records) return null;

  const org = orgs.find((o) => o.id === records.orgId)?.alias;
  const date = formatStoredDate(records.loadedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown');
  const created = records.created.reduce((sum, object) => sum + object.count, 0);
  const rewound = report
    ? markOf({
        orgId: records.orgId,
        startedAt: report.startedAt,
        endedAt: records.loadedAt,
        objects: report.perObject.map((object) => object.objectApiName),
        ...(report.checkpoint?.state === 'taken'
          ? { checkpointId: report.checkpoint.checkpointId }
          : {}),
      })
    : undefined;

  const confirmRemoval = (): void => {
    removal.mutate({
      targetOrgId: records.orgId,
      loadedAt: records.loadedAt,
      ...(includeChanged ? { includeChanged: true } : {}),
      ...asked,
      ...(muteAutomation ? { muteAutomation: true } : {}),
    });
    setConfirming(false);
    // The way out the refused reload offered is taken: the load is going.
    reloadRefusal?.onDismiss();
  };

  /** Open the confirmation, with the records changed since included or not. */
  const askRemoval = (changedToo: boolean): void => {
    setIncludeChanged(changedToo);
    setSweep(false);
    setMuteAutomation(false);
    setConfirming(true);
  };

  /** The confirmation again, its sweep ticked by this gesture and its list read. */
  const askSweep = (): void => {
    setIncludeChanged(false);
    setSweep(true);
    setMuteAutomation(false);
    setConfirming(true);
  };

  /** What the sweep's list says it takes, ticked: what fires as those records go. */
  const sweptObjects =
    sweep && sweepListing && sweepListing !== 'failed'
      ? sweepTakenObjects(sweepListing, ticks)
      : [];
  /** Nothing of the load left: the sweep alone is what the confirmation is for. */
  const sweepAlone = created === 0 && sweep;
  // A sweep is confirmed once what it takes has been read, and what fires as
  // it deletes it: before, the section had read the load's objects alone and
  // could say nothing ran, and the sweep's deletes fired their flows unasked.
  // A read of what fires that failed is said in the section, as it is of the
  // load's objects.
  const sweepHeld = !sweep
    ? undefined
    : sweepListing === 'failed'
      ? t('frozen.removal.heldUnread', { org: org ?? '' })
      : sweepListing === null ||
          (automationRead !== 'failed' &&
            !sweptObjects.every((object) => automationRead?.includes(object)))
        ? t('frozen.removal.heldReading', { org: org ?? '' })
        : undefined;
  // When the last removal ended, said with its mark above the action and not
  // in its place: a removal that left records in the org marked the load,
  // and the card offered nothing more while the status still counted them.
  const removedOn = records.removed
    ? (formatStoredDate(records.removed.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'))
    : undefined;
  let action: React.ReactNode = null;
  const removable = records.recorded && created > 0 && org !== undefined;
  if (!records.recorded) {
    action = (
      <p data-testid="frozen-removal-not-recorded" className="text-[11px] text-text-secondary">
        {t('frozen.removal.notRecorded')}
      </p>
    );
  } else if (created === 0) {
    // Once a removal took them all, its mark alone says so; and what the
    // platform keeps is said below, not counted as nothing created.
    if (!records.removed && !records.keptByThePlatform) {
      action = (
        <p data-testid="frozen-removal-nothing" className="text-[11px] text-text-secondary">
          {t('frozen.removal.nothingCreated')}
        </p>
      );
    } else if (records.removed && org) {
      // Nothing of the load left to remove: what the target's automation made
      // for it may be, a sweep that failed having left it, and the sweep
      // alone is offered, as for a run of Forge.
      action = (
        <Button
          variant="secondary"
          size="sm"
          icon={<Eraser size={11} />}
          loading={removal.loading}
          disabled={removal.loading || busy}
          onClick={askSweep}
          data-testid="frozen-removal-sweep-alone"
          className="self-start text-[11px]"
        >
          {t('frozen.removal.sweepAction')}
        </Button>
      );
    }
  } else if (!org) {
    action = (
      <p data-testid="frozen-removal-org-gone" className="text-[11px] text-text-secondary">
        {t('frozen.removal.orgGone')}
      </p>
    );
  } else {
    action = (
      <Button
        variant="secondary"
        size="sm"
        icon={<Trash2 size={11} />}
        loading={removal.loading}
        disabled={removal.loading || busy}
        onClick={() => askRemoval(false)}
        data-testid="frozen-removal-remove"
        className="self-start text-[11px]"
      >
        {records.removed ? t('frozen.removal.removeLeft') : t('frozen.removal.remove')}
      </Button>
    );
  }

  return (
    <Card className="border border-subtle bg-surface-1">
      <CardBody>
        <div className="flex flex-col gap-2" data-testid="frozen-removal">
          <h2 className="text-sm font-semibold text-text-primary">
            {records.earlier ? t('frozen.removal.titleEarlier') : t('frozen.removal.title')}
          </h2>
          <p className="text-[11px] text-text-secondary" data-testid="frozen-removal-loaded">
            {t('frozen.removal.loadedInto', { org: org ?? records.orgId, date })}
          </p>
          {records.earlier && (
            <p className="text-[11px] text-text-secondary" data-testid="frozen-removal-earlier">
              {t('frozen.removal.earlierNote', { org: org ?? records.orgId })}
            </p>
          )}
          {/* Above what the card offers: the removal it opens is that one. */}
          {reloadRefusal && (
            <FrozenReloadRefused
              message={reloadRefusal.message}
              org={org ?? records.orgId}
              canTakeBack={removable && !removal.loading && !busy}
              onTakeBack={() => askRemoval(true)}
              onCancel={reloadRefusal.onDismiss}
            />
          )}
          {records.removed && removedOn !== undefined && (
            <ForgeRunRemovalMark mark={records.removed} date={removedOn} />
          )}
          {/* Never sent to be deleted: the platform deletes none of them, and
              sent, they were refused and the load offered for removal again. */}
          {records.keptByThePlatform && records.keptByThePlatform.length > 0 && (
            <p className="text-[11px] text-text-secondary" data-testid="frozen-removal-kept">
              {t('frozen.removal.keptByThePlatform', {
                org: org ?? records.orgId,
                objects: keptObjects(records.keptByThePlatform),
              })}
            </p>
          )}
          {rewound && <RewoundMark mark={rewound} testId="frozen-removal-rewound" />}
          {action}
          {removal.loading && (
            <div className="flex flex-wrap items-center gap-2">
              <p
                role="status"
                className="text-[11px] text-text-secondary"
                data-testid="frozen-removal-removing"
              >
                {cancelRequested ? t('frozen.removal.stopping') : t('frozen.removal.removing')}
              </p>
              {removal.requestId && (
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Square size={11} />}
                  disabled={cancelRequested}
                  focusableWhenDisabled
                  onClick={cancelRemoval}
                  data-testid="frozen-removal-cancel"
                  className="text-[11px]"
                >
                  {t('frozen.removal.cancel')}
                </Button>
              )}
            </div>
          )}
          {removal.error && (
            <ErrorBanner
              message={
                frozenErrorWords(
                  { code: removal.errorCode ?? undefined },
                  t,
                  (id) => orgs.find((o) => o.id === id)?.alias ?? id,
                ) ?? removal.error
              }
              code={removal.errorCode}
              data-testid="frozen-removal-error"
            />
          )}
          {removal.data && (
            <ForgeRunRemovalResult
              result={removal.data.result}
              org={org ?? records.orgId}
              subject="load"
              {...(removable && !removal.loading && !busy ? { onTakeBackMade: askSweep } : {})}
            />
          )}
          {/* Under a removal that ended, which took back what the load created
              alone: the load's report offers the rewind until then. */}
          {records.removed && (
            <RewindBeforeRun
              checkpoint={report?.checkpoint}
              orgId={records.orgId}
              beside="load"
              compact
              leftByRemoval={records.removed.kept + records.removed.refused > 0}
              muted={report?.mutedAutomation !== undefined}
              testId="frozen-removal-checkpoint"
            />
          )}
        </div>
      </CardBody>
      <DangerConfirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirmRemoval}
        // A sweep alone deletes what its list takes, none of the load's
        // records, which went: said in the removal's words, it named them, and
        // what an earlier removal "left" over no record.
        title={
          sweepAlone
            ? t('frozen.removal.sweepAloneTitle', { org: org ?? '' })
            : t('frozen.removal.removeTitle', { org: org ?? '' })
        }
        description={
          sweepAlone
            ? t('frozen.removal.sweepAloneDescription', { org: org ?? '' })
            : t('frozen.removal.removeDescription', { org: org ?? '' })
        }
        confirmText={org ?? ''}
        confirmLabel={removalConfirmLabel(t, records.created, sweep)}
        {...(sweepHeld !== undefined ? { held: sweepHeld } : {})}
      >
        {!sweepAlone && (
          <ForgeRunRemovalPlan
            plan={records.created}
            linked={records.linked}
            {...(removedOn !== undefined ? { leftBy: removedOn } : {})}
          />
        )}
        {/* A sweep alone fires what goes with what its list takes, and nothing before. */}
        {(created > 0 || sweptObjects.length > 0) && (
          <FrozenRemovalAutomation
            orgId={records.orgId}
            loadedAt={records.loadedAt}
            org={org ?? ''}
            sweptObjects={sweptObjects}
            mute={{ checked: muteAutomation, onChange: setMuteAutomation }}
            onRead={setAutomationRead}
          />
        )}
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChanged}
            onChange={(e) => setIncludeChanged(e.target.checked)}
            data-testid="frozen-removal-include-changed"
          />
          {t('frozen.removal.includeChanged')}
        </label>
        {/* Never ticked unasked: a sweep deletes records the load did not write.
            Alone, it is what the confirmation is for. */}
        {created > 0 && (
          <label className="flex items-center gap-2 mt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={sweep}
              onChange={(e) => setSweep(e.target.checked)}
              data-testid="frozen-removal-sweep-toggle"
            />
            {t('frozen.removal.sweep')}
          </label>
        )}
        {sweep && confirming && (
          <FrozenRemovalSweep
            orgId={records.orgId}
            loadedAt={records.loadedAt}
            org={org ?? ''}
            ticks={ticks}
            onTicksChange={setTicks}
            onListing={setSweepListing}
          />
        )}
      </DangerConfirm>
    </Card>
  );
};
