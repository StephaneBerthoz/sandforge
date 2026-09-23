import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { RotateCcw, Trash2 } from 'lucide-react';
import { forgeRunCreatedRecords } from '@sandforge/shared';
import type { ForgeUndoResult } from '@sandforge/shared';
import { cn } from '../../theme';
import type { ForgeExecutionResult } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { DEPTH_KEYS } from './useForgeForm';
import type { ForgeRunConfig } from './useForgeForm';
import { INPUT_MODE_KEYS, configSubject } from './forgeRunConfig';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
} from './ForgeRunRemovalView';

/** How long a removal may wait on the host: Production Guard may wait on a person. */
const WAIT_ON_A_PERSON_MS = 600_000;

/** Map a run's outcome to its i18n key. */
const STATUS_KEYS: Record<ForgeExecutionResult['status'], string> = {
  success: 'forge.history.statusSuccess',
  partial: 'forge.history.statusPartial',
  failure: 'forge.history.statusFailure',
};

/** Map a run's outcome to the colour it is shown in. */
const STATUS_CLASSES: Record<ForgeExecutionResult['status'], string> = {
  success: 'text-status-success',
  partial: 'text-status-warning',
  failure: 'text-status-error',
};

/** How the panel writes a date. */
function shown(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd HH:mm');
}

/** What `forge:undo` answers. */
interface UndoAnswer {
  result: ForgeUndoResult;
  operationId: string;
}

/** Props for the ForgeHistoryPanel component. */
export interface ForgeHistoryPanelProps {
  /** Past runs the extension persisted, newest first. */
  entries: ForgeExecutionResult[];
  /** Error raised while loading the history, or null. */
  error: string | null;
  /** Refill the Forge form from a past run's configuration. */
  onReuseConfig: (config: ForgeRunConfig) => void;
  /** Read the history again: once a run's records were removed, its entry says so. */
  onHistoryChanged?: () => void;
}

/**
 * Past-runs list with one re-use button per entry, and the removal of the
 * records a run created.
 *
 * The extension keeps the last 20 runs together with the configuration that
 * produced each one, and nothing read that configuration back: a user cloning
 * the same graph every sprint retyped the whole form each time. Each entry
 * here refills the form from its stored config.
 *
 * It refills rather than launches, because Forge runs in three steps
 * (discover -> plan -> execute): the graph has to be rediscovered against the
 * orgs as they are today, and the user confirms the plan before any write.
 *
 * A run that created records offers to remove them — the only way before was
 * a command-line cleanup of everything the user had created since a date. The
 * confirmation names the org and the records per object; the extension
 * removes what its own history says the run created, and nothing it linked.
 */
export const ForgeHistoryPanel: React.FC<ForgeHistoryPanelProps> = ({
  entries,
  error,
  onReuseConfig,
  onHistoryChanged,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const [reusedFrom, setReusedFrom] = useState<string | null>(null);
  /** The run whose removal is being confirmed. */
  const [confirming, setConfirming] = useState<ForgeExecutionResult | null>(null);
  const [includeChanged, setIncludeChanged] = useState(false);
  /** The run the last removal was asked for: its answer shows under it. */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const removal = useBridgeMutation<UndoAnswer>('forge:undo', {
    responseType: 'forge:undo:response',
    errorType: 'forge:undo:error',
    timeoutMs: WAIT_ON_A_PERSON_MS,
  });

  // Once a removal answered, its entry carries the mark: read the history again.
  const answered = removal.data;
  useEffect(() => {
    if (answered) onHistoryChanged?.();
  }, [answered, onHistoryChanged]);

  const orgLabel = (orgId: string | undefined): string | undefined =>
    orgs.find((o) => o.id === orgId)?.alias;
  /** The runs that created records a removal could take, by `forgeId`. */
  const removable = useMemo(
    () =>
      new Set(entries.filter((e) => forgeRunCreatedRecords(e).length > 0).map((e) => e.forgeId)),
    [entries],
  );
  const confirmingPlan = useMemo(
    () => (confirming ? forgeRunCreatedRecords(confirming) : []),
    [confirming],
  );
  const confirmingOrg = (confirming && orgLabel(confirming.targetOrgId)) ?? '';

  if (entries.length === 0) {
    // A background fetch with nothing to show is silent; a failed one says so,
    // rather than leaving the user to wonder where their runs went.
    return error ? (
      <p
        data-testid="forge-history-error"
        role="status"
        className="text-[10px] text-text-secondary mt-2"
      >
        {t('forge.history.loadError')}
      </p>
    ) : null;
  }

  const confirmRemoval = (): void => {
    if (!confirming) return;
    setRemovingId(confirming.forgeId);
    removal.mutate({ forgeId: confirming.forgeId, includeChanged });
    setConfirming(null);
  };

  /** Under a run: the removal it offers, what became of it, or why it offers none. */
  const removalOf = (entry: ForgeExecutionResult): React.ReactNode => {
    const mine = removingId === entry.forgeId;
    const org = orgLabel(entry.targetOrgId);
    const answer = mine ? removal.data?.result : undefined;
    let action: React.ReactNode = null;
    if (entry.undo) {
      action = <ForgeRunRemovalMark mark={entry.undo} date={shown(entry.undo.removedAt)} />;
    } else if (!entry.idRemapCreated || !entry.targetOrgId) {
      // Recorded before a run kept what it created and where: said only of a
      // run that did write something.
      if ((entry.createdCount ?? entry.idRemapCount) > 0) {
        action = (
          <p
            data-testid={`forge-history-remove-unrecorded-${entry.forgeId}`}
            className="text-[10px] text-text-secondary"
          >
            {t('forge.history.removeNotRecorded')}
          </p>
        );
      }
    } else if (removable.has(entry.forgeId)) {
      action = org ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Trash2 size={11} />}
          loading={mine && removal.loading}
          disabled={removal.loading}
          onClick={() => {
            setIncludeChanged(false);
            setConfirming(entry);
          }}
          data-testid={`forge-history-remove-${entry.forgeId}`}
          className="self-start text-[11px]"
        >
          {t('forge.history.remove')}
        </Button>
      ) : (
        <p
          data-testid={`forge-history-remove-org-gone-${entry.forgeId}`}
          className="text-[10px] text-text-secondary"
        >
          {t('forge.history.removeOrgGone')}
        </p>
      );
    }
    if (!action && !mine) return null;
    return (
      <div className="flex flex-col gap-1">
        {action}
        {mine && removal.loading && (
          <p role="status" className="text-[10px] text-text-secondary">
            {t('forge.history.removing')}
          </p>
        )}
        {mine && removal.error && (
          <ErrorBanner message={removal.error} data-testid="forge-history-remove-error" />
        )}
        {answer && <ForgeRunRemovalResult result={answer} org={org ?? ''} />}
      </div>
    );
  };

  return (
    <div data-testid="forge-history-panel" className="flex flex-col gap-1.5 mt-2">
      <div className="text-[10px] text-text-secondary uppercase tracking-widest">
        {t('forge.history.title')}
      </div>

      {entries.map((entry) => {
        const config = entry.config;
        const when = shown(entry.timestamp);
        const subject = config ? configSubject(config) : undefined;
        const removalBlock = removalOf(entry);

        return (
          <div
            key={entry.forgeId}
            data-testid={`forge-history-entry-${entry.forgeId}`}
            className="flex flex-col gap-1.5 px-3 py-2 rounded-md border border-subtle bg-surface-2"
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-text-secondary">{when}</span>
                  <span className={cn('text-[10px] font-semibold', STATUS_CLASSES[entry.status])}>
                    {t(STATUS_KEYS[entry.status])}
                  </span>
                </div>
                {config && (
                  <span className="block text-[11px] text-text-secondary truncate">
                    {[t(INPUT_MODE_KEYS[config.inputMode]), subject, t(DEPTH_KEYS[config.depth])]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </div>

              <button
                type="button"
                data-testid={`forge-history-rerun-${entry.forgeId}`}
                disabled={!config}
                onClick={() => {
                  if (!config) return;
                  onReuseConfig(config);
                  setReusedFrom(when);
                }}
                title={config ? t('forge.history.reuseHint') : t('forge.history.noConfig')}
                className={cn(
                  'shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium',
                  'border border-forge/30 bg-forge/5 text-hue-forge',
                  'hover:bg-forge/10 hover:border-forge/50 transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-forge/5',
                )}
              >
                <RotateCcw size={11} />
                {t('forge.history.reuse')}
              </button>
            </div>
            {removalBlock}
          </div>
        );
      })}

      {reusedFrom !== null && (
        <p
          data-testid="forge-history-reused"
          role="status"
          className="text-[10px] text-hue-forge mt-0.5"
        >
          {t('forge.history.reused', { date: reusedFrom })}
        </p>
      )}

      <DangerConfirm
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={confirmRemoval}
        title={t('forge.history.removeTitle', { org: confirmingOrg })}
        description={t('forge.history.removeDescription', { org: confirmingOrg })}
        confirmText={confirmingOrg}
      >
        <ForgeRunRemovalPlan
          plan={confirmingPlan}
          linked={confirming?.idRemapExisting?.length ?? 0}
        />
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChanged}
            onChange={(e) => setIncludeChanged(e.target.checked)}
            data-testid="forge-removal-include-changed"
          />
          {t('forge.history.removeIncludeChanged')}
        </label>
      </DangerConfirm>
    </div>
  );
};
