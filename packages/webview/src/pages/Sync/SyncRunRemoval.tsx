import React, { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Trash2 } from 'lucide-react';
import type {
  ForgeRemovalStep,
  ForgeRemovalSteps,
  ForgeSweepListing,
  ForgeTargetAutomation,
  SyncRemovalRefusalCode,
  SyncRemovalResult,
  SyncRunRemovalInfo,
} from '@sandforge/shared';
import { firedOnRemovalStepsOf, removalStepsBypassesOf } from '@sandforge/shared';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import {
  RestoredResult,
  UndeletedResult,
  type RestoredResultWords,
  type UndeletedResultWords,
} from '../../components/ui/RestoredResults';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
} from '../Forge/ForgeRunRemovalView';
import { ForgeSweepListingView } from '../Forge/ForgeRemovalSweep';
import {
  DELETE_WHEN_KEYS,
  RemovalAutomationView,
  type RemovalAutomationShown,
  type RemovalAutomationWords,
} from '../Forge/ForgeRemovalAutomation';
import { useOperationCancel } from '../../hooks/useOperationCancel';

/**
 * How long a removal may keep the card waiting: Production Guard may wait on a
 * person, and a run can have created many records.
 */
const REMOVAL_TIMEOUT_MS = 1_800_000;

/** Where every answer about a removal that is not one comes. */
const ERROR_CHANNEL = 'sync:remove:error';

/** How long the read of what a sweep would take may take: the target's automation, then one read per object. */
const SWEEP_READ_TIMEOUT_MS = 150_000;

/** How long the read of what the removal fires may take: the extension gives up after 60 seconds. */
const AUTOMATION_READ_TIMEOUT_MS = 90_000;

/** What the card says of a removal that cannot run, by why. */
const REFUSAL_KEYS: Record<SyncRemovalRefusalCode, string> = {
  GUARD_BLOCKED: 'runRemoval.sync.refusedGuard',
  NO_GUARD: 'runRemoval.sync.refusedNoGuard',
  ORG_GONE: 'runRemoval.sync.refusedOrgGone',
  RUNNING: 'runRemoval.sync.refusedRunning',
};

/** What `sync:remove` answers. */
interface RemoveAnswer {
  result: SyncRemovalResult;
  operationId: string;
}

/** What `sync:remove:sweep` answers. */
interface SweepAnswer {
  runId: string;
  listing: ForgeSweepListing;
}

/** What `sync:remove:automation` answers. */
interface AutomationAnswer {
  runId: string;
  automation: ForgeTargetAutomation;
  steps: ForgeRemovalSteps;
}

/** What the confirmation's automation section says, as a removal of a Sync run takes it back. */
const AUTOMATION_WORDS: RemovalAutomationWords = {
  title: 'runRemoval.sync.automationTitle',
  loading: 'runRemoval.sync.automationLoading',
  intro: 'runRemoval.sync.automationIntro',
  none: 'runRemoval.sync.automationNone',
  error: 'runRemoval.sync.automationError',
};

/** Why a step of the removal other than its delete writes the record it fires on. */
const STEP_KEYS: Readonly<Record<Exclude<ForgeRemovalStep, 'delete'>, string>> = {
  bringBack: 'runRemoval.automation.broughtBack',
  // A Sync run's removal makes nothing again: only a rewind to a checkpoint does.
  recreate: 'runRemoval.automation.recreated',
  giveBack: 'runRemoval.automation.givenBack',
  setToDraft: 'runRemoval.automation.drafted',
};

/**
 * What the target runs as the removal takes the run back, read as the
 * confirmation opens and listed before the user types the org's name, step
 * by step as the removal writes: the Apex triggers that run after an
 * undelete as it brings back from the recycle bin what the run deleted, what
 * fires as it gives back what the run wrote over and as it sets an activated
 * order back to Draft, then before and after each delete. A removal brought
 * records back from the recycle bin, and nothing said what their
 * `after undelete` triggers would run. Read again when the user asks; the
 * read shown stays until the answer lands.
 */
const SyncRemovalAutomation: React.FC<{ runId: string; org: string; targetOrgId: string }> = ({
  runId,
  org,
  targetOrgId,
}) => {
  const read = useBridgeMutation<AutomationAnswer>('sync:remove:automation', {
    responseType: 'sync:remove:automation:response',
    errorType: 'sync:remove:automation:error',
    timeoutMs: AUTOMATION_READ_TIMEOUT_MS,
  });
  const { mutate } = read;
  // A new request clears the answer it waits on: the last one is shown
  // meanwhile.
  const [lastRead, setLastRead] = useState<AutomationAnswer | null>(null);
  useEffect(() => {
    setLastRead(null);
    mutate({ runId });
  }, [runId, mutate]);
  useEffect(() => {
    if (read.data) setLastRead(read.data);
  }, [read.data]);
  const readAgain = useCallback(() => mutate({ runId }), [runId, mutate]);
  const answer = read.data ?? lastRead;
  const shown: RemovalAutomationShown | undefined =
    answer && answer.runId === runId
      ? {
          automation: answer.automation,
          entries: firedOnRemovalStepsOf(answer.automation, answer.steps).map((fired) => ({
            part: fired.step,
            fired,
            whyKey: fired.step === 'delete' ? DELETE_WHEN_KEYS[fired.when] : STEP_KEYS[fired.step],
          })),
          bypasses: removalStepsBypassesOf(answer.automation, answer.steps),
        }
      : undefined;
  return (
    <RemovalAutomationView
      testId="sync-removal-automation"
      org={org}
      targetOrgId={targetOrgId}
      words={AUTOMATION_WORDS}
      shown={shown}
      error={read.error}
      reading={read.loading}
      onReadAgain={readAgain}
    />
  );
};

/**
 * What a sweep asked with the removal would take, read as the confirmation's
 * sweep is ticked and listed before the user types the org's name: what the
 * target's automation created during the run, as its user, that the run did
 * not write — Forge's sweep, listed as Forge lists it, in its words. Read
 * only; the sweep runs before the run's records go, and finds again what is
 * there.
 */
const SyncRemovalSweep: React.FC<{ runId: string; org: string }> = ({ runId, org }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const read = useBridgeMutation<SweepAnswer>('sync:remove:sweep', {
    responseType: 'sync:remove:sweep:response',
    errorType: 'sync:remove:sweep:error',
    timeoutMs: SWEEP_READ_TIMEOUT_MS,
  });
  const { mutate } = read;
  useEffect(() => {
    mutate({ runId });
  }, [runId, mutate]);

  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="sync-sweep-error" className="text-status-warning">
        {t('runRemoval.sweep.error', { org, reason: read.error })}
      </p>
    );
  } else if (!read.data || read.data.runId !== runId) {
    body = (
      <p data-testid="sync-sweep-loading" className="text-text-secondary">
        {t('runRemoval.sweep.loading', { org })}
      </p>
    );
  } else {
    body = <ForgeSweepListingView listing={read.data.listing} />;
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="sync-removal-sweep"
      className="mt-2 flex flex-col gap-1 text-[11px] text-text-primary"
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t('runRemoval.sweep.title', { org })}
      </h4>
      {body}
    </section>
  );
};

/** What the card says of what a removal gave back of what the run wrote over. */
const RESTORED_WORDS: RestoredResultWords = {
  title: 'runRemoval.sync.restoredTitle',
  restored: 'runRemoval.sync.restored',
  keptChanged: 'runRemoval.sync.restoredKeptChanged',
  alreadyGone: 'runRemoval.sync.restoredGone',
  refused: 'runRemoval.sync.restoredRefused',
  notKept: 'runRemoval.sync.restoredNotKept',
  notReached: 'runRemoval.sync.restoredNotReached',
  restoredWithout: 'runRemoval.sync.restoredWithout',
};

/** What the card says of what a removal brought back from the recycle bin of what the run deleted. */
const UNDELETED_WORDS: UndeletedResultWords = {
  title: 'runRemoval.sync.undeletedTitle',
  undeleted: 'runRemoval.sync.undeleted',
  alreadyBack: 'runRemoval.sync.undeletedAlreadyBack',
  goneForGood: 'runRemoval.sync.undeletedGone',
  refused: 'runRemoval.sync.restoredRefused',
  notReached: 'runRemoval.sync.restoredNotReached',
};

/**
 * The later runs of the same target that wrote the run's records again: until
 * each is removed, this run's removal reads those records as changed since
 * it, and removed after it, the later one gives them back this run's values.
 */
const SyncWrittenAgain: React.FC<{
  writtenAgain: NonNullable<SyncRunRemovalInfo['writtenAgain']>;
  testId: string;
}> = ({ writtenAgain, testId }) => {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-0.5" data-testid={testId}>
      {writtenAgain.map((later) => (
        <li key={later.runId} className="text-[11px] text-text-primary">
          {t('runRemoval.sync.writtenAgain', {
            count: later.records,
            formatted: formatNumber(later.records),
            config: later.configName,
            date: formatStoredDate(later.startedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'),
          })}
        </li>
      ))}
    </ul>
  );
};

/**
 * What the card is about, by what the run left to take back: a run that
 * created nothing and only wrote over records gives them back, and one that
 * only deleted brings them back; the card, its button and its confirmation
 * said "What this run created" for every run.
 */
type RemovalKind = 'created' | 'overwritten' | 'deleted';

/** The words of the card, its button and its confirmation, by {@link RemovalKind}. */
const KIND_KEYS: Record<RemovalKind, { title: string; remove: string; removeTitle: string }> = {
  created: {
    title: 'runRemoval.sync.title',
    remove: 'runRemoval.sync.remove',
    removeTitle: 'runRemoval.sync.removeTitle',
  },
  overwritten: {
    title: 'runRemoval.sync.titleOverwritten',
    remove: 'runRemoval.sync.removeOverwritten',
    removeTitle: 'runRemoval.sync.removeTitleOverwritten',
  },
  deleted: {
    title: 'runRemoval.sync.titleDeleted',
    remove: 'runRemoval.sync.removeDeleted',
    removeTitle: 'runRemoval.sync.removeTitleDeleted',
  },
};

/** What the card is about: see {@link RemovalKind}. */
function kindOf(kept: SyncRunRemovalInfo): RemovalKind {
  if (kept.created > 0) return 'created';
  if ((kept.overwritten ?? 0) > 0) return 'overwritten';
  if ((kept.deleted ?? 0) > 0) return 'deleted';
  return 'created';
}

/**
 * The confirmation's account of what the removal does, as the run left it:
 * what it gives back first when it gives some back; that the records it
 * updated keep their new values only for a run that kept none of them,
 * written before runs kept what they wrote over. A run whose values an
 * earlier removal had all given back said it too.
 */
function descriptionKey(kept: SyncRunRemovalInfo, kind: RemovalKind): string {
  if ((kept.putBack ?? []).length > 0) {
    return kind === 'overwritten'
      ? 'runRemoval.sync.removeDescriptionPutBackOnly'
      : 'runRemoval.sync.removeDescriptionPutBack';
  }
  if (kind === 'deleted') return 'runRemoval.sync.removeDescriptionDeleted';
  if (kept.overwritten === undefined) return 'runRemoval.sync.removeDescription';
  return 'runRemoval.sync.removeDescriptionCreated';
}

/** Props for {@link SyncRunRemoval}. */
export interface SyncRunRemovalProps {
  /** The run, by the id its creations are kept under (`SyncRunCreated.runId`). */
  runId: string;
  /** Test id of the card. */
  testId?: string;
}

/**
 * What a Sync run created, and its removal: from the history entry of a run,
 * from the results of the run just made, or for a run a closed window stopped.
 *
 * What the run created is read from what it kept — nothing is asked of the
 * org until a removal's confirmation opens, and reads what the target runs as
 * the removal writes. The removal takes what the run created
 * and nothing else: the records it inserted, or upserted where the target
 * held none, and the files it created. A record it wrote over — an update,
 * an upsert that found it — is given back first the values it held before
 * the run, which the run kept, unless it changed since — and,
 * when asked, sweeps first what the target's automation created during the
 * run, as its user: a flow that opens a task on each contact left those tasks
 * behind. The confirmation names the org, typed, and the records per object;
 * a record changed since the run stays unless included. Where Production Guard allows
 * no delete — a production org, as a Forge run's removal reads it — nothing
 * is offered, and the card says why. A removal under way can be stopped from the
 * card, as from Live Operations, between two calls to the org; what it left
 * is offered again.
 */
export const SyncRunRemoval: React.FC<SyncRunRemovalProps> = ({ runId, testId }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const [confirming, setConfirming] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const [sweep, setSweep] = useState(false);
  const info = useBridgeQuery<{ info: SyncRunRemovalInfo | null }>(
    'sync:removal:info',
    { runId },
    { errorType: ERROR_CHANNEL },
  );
  const removal = useBridgeMutation<RemoveAnswer>('sync:remove', {
    responseType: 'sync:remove:response',
    errorType: ERROR_CHANNEL,
    timeoutMs: REMOVAL_TIMEOUT_MS,
  });
  const { requested: cancelRequested, cancel: cancelRemoval } = useOperationCancel(
    removal.requestId,
    {
      title: t('runRemoval.sync.cancelRefused'),
      message: t('runRemoval.sync.cancelRefusedDetail'),
    },
  );

  // Read again once per answer, a refusal included: what is left, and the mark.
  const { refetch } = info;
  const answered = removal.data;
  const refused = removal.error;
  useEffect(() => {
    if (answered || refused) refetch();
  }, [answered, refused, refetch]);

  const kept = info.data?.info;
  if (info.data && !kept) {
    return (
      <p className="text-[11px] text-text-secondary" data-testid="sync-removal-not-kept">
        {t('runRemoval.sync.notKept')}
      </p>
    );
  }
  if (!kept) return null;

  const org = orgs.find((o) => o.id === kept.targetOrgId)?.alias ?? kept.targetOrgId;
  const removedOn = kept.removed
    ? (formatStoredDate(kept.removed.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'))
    : undefined;

  /** What the run wrote over that a removal gives back now, per object. */
  const putBack = kept.putBack ?? [];
  /** What the run deleted that a removal brings back from the recycle bin now, per object. */
  const bringBack = kept.bringBack ?? [];
  const offered = kept.left.length > 0 || putBack.length > 0 || bringBack.length > 0;
  const kind = kindOf(kept);
  const words = KIND_KEYS[kind];
  const keptUntil =
    kept.putBackKeptUntil !== undefined
      ? (formatStoredDate(kept.putBackKeptUntil, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'))
      : undefined;
  let action: React.ReactNode = null;
  if (offered && kept.refusal) {
    action = (
      <div className="flex flex-col gap-0.5" data-testid="sync-removal-refused">
        <p className="text-[11px] text-text-primary">
          {t(REFUSAL_KEYS[kept.refusal.code], { org })}
        </p>
        <p className="text-[10px] text-text-secondary wrap-break-word">{kept.refusal.message}</p>
      </div>
    );
  } else if (offered) {
    action = (
      <Button
        variant="secondary"
        size="sm"
        icon={<Trash2 size={11} />}
        loading={removal.loading}
        disabled={removal.loading}
        onClick={() => {
          setIncludeChanged(false);
          setSweep(false);
          setConfirming(true);
        }}
        data-testid="sync-removal-remove"
        className="self-start text-[11px]"
      >
        {kept.removed ? t('runRemoval.sync.removeLeft') : t(words.remove)}
      </Button>
    );
  }

  const confirmRemoval = (): void => {
    removal.mutate({
      runId,
      ...(includeChanged ? { includeChanged: true } : {}),
      ...(sweep ? { sweep: true } : {}),
    });
    setConfirming(false);
  };
  const result = removal.data?.result;

  return (
    <section
      className="flex flex-col gap-2 rounded-sm border border-subtle bg-surface-1 p-2"
      data-testid={testId ?? 'sync-removal'}
      aria-label={t(words.title)}
    >
      <h5 className="text-xs font-semibold text-text-primary">{t(words.title)}</h5>
      {kind === 'created' && (
        <p className="text-[11px] text-text-secondary" data-testid="sync-removal-created">
          {t('runRemoval.sync.created', {
            count: kept.created,
            formatted: formatNumber(kept.created),
            org,
          })}
        </p>
      )}
      {(kept.overwritten ?? 0) > 0 && (
        <p className="text-[11px] text-text-secondary" data-testid="sync-removal-overwritten">
          {t(
            putBack.length > 0 || (kept.putBackNotKept ?? 0) === 0
              ? 'runRemoval.sync.overwritten'
              : 'runRemoval.sync.overwrittenNotKept',
            {
              count: kept.overwritten ?? 0,
              formatted: formatNumber(kept.overwritten ?? 0),
              org,
            },
          )}
          {keptUntil !== undefined && ` · ${t('runRemoval.sync.keptUntil', { date: keptUntil })}`}
        </p>
      )}
      {(kept.putBackNotKept ?? 0) > 0 && (
        <p className="text-[11px] text-text-primary" data-testid="sync-removal-put-back-not-kept">
          {t('runRemoval.sync.putBackNotKept', { n: formatNumber(kept.putBackNotKept ?? 0) })}
        </p>
      )}
      {(kept.deleted ?? 0) > 0 && (
        <p className="text-[11px] text-text-secondary" data-testid="sync-removal-deleted">
          {t('runRemoval.sync.deleted', {
            count: kept.deleted ?? 0,
            formatted: formatNumber(kept.deleted ?? 0),
            org,
          })}
        </p>
      )}
      {kept.notKeptEncrypted && kept.notKeptEncrypted.length > 0 && (
        <p className="text-[11px] text-text-primary" data-testid="sync-removal-not-kept-encrypted">
          {t('runRemoval.sync.notKeptEncrypted', { fields: kept.notKeptEncrypted.join(', ') })}
        </p>
      )}
      {kept.writtenAgain && offered && (
        <SyncWrittenAgain writtenAgain={kept.writtenAgain} testId="sync-removal-written-again" />
      )}
      {kept.removed && removedOn !== undefined && (
        <ForgeRunRemovalMark mark={kept.removed} date={removedOn} />
      )}
      {action}
      {removal.loading && (
        <div className="flex flex-wrap items-center gap-2">
          <p
            role="status"
            className="text-[11px] text-text-secondary"
            data-testid="sync-removal-removing"
          >
            {cancelRequested ? t('runRemoval.sync.stopping') : t('runRemoval.sync.removing')}
          </p>
          {removal.requestId && (
            <Button
              variant="danger"
              size="sm"
              icon={<Square size={11} />}
              disabled={cancelRequested}
              focusableWhenDisabled
              onClick={cancelRemoval}
              data-testid="sync-removal-cancel"
              className="text-[11px]"
            >
              {t('runRemoval.sync.cancel')}
            </Button>
          )}
        </div>
      )}
      {removal.error && (
        <ErrorBanner
          message={removal.error}
          code={removal.errorCode}
          data-testid="sync-removal-error"
        />
      )}
      {result && (
        <>
          {(result.objects.length > 0 ||
            result.sweep ||
            (!result.restored && !result.undeleted)) && (
            <ForgeRunRemovalResult result={result} org={org} />
          )}
          {result.undeleted && (
            <UndeletedResult
              undeleted={result.undeleted}
              org={org}
              words={UNDELETED_WORDS}
              testId="sync-removal-undeleted"
            />
          )}
          {result.restored && (
            <RestoredResult
              restored={result.restored}
              org={org}
              words={RESTORED_WORDS}
              testId="sync-removal-restored"
            />
          )}
          {result.readWhole && result.readWhole.length > 0 && (
            <p className="text-[11px] text-text-secondary" data-testid="sync-removal-read-whole">
              {t('runRemoval.sync.readWhole', {
                config: kept.configName,
                objects: result.readWhole.join(', '),
              })}
            </p>
          )}
          {(result.filesForgotten ?? 0) > 0 && (
            <p
              className="text-[11px] text-text-secondary"
              data-testid="sync-removal-files-forgotten"
            >
              {t('runRemoval.sync.filesForgotten', {
                count: result.filesForgotten ?? 0,
                formatted: formatNumber(result.filesForgotten ?? 0),
                config: kept.configName,
              })}
            </p>
          )}
        </>
      )}
      <DangerConfirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirmRemoval}
        title={t(words.removeTitle, { org })}
        description={t(descriptionKey(kept, kind), { org })}
        confirmText={org}
      >
        {bringBack.length > 0 && (
          <>
            {/* Said by the description of a run that only deleted. */}
            {kind !== 'deleted' && (
              <p data-testid="sync-removal-bring-back-note">
                {t('runRemoval.sync.removeBringBack', { org })}
              </p>
            )}
            <ul className="flex flex-col gap-0.5" data-testid="sync-removal-bring-back">
              {bringBack.map((object) => (
                <li
                  key={object.objectApiName}
                  data-testid={`sync-removal-bring-back-${object.objectApiName}`}
                  className="font-mono"
                >
                  {t('runRemoval.sync.bringBack', {
                    count: object.count,
                    formatted: formatNumber(object.count),
                    object: object.objectApiName,
                  })}
                </li>
              ))}
            </ul>
          </>
        )}
        {kept.writtenAgain && (
          <SyncWrittenAgain
            writtenAgain={kept.writtenAgain}
            testId="sync-removal-confirm-written-again"
          />
        )}
        {(kept.putBackNotKept ?? 0) > 0 && (
          <p data-testid="sync-removal-confirm-not-kept">
            {t('runRemoval.sync.putBackNotKept', { n: formatNumber(kept.putBackNotKept ?? 0) })}
          </p>
        )}
        {putBack.length > 0 && (
          <ul className="flex flex-col gap-0.5" data-testid="sync-removal-put-back">
            {putBack.map((object) => (
              <li
                key={object.objectApiName}
                data-testid={`sync-removal-put-back-${object.objectApiName}`}
                className="font-mono"
              >
                {t('runRemoval.sync.putBack', {
                  count: object.count,
                  formatted: formatNumber(object.count),
                  object: object.objectApiName,
                })}
              </li>
            ))}
          </ul>
        )}
        {kept.left.length > 0 && (
          <ForgeRunRemovalPlan
            plan={kept.left}
            linked={0}
            {...(removedOn !== undefined ? { leftBy: removedOn } : {})}
          />
        )}
        <SyncRemovalAutomation runId={runId} org={org} targetOrgId={kept.targetOrgId} />
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChanged}
            onChange={(e) => setIncludeChanged(e.target.checked)}
            data-testid="sync-removal-include-changed"
          />
          {t('runRemoval.sync.includeChanged')}
        </label>
        {/* Never ticked unasked: a sweep deletes records the run did not write. */}
        <label className="flex items-center gap-2 mt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={sweep}
            onChange={(e) => setSweep(e.target.checked)}
            data-testid="sync-removal-sweep-toggle"
          />
          {t('runRemoval.removeSweep')}
        </label>
        {sweep && confirming && <SyncRemovalSweep runId={runId} org={org} />}
      </DangerConfirm>
    </section>
  );
};
