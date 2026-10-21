import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Trash2 } from 'lucide-react';
import type {
  ForgeSweepListing,
  SeedRemovalRefusalCode,
  SeedRemovalResult,
  SeedRunRemovalInfo,
} from '@sandforge/shared';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
} from '../Forge/ForgeRunRemovalView';
import { ForgeSweepListingView } from '../Forge/ForgeRemovalSweep';

/**
 * How long a removal may keep the card waiting: Production Guard may wait on a
 * person, and a seed can have created many records.
 */
const REMOVAL_TIMEOUT_MS = 1_800_000;

/** Where every answer about a removal that is not one comes. */
const ERROR_CHANNEL = 'seed:remove:error';

/** How long the read of what a sweep would take may take: the target's automation, then one read per object. */
const SWEEP_READ_TIMEOUT_MS = 150_000;

/**
 * What the card says of a removal that cannot run, by why: in the words a
 * Sync run's removal says it, since the reasons are the same.
 */
const REFUSAL_KEYS: Record<SeedRemovalRefusalCode, string> = {
  GUARD_BLOCKED: 'runRemoval.sync.refusedGuard',
  NO_GUARD: 'runRemoval.sync.refusedNoGuard',
  ORG_GONE: 'runRemoval.sync.refusedOrgGone',
  RUNNING: 'runRemoval.sync.refusedRunning',
};

/** What `seed:remove` answers. */
interface RemoveAnswer {
  result: SeedRemovalResult;
  operationId: string;
}

/** What `seed:remove:sweep` answers. */
interface SweepAnswer {
  runId: string;
  listing: ForgeSweepListing;
}

/**
 * What a sweep asked with the removal would take, read as the confirmation's
 * sweep is ticked and listed before the user types the org's name: what the
 * target's automation created during the run, as its user, that the run did
 * not write — Forge's sweep, listed as Forge lists it, in its words: a seed is
 * a run. Read only; the sweep runs before the run's records go, and finds
 * again what is there.
 */
const SeedRemovalSweep: React.FC<{ runId: string; org: string }> = ({ runId, org }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const read = useBridgeMutation<SweepAnswer>('seed:remove:sweep', {
    responseType: 'seed:remove:sweep:response',
    errorType: 'seed:remove:sweep:error',
    timeoutMs: SWEEP_READ_TIMEOUT_MS,
  });
  const { mutate } = read;
  useEffect(() => {
    mutate({ runId });
  }, [runId, mutate]);

  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="seed-sweep-error" className="text-status-warning">
        {t('runRemoval.sweep.error', { org, reason: read.error })}
      </p>
    );
  } else if (!read.data || read.data.runId !== runId) {
    body = (
      <p data-testid="seed-sweep-loading" className="text-text-secondary">
        {t('runRemoval.sweep.loading', { org })}
      </p>
    );
  } else {
    body = <ForgeSweepListingView listing={read.data.listing} />;
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="seed-removal-sweep"
      className="mt-2 flex flex-col gap-1 text-[11px] text-text-primary"
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t('runRemoval.sweep.title', { org })}
      </h4>
      {body}
    </section>
  );
};

/** Props for {@link SeedRunRemoval}. */
export interface SeedRunRemovalProps {
  /** The run, by its result's `operationId`. */
  runId: string;
  /** Told once per answer to a removal, a refusal included: the list of earlier seeds reads again. */
  onAnswered?: () => void;
}

/**
 * What a Seed run created, and its removal, from the run's results. The
 * command line could take a run back from its summary; the panel offered
 * nothing, and a seed written from it stayed in the org.
 *
 * What the run created is read from what the extension kept, in this window
 * or before it was reloaded — nothing is asked of the org until a removal is
 * confirmed. The removal takes the records the run inserted and nothing else,
 * the last object written first, and, when asked, sweeps first what the
 * target's automation created during the run: a flow that opens a task on
 * each contact left those tasks behind. The
 * confirmation names the org, typed, and the records per object; a record
 * changed since the run stays unless included. Where Production Guard allows
 * no delete — a production org, as a Forge run's removal reads it — nothing is
 * offered, and the card says why. A removal under way can be stopped from the
 * card, as from Live Operations, between two calls to the org; what it left is
 * offered again.
 */
export const SeedRunRemoval: React.FC<SeedRunRemovalProps> = ({ runId, onAnswered }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const [confirming, setConfirming] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const [sweep, setSweep] = useState(false);
  const info = useBridgeQuery<{ info: SeedRunRemovalInfo | null }>(
    'seed:removal:info',
    { runId },
    { errorType: ERROR_CHANNEL },
  );
  const removal = useBridgeMutation<RemoveAnswer>('seed:remove', {
    responseType: 'seed:remove:response',
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
  // Once per answer, whatever the caller hands in.
  const onAnsweredRef = useRef(onAnswered);
  useEffect(() => {
    onAnsweredRef.current = onAnswered;
  }, [onAnswered]);
  useEffect(() => {
    if (!answered && !refused) return;
    refetch();
    onAnsweredRef.current?.();
  }, [answered, refused, refetch]);

  const kept = info.data?.info;
  if (info.data && !kept) {
    return (
      <p className="text-[11px] text-text-secondary" data-testid="seed-removal-not-kept">
        {t('seed.removal.notKept')}
      </p>
    );
  }
  if (!kept) return null;

  const org = orgs.find((o) => o.id === kept.targetOrgId)?.alias ?? kept.targetOrgId;
  const removedOn = kept.removed
    ? (formatStoredDate(kept.removed.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'))
    : undefined;

  let action: React.ReactNode = null;
  if (kept.left.length > 0 && kept.refusal) {
    action = (
      <div className="flex flex-col gap-0.5" data-testid="seed-removal-refused">
        <p className="text-[11px] text-text-primary">
          {t(REFUSAL_KEYS[kept.refusal.code], { org })}
        </p>
        <p className="text-[10px] text-text-secondary wrap-break-word">{kept.refusal.message}</p>
      </div>
    );
  } else if (kept.left.length > 0) {
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
        data-testid="seed-removal-remove"
        className="self-start text-[11px]"
      >
        {kept.removed ? t('runRemoval.sync.removeLeft') : t('runRemoval.sync.remove')}
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
      data-testid="seed-removal"
      aria-label={t('runRemoval.sync.title')}
    >
      <h5 className="text-xs font-semibold text-text-primary">{t('runRemoval.sync.title')}</h5>
      <p className="text-[11px] text-text-secondary" data-testid="seed-removal-created">
        {t('seed.removal.created', {
          count: kept.created,
          formatted: formatNumber(kept.created),
          org,
        })}
      </p>
      {kept.removed && removedOn !== undefined && (
        <ForgeRunRemovalMark mark={kept.removed} date={removedOn} />
      )}
      {action}
      {removal.loading && (
        <div className="flex flex-wrap items-center gap-2">
          <p
            role="status"
            className="text-[11px] text-text-secondary"
            data-testid="seed-removal-removing"
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
              data-testid="seed-removal-cancel"
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
          module="seed"
          data-testid="seed-removal-error"
        />
      )}
      {result && <ForgeRunRemovalResult result={result} org={org} />}
      <DangerConfirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirmRemoval}
        title={t('runRemoval.sync.removeTitle', { org })}
        description={t('seed.removal.removeDescription', { org })}
        confirmText={org}
      >
        <ForgeRunRemovalPlan
          plan={kept.left}
          linked={0}
          {...(removedOn !== undefined ? { leftBy: removedOn } : {})}
        />
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChanged}
            onChange={(e) => setIncludeChanged(e.target.checked)}
            data-testid="seed-removal-include-changed"
          />
          {t('runRemoval.sync.includeChanged')}
        </label>
        {/* Never ticked unasked: a sweep deletes records the run did not write. */}
        <label className="flex items-center gap-2 mt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={sweep}
            onChange={(e) => setSweep(e.target.checked)}
            data-testid="seed-removal-sweep-toggle"
          />
          {t('runRemoval.removeSweep')}
        </label>
        {sweep && confirming && <SeedRemovalSweep runId={runId} org={org} />}
      </DangerConfirm>
    </section>
  );
};
