import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { FrozenLoadRecordsInfo, FrozenRemovalResult } from '@sandforge/shared';
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

/**
 * How long a removal may keep the page waiting: Production Guard may wait on
 * a person, and a load can hold as many records as the dataset's budget.
 */
const REMOVAL_TIMEOUT_MS = 1_800_000;

/** What `frozen:remove` answers. */
interface RemoveAnswer {
  result: FrozenRemovalResult;
  operationId: string;
}

/** Props for {@link FrozenLoadRemoval}. */
export interface FrozenLoadRemovalProps {
  /** The records of the load whose mapping the sas holds; absent when none. */
  records: FrozenLoadRecordsInfo | undefined;
  /** Read the module status again: once the load's records went, it carries the mark. */
  onRemoved: () => void;
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
 * the records per object; what the load linked to or reused stays. Once the
 * last load's records went, the card offers the load before it whose records
 * the loads after it left in the org, and says so.
 */
export const FrozenLoadRemoval: React.FC<FrozenLoadRemovalProps> = ({
  records,
  onRemoved,
  busy = false,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const [confirming, setConfirming] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const removal = useBridgeMutation<RemoveAnswer>('frozen:remove', {
    responseType: 'frozen:remove:response',
    errorType: 'frozen:remove:error',
    timeoutMs: REMOVAL_TIMEOUT_MS,
  });

  // Once per answer, whatever the caller hands in: a callback made anew on
  // every render of the page asked for the status again on every render the
  // status itself caused.
  const onRemovedRef = useRef(onRemoved);
  useEffect(() => {
    onRemovedRef.current = onRemoved;
  }, [onRemoved]);
  const answered = removal.data;
  useEffect(() => {
    if (answered) onRemovedRef.current();
  }, [answered]);

  if (!records) return null;

  const org = orgs.find((o) => o.id === records.orgId)?.alias;
  const date = formatStoredDate(records.loadedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown');
  const created = records.created.reduce((sum, object) => sum + object.count, 0);

  const confirmRemoval = (): void => {
    removal.mutate({
      targetOrgId: records.orgId,
      loadedAt: records.loadedAt,
      ...(includeChanged ? { includeChanged: true } : {}),
    });
    setConfirming(false);
  };

  let action: React.ReactNode = null;
  if (records.removed) {
    action = (
      <ForgeRunRemovalMark
        mark={records.removed}
        date={
          formatStoredDate(records.removed.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown')
        }
      />
    );
  } else if (!records.recorded) {
    action = (
      <p data-testid="frozen-removal-not-recorded" className="text-[11px] text-text-secondary">
        {t('frozen.removal.notRecorded')}
      </p>
    );
  } else if (created === 0) {
    action = (
      <p data-testid="frozen-removal-nothing" className="text-[11px] text-text-secondary">
        {t('frozen.removal.nothingCreated')}
      </p>
    );
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
          setConfirming(true);
        }}
        data-testid="frozen-removal-remove"
        className="self-start text-[11px]"
      >
        {t('frozen.removal.remove')}
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
          {action}
          {removal.loading && (
            <p role="status" className="text-[11px] text-text-secondary">
              {t('frozen.removal.removing')}
            </p>
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
        <ForgeRunRemovalPlan plan={records.created} linked={records.linked} />
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChanged}
            onChange={(e) => setIncludeChanged(e.target.checked)}
            data-testid="frozen-removal-include-changed"
          />
          {t('frozen.removal.includeChanged')}
        </label>
      </DangerConfirm>
    </Card>
  );
};
