import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Trash2 } from 'lucide-react';
import type {
  SyncRemovalRefusalCode,
  SyncRemovalResult,
  SyncRunRemovalInfo,
} from '@sandforge/shared';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
} from '../Forge/ForgeRunRemovalView';
import { useOperationCancel } from '../../hooks/useOperationCancel';

/**
 * How long a removal may keep the card waiting: Production Guard may wait on a
 * person, and a run can have created many records.
 */
const REMOVAL_TIMEOUT_MS = 1_800_000;

/** Where every answer about a removal that is not one comes. */
const ERROR_CHANNEL = 'sync:remove:error';

/** What the card says of a removal that cannot run, by why. */
const REFUSAL_KEYS: Record<SyncRemovalRefusalCode, string> = {
  GUARD_BLOCKED: 'sync.removal.refusedGuard',
  NO_GUARD: 'sync.removal.refusedNoGuard',
  ORG_GONE: 'sync.removal.refusedOrgGone',
  RUNNING: 'sync.removal.refusedRunning',
};

/** What `sync:remove` answers. */
interface RemoveAnswer {
  result: SyncRemovalResult;
  operationId: string;
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
 * org until a removal is confirmed. The removal takes what the run created
 * and nothing else: the records it inserted, or upserted where the target
 * held none, and the files it created, never a record it updated. The
 * confirmation names the org, typed, and the records per object; a record
 * changed since the run stays unless included. Where Production Guard allows
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
      title: t('sync.removal.cancelRefused'),
      message: t('sync.removal.cancelRefusedDetail'),
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
        {t('sync.removal.notKept')}
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
      <div className="flex flex-col gap-0.5" data-testid="sync-removal-refused">
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
          setConfirming(true);
        }}
        data-testid="sync-removal-remove"
        className="self-start text-[11px]"
      >
        {kept.removed ? t('sync.removal.removeLeft') : t('sync.removal.remove')}
      </Button>
    );
  }

  const confirmRemoval = (): void => {
    removal.mutate({ runId, ...(includeChanged ? { includeChanged: true } : {}) });
    setConfirming(false);
  };
  const result = removal.data?.result;

  return (
    <section
      className="flex flex-col gap-2 rounded-sm border border-subtle bg-surface-1 p-2"
      data-testid={testId ?? 'sync-removal'}
      aria-label={t('sync.removal.title')}
    >
      <h5 className="text-xs font-semibold text-text-primary">{t('sync.removal.title')}</h5>
      <p className="text-[11px] text-text-secondary" data-testid="sync-removal-created">
        {t('sync.removal.created', {
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
            data-testid="sync-removal-removing"
          >
            {cancelRequested ? t('sync.removal.stopping') : t('sync.removal.removing')}
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
              {t('sync.removal.cancel')}
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
          <ForgeRunRemovalResult result={result} org={org} />
          {result.readWhole && result.readWhole.length > 0 && (
            <p className="text-[11px] text-text-secondary" data-testid="sync-removal-read-whole">
              {t('sync.removal.readWhole', {
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
              {t('sync.removal.filesForgotten', {
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
        title={t('sync.removal.removeTitle', { org })}
        description={t('sync.removal.removeDescription', { org })}
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
            data-testid="sync-removal-include-changed"
          />
          {t('sync.removal.includeChanged')}
        </label>
      </DangerConfirm>
    </section>
  );
};
