import React, { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DataOpsEmptyRunResult,
  DataOpsEmptyStatus,
  DataOpsEmptyUndoResult,
} from '@sandforge/shared';
import { useFocusOnChange } from '../../../hooks/useFocusOnChange';
import { useOperationProgress } from '../../../hooks/useOperationProgress';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { MutedAutomationResult } from '../../../components/ui/MutedAutomationResult';
import { ProgressAnnouncer, ProgressBar } from '../../../components/ui/ProgressBar';
import { RewindBeforeRun } from '../../../components/ui/RewindBeforeRun';
import { formatNumber } from '../../../utils/formatters';

/** The code a run or an undo stopped before its first delete or undelete comes back with. */
const CANCELLED = 'CANCELLED';

/** What the heading of a run's result says, by how it ended. */
const RUN_STATUS_KEYS: Readonly<Record<DataOpsEmptyStatus, string>> = {
  success: 'dataopsEmpty.result.status.success',
  partial: 'dataopsEmpty.result.status.partial',
  failure: 'dataopsEmpty.result.status.failure',
  cancelled: 'dataopsEmpty.result.status.cancelled',
};

/** What the heading of an undo's result says, by how it ended. */
const UNDO_STATUS_KEYS: Readonly<Record<DataOpsEmptyStatus, string>> = {
  success: 'dataopsEmpty.undo.status.success',
  partial: 'dataopsEmpty.undo.status.partial',
  failure: 'dataopsEmpty.undo.status.failure',
  cancelled: 'dataopsEmpty.undo.status.cancelled',
};

/** Where the request that started a run or an undo stands, as its bridge hook says. */
export interface EmptyActState {
  loading: boolean;
  /** The id of the request, which the act goes on under: its progress, its Stop. */
  requestId: string | null;
  error: string | null;
  errorCode: string | null;
}

/** Props for {@link EmptyOutcome}. */
export interface EmptyOutcomeProps {
  orgId: string;
  orgName: string;
  /** Which act the page started. */
  kind: 'run' | 'undo';
  state: EmptyActState;
  run: DataOpsEmptyRunResult | null;
  undo: DataOpsEmptyUndoResult | null;
  stopRequested: boolean;
  onStop: () => void;
  /** Open the confirmation of the undo of `runId`. */
  onUndo: (runId: string) => void;
  /** Read the org afresh for another emptying; absent when no preview was asked here. */
  onPreviewAgain?: () => void;
  onDone: () => void;
}

/**
 * An emptying, or its undo, as it runs and once it ended. Under way: what the
 * extension says it is doing, how far it is, and Stop, which stops it before
 * its next call or job — a job the org already holds finishes first —, as
 * Live Operations' Cancel does. Once ended: what it did with each object,
 * what it left and why, what its mute did, the checkpoint it took first, and
 * Undo where Undo is possible, or why it is not. Stopped before it deleted
 * anything, it says so; refused, it says why.
 */
export const EmptyOutcome: React.FC<EmptyOutcomeProps> = ({
  orgId,
  orgName,
  kind,
  state,
  run,
  undo,
  stopRequested,
  onStop,
  onUndo,
  onPreviewAgain,
  onDone,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const phase = state.loading ? 'running' : run || undo ? 'done' : 'ended';
  useFocusOnChange(headingRef, `${kind}-${phase}`, { onMount: true });
  const { getProgress } = useOperationProgress();
  const progress = state.loading && state.requestId ? getProgress(state.requestId) : undefined;

  let title: string;
  if (state.loading) {
    title =
      kind === 'run'
        ? t('dataopsEmpty.run.title', { org: orgName })
        : t('dataopsEmpty.run.undoTitle', { org: orgName });
  } else if (kind === 'run' && run) {
    title = t(RUN_STATUS_KEYS[run.status], { org: orgName });
  } else if (kind === 'undo' && undo) {
    title = t(UNDO_STATUS_KEYS[undo.status], { org: orgName });
  } else if (state.errorCode === CANCELLED) {
    title = t('dataopsEmpty.result.stoppedNothing', { org: orgName });
  } else {
    title =
      kind === 'run'
        ? t('dataopsEmpty.result.refused', { org: orgName })
        : t('dataopsEmpty.undo.refused', { org: orgName });
  }

  let body: React.ReactNode;
  if (state.loading) {
    const percentage = progress?.percentage ?? 0;
    const said = progress?.currentStep ?? t('dataopsEmpty.run.starting');
    const label =
      kind === 'run' ? t('dataopsEmpty.run.progress') : t('dataopsEmpty.run.undoProgress');
    body = (
      <div className="flex flex-col gap-2" data-testid="empty-outcome-running">
        <p data-testid="empty-outcome-step">{said}</p>
        {progress ? (
          <ProgressBar
            value={percentage}
            max={100}
            ariaLabel={label}
            valueText={`${formatNumber(Math.round(percentage))} %`}
          />
        ) : (
          <ProgressBar indeterminate ariaLabel={label} />
        )}
        <ProgressAnnouncer message={said} testId="empty-outcome-announcer" />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onStop}
            disabled={stopRequested}
            data-testid="empty-outcome-stop"
          >
            {kind === 'run' ? t('dataopsEmpty.run.stop') : t('dataopsEmpty.run.stopUndo')}
          </Button>
          {stopRequested && (
            <span
              role="status"
              className="text-text-secondary"
              data-testid="empty-outcome-stopping"
            >
              {t('dataopsEmpty.run.stopping', { org: orgName })}
            </span>
          )}
        </div>
      </div>
    );
  } else if (kind === 'run' && run) {
    body = <RunResult orgId={orgId} orgName={orgName} result={run} onUndo={onUndo} />;
  } else if (kind === 'undo' && undo) {
    body = <UndoResult orgName={orgName} result={undo} />;
  } else if (state.errorCode === CANCELLED) {
    body = (
      <p role="status" data-testid="empty-outcome-stopped-nothing">
        {kind === 'run'
          ? t('dataopsEmpty.result.stoppedNothingDetail')
          : t('dataopsEmpty.undo.stoppedNothingDetail')}
      </p>
    );
  } else {
    body = (
      <ErrorBanner
        message={state.error ?? ''}
        code={state.errorCode}
        data-testid="empty-outcome-error"
      />
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-3 text-xs text-text-primary"
      data-testid="empty-outcome"
    >
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-text-primary focus:outline-hidden"
        data-testid="empty-outcome-title"
      >
        {title}
      </h3>
      {body}
      {!state.loading && (
        <div className="flex flex-wrap gap-2">
          {onPreviewAgain && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onPreviewAgain}
              data-testid="empty-outcome-preview-again"
            >
              {t('dataopsEmpty.result.previewAgain')}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onDone} data-testid="empty-outcome-done">
            {t('dataopsEmpty.result.done')}
          </Button>
        </div>
      )}
    </section>
  );
};

/** What a run did with each object, its notes, and Undo or why there is none. */
const RunResult: React.FC<{
  orgId: string;
  orgName: string;
  result: DataOpsEmptyRunResult;
  onUndo: (runId: string) => void;
}> = ({ orgId, orgName, result, onUndo }) => {
  const { t } = useTranslation();
  const passes = result.passes.filter(
    (pass) => pass.planned + pass.deleted + pass.gone + pass.refused + (pass.notReached ?? 0) > 0,
  );
  return (
    <div className="flex flex-col gap-2" data-testid="empty-result">
      <p data-testid="empty-result-totals">
        {t(result.hard ? 'dataopsEmpty.result.totalsHard' : 'dataopsEmpty.result.totals', {
          deleted: formatNumber(result.totals.deleted),
          gone: formatNumber(result.totals.gone),
          refused: formatNumber(result.totals.refused),
          notReached: formatNumber(result.totals.notReached),
        })}
      </p>
      {result.resumed && (
        <p data-testid="empty-result-resumed">{t('dataopsEmpty.result.resumed')}</p>
      )}
      {result.hardRefused !== undefined && (
        <p className="text-status-error" data-testid="empty-result-hard-refused">
          {t('dataopsEmpty.result.hardRefused', { reason: result.hardRefused })}
        </p>
      )}
      {passes.length > 0 && (
        <div
          role="region"
          aria-label={t('dataopsEmpty.result.perObject')}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a whole org's objects scroll, and none of the cells is a control to reach them by: the region takes the focus itself, so the keyboard can scroll it (axe scrollable-region-focusable).
          tabIndex={0}
          className="max-h-80 overflow-auto rounded-sm border border-subtle focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)"
        >
          <table className="w-full border-collapse text-left" data-testid="empty-result-passes">
            <caption className="px-2 py-1 text-left font-medium">
              {t('dataopsEmpty.result.perObject')}
            </caption>
            <thead>
              <tr className="border-b border-subtle">
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('dataopsEmpty.preview.col.object')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('dataopsEmpty.result.col.deleted')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('dataopsEmpty.result.col.gone')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('dataopsEmpty.result.col.refused')}
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  {t('dataopsEmpty.result.col.notReached')}
                </th>
              </tr>
            </thead>
            <tbody>
              {passes.map((pass) => (
                <tr
                  key={pass.objectApiName}
                  className="border-b border-subtle align-top last:border-b-0"
                  data-testid={`empty-result-pass-${pass.objectApiName}`}
                >
                  <th scope="row" className="px-2 py-1 font-normal">
                    <span className="font-mono">{pass.objectApiName}</span>
                    {pass.madeSince !== undefined && pass.madeSince > 0 && (
                      <span className="block text-text-secondary">
                        {t('dataopsEmpty.result.madeSince', {
                          count: pass.madeSince,
                          formatted: formatNumber(pass.madeSince),
                        })}
                      </span>
                    )}
                    {pass.reasons.map((reason) => (
                      <span key={reason} className="block text-text-secondary">
                        {reason}
                      </span>
                    ))}
                  </th>
                  <td className="px-2 py-1 text-right">{formatNumber(pass.deleted)}</td>
                  <td className="px-2 py-1 text-right">{formatNumber(pass.gone)}</td>
                  <td className="px-2 py-1 text-right">{formatNumber(pass.refused)}</td>
                  <td className="px-2 py-1 text-right">{formatNumber(pass.notReached ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.notes.length > 0 && (
        <ul className="ml-4 list-disc" data-testid="empty-result-notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <MutedAutomationResult
        muted={result.mutedAutomation}
        org={orgName}
        testId="empty-result-muted"
      />
      <RewindBeforeRun
        checkpoint={result.checkpoint}
        orgId={orgId}
        beside="none"
        compact
        testId="empty-result-checkpoint"
      />
      {result.removedRuns && result.removedRuns.length > 0 && (
        <p className="text-text-secondary" data-testid="empty-result-removed-runs">
          {t('dataopsEmpty.result.removedRuns', { count: result.removedRuns.length })}
        </p>
      )}
      {result.undo.offered ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onUndo(result.runId)}
            data-testid="empty-result-undo"
          >
            {t('dataopsEmpty.result.undo')}
          </Button>
          <span className="text-text-secondary">
            {t('dataopsEmpty.result.undoWhile', { runId: result.runId })}
          </span>
        </div>
      ) : (
        <p className="text-text-secondary" data-testid="empty-result-no-undo">
          {result.undo.why === 'hard'
            ? t('dataopsEmpty.result.noUndoHard')
            : t('dataopsEmpty.result.noUndoNothing')}
        </p>
      )}
    </div>
  );
};

/** What an undo brought back of each object, and what it could not, with why. */
const UndoResult: React.FC<{ orgName: string; result: DataOpsEmptyUndoResult }> = ({
  orgName,
  result,
}) => {
  const { t } = useTranslation();
  const objects = result.objects.filter(
    (object) =>
      object.undeleted +
        object.alreadyBack +
        object.notInBin +
        object.othersDeletion +
        object.refused +
        (object.notReached ?? 0) >
      0,
  );
  return (
    <div className="flex flex-col gap-2" data-testid="empty-undo-result">
      <ul className="ml-4 list-disc">
        {objects.map((object) => (
          <li key={object.objectApiName} data-testid={`empty-undo-object-${object.objectApiName}`}>
            <span className="font-mono">{object.objectApiName}</span>
            {': '}
            {t('dataopsEmpty.undo.line', {
              undeleted: formatNumber(object.undeleted),
              planned: formatNumber(object.planned),
            })}
            {object.alreadyBack > 0 &&
              ` ${t('dataopsEmpty.undo.alreadyBack', { formatted: formatNumber(object.alreadyBack) })}`}
            {object.notInBin > 0 &&
              ` ${t('dataopsEmpty.undo.notInBin', { formatted: formatNumber(object.notInBin) })}`}
            {object.othersDeletion > 0 &&
              ` ${t('dataopsEmpty.undo.othersDeletion', {
                formatted: formatNumber(object.othersDeletion),
              })}`}
            {object.refused > 0 &&
              ` ${t('dataopsEmpty.undo.refusedCount', { formatted: formatNumber(object.refused) })}`}
            {(object.notReached ?? 0) > 0 &&
              ` ${t('dataopsEmpty.undo.notReached', {
                formatted: formatNumber(object.notReached ?? 0),
              })}`}
            {object.reasons.length > 0 && (
              <span className="block text-text-secondary">{object.reasons.join(' ')}</span>
            )}
          </li>
        ))}
      </ul>
      {result.notes.length > 0 && (
        <ul className="ml-4 list-disc" data-testid="empty-undo-notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <MutedAutomationResult
        muted={result.mutedAutomation}
        org={orgName}
        testId="empty-undo-muted"
      />
    </div>
  );
};
