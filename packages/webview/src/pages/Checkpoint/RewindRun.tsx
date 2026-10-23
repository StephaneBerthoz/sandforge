import React, { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgCheckpoint, RewindDiff, RewindResult as RewindOutcome } from '@sandforge/shared';
import { useFocusOnChange } from '../../hooks/useFocusOnChange';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ProgressAnnouncer, ProgressBar } from '../../components/ui/ProgressBar';
import { formatNumber } from '../../utils/formatters';
import { RewindResult, type RunKind } from './RewindResult';
import { rewindPhases, type RewindPhase } from './rewindPreviewFacts';

/** What each phase of a rewind that writes says it does, with the records it acts on. */
const PHASE_KEYS: Readonly<Record<Exclude<RewindPhase, 'check'>, string>> = {
  bringBack: 'checkpoint.run.phase.bringBack',
  giveBack: 'checkpoint.run.phase.giveBack',
  delete: 'checkpoint.run.phase.delete',
};

/** The code a run stopped before it answered with a result comes back with. */
const CANCELLED = 'CANCELLED';

/**
 * A run the page started: a rewind, with the preview the user confirmed, or
 * the undo of the org's last rewind.
 */
export type RunShown = { kind: 'rewind'; diff: RewindDiff } | { kind: 'undo'; rewindId: string };

/** Where the request that started the run stands, as its bridge hook says. */
export interface RunState {
  loading: boolean;
  /** The id of the request, which the run goes on under: its progress, its Stop. */
  requestId: string | null;
  result: RewindOutcome | null;
  error: string | null;
  errorCode: string | null;
}

/** Props for {@link RewindRun}. */
export interface RewindRunProps {
  /** The org rewound, as the page names it. */
  orgName: string;
  checkpoint: OrgCheckpoint;
  run: RunShown;
  state: RunState;
  /**
   * Undo a rewind, which the page confirms: the one just made, with what Undo
   * could not bring back of it, or the one an undo refused was of.
   */
  onUndo: (
    rewindId: string,
    cannot: ReadonlyArray<{ objectApiName: string; count: number }>,
  ) => void;
  /** Read the org afresh for another rewind. */
  onRewindAgain: () => void;
  /** The checkpoint stops comparing fields. */
  onIgnored: (checkpoint: OrgCheckpoint) => void;
  /** Back to the org's checkpoints. */
  onDone: () => void;
}

/**
 * A rewind of an org to a checkpoint, or the undo of its last rewind, as it
 * runs and once it is through. Under way: what the rewind does, in the order
 * it does it — brings back what was deleted, gives back what changed, deletes
 * what was added, children first, then reads the org again — with what the
 * extension says it is doing, how far it is, and Stop, which stops it before
 * its next call to the org, as Live Operations' Cancel does. Once through:
 * what it did ({@link RewindResult}). Stopped before it answered, it says
 * where the org stands and what takes it up again.
 */
export const RewindRun: React.FC<RewindRunProps> = ({
  orgName,
  checkpoint,
  run,
  state,
  onUndo,
  onRewindAgain,
  onIgnored,
  onDone,
}) => {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const kind: RunKind = run.kind;
  const phase = state.loading ? 'running' : state.result ? 'done' : 'ended';
  useFocusOnChange(headingRef, phase, { onMount: true });

  const { getProgress } = useOperationProgress();
  const progress = state.loading && state.requestId ? getProgress(state.requestId) : undefined;
  const stop = useOperationCancel(state.loading ? state.requestId : null, {
    title: t('common.runCancelRefused'),
    message: t('common.runCancelRefusedDetail'),
  });

  let body: React.ReactNode;
  if (state.loading) {
    body = (
      <Running
        orgName={orgName}
        kind={kind}
        diff={run.kind === 'rewind' ? run.diff : undefined}
        step={progress?.currentStep}
        processed={progress?.processedRecords ?? 0}
        total={progress?.totalRecords ?? 0}
        stopRequested={stop.requested}
        onStop={stop.cancel}
      />
    );
  } else if (state.result) {
    const result = state.result;
    body = (
      <RewindResult
        kind={kind}
        orgName={orgName}
        checkpoint={checkpoint}
        result={result}
        userNames={run.kind === 'rewind' ? run.diff.userNames : {}}
        onUndo={() => onUndo(result.rewindId, result.undo?.cannot ?? [])}
        onRewindAgain={onRewindAgain}
        onIgnored={onIgnored}
        onDone={onDone}
      />
    );
  } else {
    const stopped = state.errorCode === CANCELLED;
    body = (
      <div className="flex flex-col items-start gap-3 text-sm text-text-primary">
        {stopped ? (
          <p role="status" data-testid="checkpoint-run-stopped">
            {kind === 'rewind'
              ? t('checkpoint.result.cancelled', { org: orgName, name: checkpoint.name })
              : t('checkpoint.result.undo.cancelled', { org: orgName })}
          </p>
        ) : (
          <ErrorBanner
            message={state.error ?? ''}
            code={state.errorCode}
            data-testid="checkpoint-run-error"
          />
        )}
        <div className="flex flex-wrap gap-2">
          {run.kind === 'rewind' && (
            <Button
              variant="secondary"
              onClick={onRewindAgain}
              data-testid="checkpoint-run-rewind-again"
            >
              {t('checkpoint.result.rewindAgain')}
            </Button>
          )}
          {/* An undo refused before it wrote — the automation the org runs
              not accepted — is asked again, its box offered again. */}
          {run.kind === 'undo' && !stopped && (
            <Button
              variant="secondary"
              onClick={() => onUndo(run.rewindId, [])}
              data-testid="checkpoint-run-undo-again"
            >
              {t('checkpoint.undo.open')}
            </Button>
          )}
          <Button variant="primary" onClick={onDone} data-testid="checkpoint-run-done">
            {t('checkpoint.take.done')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-sm border border-subtle bg-surface-1 p-4"
      aria-labelledby={headingId}
      data-testid="checkpoint-run"
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-text-primary break-words"
      >
        {kind === 'rewind'
          ? t('checkpoint.run.title', { org: orgName, name: checkpoint.name })
          : t('checkpoint.run.undoTitle', { org: orgName })}
      </h2>
      {body}
    </section>
  );
};

/** Props for a run under way. */
interface RunningProps {
  orgName: string;
  kind: RunKind;
  /** The preview a rewind acts on, which says its phases; absent for an undo. */
  diff?: RewindDiff;
  /** What the run is doing, as the extension says it. */
  step?: string;
  processed: number;
  total: number;
  stopRequested: boolean;
  onStop: () => void;
}

/** A rewind or an undo under way: its phases, what it is doing, how far it is, and Stop. */
const Running: React.FC<RunningProps> = ({
  orgName,
  kind,
  diff,
  step,
  processed,
  total,
  stopRequested,
  onStop,
}) => {
  const { t } = useTranslation();
  const said = step ?? t('checkpoint.take.starting');
  const counted = `${formatNumber(processed)} / ${formatNumber(total)}`;
  const progressLabel =
    kind === 'rewind' ? t('checkpoint.run.progress') : t('checkpoint.run.undoProgress');
  return (
    <div className="flex flex-col gap-3" data-testid="checkpoint-run-running">
      {diff && (
        <ol
          className="ml-4 list-decimal text-sm text-text-primary"
          aria-label={t('checkpoint.run.phases')}
          data-testid="checkpoint-run-phases"
        >
          {rewindPhases(diff).map((line) => (
            <li key={line.phase} data-testid={`checkpoint-run-phase-${line.phase}`}>
              {line.phase === 'check'
                ? t('checkpoint.run.phase.check', { org: orgName })
                : t(PHASE_KEYS[line.phase], {
                    count: line.count,
                    formatted: formatNumber(line.count),
                  })}
            </li>
          ))}
        </ol>
      )}
      <p className="text-sm text-text-primary" data-testid="checkpoint-run-step">
        {said}
        {total > 0 && ` — ${counted}`}
      </p>
      {total > 0 ? (
        <ProgressBar value={processed} max={total} ariaLabel={progressLabel} valueText={counted} />
      ) : (
        <ProgressBar indeterminate ariaLabel={progressLabel} />
      )}
      <ProgressAnnouncer message={said} testId="checkpoint-run-announcer" />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={onStop}
          disabled={stopRequested}
          data-testid="checkpoint-run-stop"
        >
          {kind === 'rewind' ? t('checkpoint.run.stop') : t('checkpoint.run.stopUndo')}
        </Button>
        {stopRequested && (
          <span role="status" className="text-xs text-text-secondary">
            {t('checkpoint.run.stopping', { org: orgName })}
          </span>
        )}
      </div>
    </div>
  );
};
