import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { forgeRunCreatedRecords, forgeRunRecordsLeft } from '@sandforge/shared';
import type { ForgeExecutionResult, ForgeUndoResult } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOrgStore } from '../../stores/useOrgStore';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { formatStoredDate } from '../../utils/formatters';
import {
  ForgeRunRemovalConfirm,
  ForgeRunRemovalMark,
  ForgeRunRemovalResult,
} from './ForgeRunRemovalView';

/** How long a removal may wait on the host: Production Guard may wait on a person. */
const WAIT_ON_A_PERSON_MS = 600_000;

/** What `forge:undo` answers. */
interface UndoAnswer {
  result: ForgeUndoResult;
  operationId: string;
}

/** Props for {@link ForgeResultsRemoval}. */
export interface ForgeResultsRemovalProps {
  /** The run the results show. */
  run: ForgeExecutionResult;
  /** The org it wrote to, by its id in the registry: the run's config names it. */
  targetOrgId: string | undefined;
  /**
   * Told once a removal took records of the run back, deleted or found gone:
   * a retry of it has nothing left to link to, and the extension refuses one.
   */
  onRemoved?: () => void;
}

/**
 * The removal of the records the run on screen created, from its results:
 * the removal the history of runs offers, with the same confirmation
 * (`ForgeRunRemovalConfirm`), and what it did shown in place. A removal that
 * left records in the org — kept, refused, or not reached before a cancel —
 * is followed by one of what it left.
 *
 * The extension removes what its own history says the run created; what that
 * history now says of the run, once a removal answered, is read back from it
 * before anything more is offered: what is left, and when the last removal
 * left it.
 */
export const ForgeResultsRemoval: React.FC<ForgeResultsRemovalProps> = ({
  run,
  targetOrgId,
  onRemoved,
}) => {
  const { t } = useTranslation();
  const org = useOrgStore((s) => s.orgs.find((o) => o.id === targetOrgId)?.alias);
  const [confirming, setConfirming] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const removal = useBridgeMutation<UndoAnswer>('forge:undo', {
    responseType: 'forge:undo:response',
    errorType: 'forge:undo:error',
    timeoutMs: WAIT_ON_A_PERSON_MS,
  });
  const history = useBridgeMutation<{ history: ForgeExecutionResult[] }>('forge:history:list', {
    responseType: 'forge:history:list:response',
  });

  // Once a removal answered, the run's entry carries what it did: read it back.
  const answered = removal.data;
  const readHistory = history.mutate;
  useEffect(() => {
    if (answered) readHistory();
  }, [answered, readHistory]);

  /*
   * The run as the history holds it since the last removal: undefined until
   * one answered and the history did, null when the history no longer holds
   * it. Before any removal, the run on screen is what the extension kept.
   */
  const reread = useMemo(
    () =>
      history.data
        ? (history.data.history.find((e) => e.forgeId === run.forgeId) ?? null)
        : undefined,
    [history.data, run.forgeId],
  );
  const entry = reread === undefined ? run : reread;
  /** A removal answered, and what it left is not known yet: nothing more is offered meanwhile. */
  const awaitingEntry = answered !== null && reread === undefined;
  const left = useMemo(() => (entry ? forgeRunRecordsLeft(entry) : []), [entry]);

  const took = reread?.undo !== undefined;
  useEffect(() => {
    if (took) onRemoved?.();
  }, [took, onRemoved]);

  // A run that created nothing, or one kept before runs said what they
  // created, has nothing to take back from here.
  const created = useMemo(() => forgeRunCreatedRecords(run).length > 0, [run]);
  if (!created || !run.idRemapCreated) return null;

  const confirmRemoval = (): void => {
    if (!entry) return;
    removal.mutate({ forgeId: run.forgeId, includeChanged });
    setConfirming(false);
  };

  let action: React.ReactNode = null;
  if (entry && !awaitingEntry && left.length > 0) {
    action = org ? (
      <Button
        variant="secondary"
        size="md"
        icon={<Trash2 size={14} />}
        loading={removal.loading}
        disabled={removal.loading}
        onClick={() => {
          setIncludeChanged(false);
          setConfirming(true);
        }}
        data-testid="forge-results-remove"
        className="self-start"
      >
        {entry.undo ? t('forge.history.removeLeft') : t('forge.history.remove')}
      </Button>
    ) : (
      <p data-testid="forge-results-remove-org-gone" className="text-xs text-text-secondary">
        {t('forge.history.removeOrgGone')}
      </p>
    );
  }

  return (
    <div data-testid="forge-results-removal" className="flex flex-col gap-1.5">
      {entry?.undo && (
        <ForgeRunRemovalMark
          mark={entry.undo}
          date={
            formatStoredDate(entry.undo.removedAt, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown')
          }
        />
      )}
      {action}
      {removal.loading && (
        <p
          role="status"
          data-testid="forge-results-removing"
          className="text-xs text-text-secondary"
        >
          {t('forge.history.removing')}
        </p>
      )}
      {removal.error && (
        <ErrorBanner message={removal.error} data-testid="forge-results-remove-error" />
      )}
      {answered && <ForgeRunRemovalResult result={answered.result} org={org ?? ''} />}
      <ForgeRunRemovalConfirm
        run={confirming ? entry : null}
        org={org ?? ''}
        includeChanged={includeChanged}
        onIncludeChangedChange={setIncludeChanged}
        onClose={() => setConfirming(false)}
        onConfirm={confirmRemoval}
      />
    </div>
  );
};
