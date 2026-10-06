import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useSyncRunControls } from './useSyncRunControls';

/** Props for {@link SyncRunControls}. */
export interface SyncRunControlsProps {
  /** The id of the request that started the run, which the extension runs it under. */
  operationId: string | null;
  /**
   * A run writes, so it can be paused and its cancel is confirmed; a
   * simulation writes nothing, so it is only stopped, without a question.
   */
  kind: 'run' | 'simulation';
}

/**
 * Pause, resume and cancel for the run under way, on the page that started
 * it rather than only in Live Operations.
 *
 * A pause holds the run before its next object, or its next batch of
 * records: a batch already sent, or a Bulk API job already closed, runs to
 * its end. Cancel stops the run as Live Operations' does, and what it wrote
 * stays in the target org.
 */
export const SyncRunControls: React.FC<SyncRunControlsProps> = ({ operationId, kind }) => {
  const { t } = useTranslation();
  const { paused, cancelRequested, pending, pause, resume, cancel } =
    useSyncRunControls(operationId);
  const [confirming, setConfirming] = useState(false);

  if (!operationId) return null;

  const state = cancelRequested
    ? t('sync.runControls.stopping')
    : paused
      ? t('sync.runControls.pausedNote')
      : '';

  return (
    <div className="flex flex-col gap-(--sf-space-2)" data-testid="sync-run-controls">
      <div className="flex items-center gap-(--sf-space-2)">
        {kind === 'run' &&
          (paused ? (
            <Button
              variant="primary"
              size="sm"
              onClick={resume}
              disabled={pending || cancelRequested}
              focusableWhenDisabled
              data-testid="sync-resume"
            >
              {t('sync.runControls.resume')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={pause}
              disabled={pending || cancelRequested}
              focusableWhenDisabled
              data-testid="sync-pause"
            >
              {t('sync.runControls.pause')}
            </Button>
          ))}
        <Button
          variant="danger"
          size="sm"
          onClick={kind === 'run' ? () => setConfirming(true) : cancel}
          disabled={cancelRequested}
          focusableWhenDisabled
          data-testid="sync-cancel"
        >
          {kind === 'run' ? t('common.cancelRun') : t('sync.runControls.cancelSimulation')}
        </Button>
      </div>
      <p
        className="text-[10px] text-text-secondary"
        role="status"
        aria-live="polite"
        data-testid="sync-run-state"
      >
        {state}
      </p>
      <DangerConfirm
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          cancel();
        }}
        title={t('common.cancelRun')}
        description={t('sync.runControls.cancelConfirm')}
        confirmText={t('common.cancel')}
      />
    </div>
  );
};
