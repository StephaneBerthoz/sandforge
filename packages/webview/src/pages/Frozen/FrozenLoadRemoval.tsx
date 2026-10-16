import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Trash2 } from 'lucide-react';
import type {
  ForgeSweepListing,
  FrozenLoadRecordsInfo,
  FrozenRemovalResult,
} from '@sandforge/shared';
import { formatStoredDate } from '../../utils/formatters';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
} from '../Forge/ForgeRunRemovalView';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { ForgeSweepListingView } from '../Forge/ForgeRemovalSweep';

/**
 * How long a removal may keep the page waiting: Production Guard may wait on
 * a person, and a load can hold as many records as the dataset's budget.
 */
const REMOVAL_TIMEOUT_MS = 1_800_000;

/** How long the read of what a sweep would take may take: the target's automation, then one read per object. */
const SWEEP_READ_TIMEOUT_MS = 150_000;

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

/** Props for {@link FrozenRemovalSweep}. */
interface FrozenRemovalSweepProps {
  /** The org the load wrote to, registered. */
  orgId: string;
  /** When the load wrote its last record: which load. */
  loadedAt: string;
  /** The org as the user knows it. */
  org: string;
}

/**
 * What a sweep asked with the removal would take, read as the confirmation's
 * sweep is ticked and listed before the user types the org's name: what the
 * target's automation created during the load, as its user, that the load's
 * mapping does not hold — Forge's sweep, listed as Forge lists it. Read only;
 * the sweep runs before the load's records go, and finds again what is there.
 */
const FrozenRemovalSweep: React.FC<FrozenRemovalSweepProps> = ({ orgId, loadedAt, org }) => {
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

  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="frozen-sweep-error" className="text-status-warning">
        {t('frozen.removal.sweepError', { org, reason: read.error })}
      </p>
    );
  } else if (!read.data || read.data.loadedAt !== loadedAt) {
    body = (
      <p data-testid="frozen-sweep-loading" className="text-text-secondary">
        {t('frozen.removal.sweepLoading', { org })}
      </p>
    );
  } else {
    body = <ForgeSweepListingView listing={read.data.listing} />;
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
}

/**
 * The last load, and the removal of the records it created.
 *
 * Taking a load back used to mean a reload, whose purge deletes what the last
 * load wrote only to write the dataset again. This removes what the load
 * created and nothing else — the extension reads which records from the sas
 * mapping — with Forge's removal: the confirmation names the org, typed, and
 * the records per object; what the load linked to or reused stays. A removal
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
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const [confirming, setConfirming] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const [sweep, setSweep] = useState(false);
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

  const confirmRemoval = (): void => {
    removal.mutate({
      targetOrgId: records.orgId,
      loadedAt: records.loadedAt,
      ...(includeChanged ? { includeChanged: true } : {}),
      ...(sweep ? { sweep: true } : {}),
    });
    setConfirming(false);
  };

  // When the last removal ended, said with its mark above the action and not
  // in its place: a removal that left records in the org marked the load,
  // and the card offered nothing more while the status still counted them.
  const removedOn = records.removed
    ? (formatStoredDate(records.removed.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown'))
    : undefined;
  let action: React.ReactNode = null;
  if (!records.recorded) {
    action = (
      <p data-testid="frozen-removal-not-recorded" className="text-[11px] text-text-secondary">
        {t('frozen.removal.notRecorded')}
      </p>
    );
  } else if (created === 0) {
    // Once a removal took them all, its mark alone says so.
    if (!records.removed) {
      action = (
        <p data-testid="frozen-removal-nothing" className="text-[11px] text-text-secondary">
          {t('frozen.removal.nothingCreated')}
        </p>
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
        onClick={() => {
          setIncludeChanged(false);
          setSweep(false);
          setConfirming(true);
        }}
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
          {records.removed && removedOn !== undefined && (
            <ForgeRunRemovalMark mark={records.removed} date={removedOn} />
          )}
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
            <ErrorBanner message={removal.error} data-testid="frozen-removal-error" />
          )}
          {removal.data && (
            <ForgeRunRemovalResult
              result={removal.data.result}
              org={org ?? records.orgId}
              subject="load"
            />
          )}
        </div>
      </CardBody>
      <DangerConfirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirmRemoval}
        title={t('frozen.removal.removeTitle', { org: org ?? '' })}
        description={t('frozen.removal.removeDescription', { org: org ?? '' })}
        confirmText={org ?? ''}
      >
        <ForgeRunRemovalPlan
          plan={records.created}
          linked={records.linked}
          {...(removedOn !== undefined ? { leftBy: removedOn } : {})}
        />
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChanged}
            onChange={(e) => setIncludeChanged(e.target.checked)}
            data-testid="frozen-removal-include-changed"
          />
          {t('frozen.removal.includeChanged')}
        </label>
        {/* Never ticked unasked: a sweep deletes records the load did not write. */}
        <label className="flex items-center gap-2 mt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={sweep}
            onChange={(e) => setSweep(e.target.checked)}
            data-testid="frozen-removal-sweep-toggle"
          />
          {t('frozen.removal.sweep')}
        </label>
        {sweep && confirming && (
          <FrozenRemovalSweep orgId={records.orgId} loadedAt={records.loadedAt} org={org ?? ''} />
        )}
      </DangerConfirm>
    </Card>
  );
};
