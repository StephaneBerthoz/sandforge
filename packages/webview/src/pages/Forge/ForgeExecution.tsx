import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useFileSave } from '../../hooks/useFileSave';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import { AlertTriangle, ArrowLeft, FileText, Pause, Play, Square, Flame } from 'lucide-react';
import { SplitView } from '../../components/ui/SplitView';
import { LiveGraph } from '../../components/graph/LiveGraph';
import type { ForgeGraph as SharedForgeGraph } from '@sandforge/shared';
import { LogStream } from '../../components/ui/LogStream';
import type { LogFilter } from '../../components/ui/LogStream';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ProgressAnnouncer, ProgressBar } from '../../components/ui/ProgressBar';
import {
  forgeLogEntry,
  runElapsedSeconds,
  settledPercent,
  useForgeStore,
} from '../../stores/useForgeStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { slideUp, staggerContainer } from '../../motion/presets';
import { cn } from '../../theme';
import { formatElapsed } from '../../utils/formatters';
import { estimatedApiCallsOf } from './forgeApiCalls';

/**
 * What the top bar says: that the run is forging, or held paused; that it is
 * stopping, once an abort was asked for and the run has not answered; that it
 * stopped, once an error ended it; or, once every object on the graph has
 * settled and the run has not answered, that it is finishing.
 */
type ShownStatus = 'forging' | 'paused' | 'finishing' | 'stopping' | 'stopped';

/** Maps the shown status to the i18n key. */
const STATUS_KEYS: Record<ShownStatus, string> = {
  forging: 'forge.forging',
  paused: 'forge.paused',
  finishing: 'forge.finishing',
  stopping: 'forge.stopping',
  stopped: 'forge.stopped',
};

/**
 * How long an abort waits for the run's answer before the screen says it has
 * not come and offers the way back to the start. A run stops once the step
 * under way is done — a batch, a query — which usually takes seconds.
 */
export const STOP_ANSWER_WAIT_MS = 60_000;

/**
 * Forge execution mission-control view.
 *
 * Displays real-time graph progress, log stream, KPI counters,
 * and pause/abort controls during a forge operation.
 */
export const ForgeExecution: React.FC = () => {
  const { save } = useFileSave();
  const { t } = useTranslation();

  // The run's progress, its log, its error, its clock, its pause and the
  // abort asked of it are the store's: they go on while this screen is away,
  // and are here when it comes back.
  const graph = useForgeStore((s) => s.graph);
  const logs = useForgeStore((s) => s.logs);
  const runError = useForgeStore((s) => s.runError);
  const runClock = useForgeStore((s) => s.runClock);
  const stopRequestedAt = useForgeStore((s) => s.stopRequestedAt);
  const apiCallsSoFar = useForgeStore((s) => s.apiCallsSoFar);
  const addLog = useForgeStore((s) => s.addLog);
  const pauseRun = useForgeStore((s) => s.pauseRun);
  const resumeRun = useForgeStore((s) => s.resumeRun);
  const requestStop = useForgeStore((s) => s.requestStop);
  const showStoppedRun = useForgeStore((s) => s.showStoppedRun);
  const reviewAgain = useForgeStore((s) => s.reviewAgain);
  const leaveStoppingRun = useForgeStore((s) => s.leaveStoppingRun);
  /** Whether an error ended the run: nothing is left to pause or abort. */
  const stopped = Boolean(runError);
  /** Whether an abort was asked for and the run has not answered: it stops once its step is done. */
  const stopping = !stopped && stopRequestedAt !== null;
  /** Whether the run is held paused: its clock stands still until it is resumed. */
  const isPaused = runClock !== null && runClock.pausedSince !== null && runClock.endedAt === null;

  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  // ---- An abort the run does not answer ----
  // STOPPING... had no way out: a run whose answer never came held the screen
  // until the panel was closed. Once the wait is over, the screen says so and
  // offers the way back to the start. Measured from when the abort was asked,
  // which the store keeps, so the screen left and come back to does not wait
  // again; and apart from the run's clock, which stands still on a run
  // aborted while paused.
  const [stopWaitedOut, setStopWaitedOut] = useState<number | null>(() =>
    stopRequestedAt !== null && Date.now() - stopRequestedAt >= STOP_ANSWER_WAIT_MS
      ? stopRequestedAt
      : null,
  );
  useEffect(() => {
    if (stopRequestedAt === null) return;
    const timer = setTimeout(
      () => setStopWaitedOut(stopRequestedAt),
      Math.max(0, stopRequestedAt + STOP_ANSWER_WAIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [stopRequestedAt]);
  /** Whether the abort has waited its time for an answer that has not come. */
  const stopUnanswered = stopping && stopWaitedOut === stopRequestedAt;

  // ---- Timer ----
  // Read off the run's clock at each tick: counted by the screen, it started
  // again at 0:00 each time the screen came back.
  const [now, setNow] = useState(() => Date.now());
  const ticking = runClock !== null && runClock.endedAt === null && runClock.pausedSince === null;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const elapsed = runClock ? runElapsedSeconds(runClock, now) : 0;

  // ---- Node KPIs (memoized to avoid redundant .filter() on every render) ----
  const kpis = useMemo(() => {
    const nodeList = graph?.nodes ?? [];
    const total = nodeList.length;
    const done = nodeList.filter((n) => n.status === 'done').length;
    const running = nodeList.filter(
      (n) => n.status === 'running' || n.status === 'scanning',
    ).length;
    const queued = nodeList.filter((n) => n.status === 'idle').length;
    const failed = nodeList.filter((n) => n.status === 'error').length;
    const skipped = nodeList.filter((n) => n.status === 'skipped').length;
    // Discovery's, said to be an estimate, until the run's progress counts the
    // calls it has made (`apiCallsSoFar`); its answer says them all
    // (`ForgeResults`).
    const apiCalls = estimatedApiCallsOf(nodeList);
    // A skipped or failed node is finished with, and counts toward the bar,
    // measured as the store measures where a run stopped: the two agree.
    const settled = done + failed + skipped;
    const progress = settledPercent(nodeList);
    return { total, done, running, queued, failed, skipped, settled, apiCalls, progress };
  }, [graph]);

  /*
   * Every object on the graph has settled while the run goes on: it is
   * finishing. Its last steps come after its last object — the lookups filled
   * in last, the files, the statuses given back, reading back when the target
   * dated its writes — and its answer says what the whole run did. This screen
   * used to leave for the results as soon as the last object settled: the
   * answer came after it had gone, and the results were shown without it. It
   * stays until the answer takes the page to them, or its error says why it
   * stopped. `forge:progress` alone cannot close the run: on a backend failure
   * it simply stops arriving, and no node reaches a terminal status.
   */
  const finishing =
    !stopped && !stopping && !isPaused && kpis.total > 0 && kpis.settled === kpis.total;
  const shownStatus: ShownStatus = stopped
    ? 'stopped'
    : stopping
      ? 'stopping'
      : isPaused
        ? 'paused'
        : finishing
          ? 'finishing'
          : 'forging';

  /*
   * Time remaining, from the rate the run has achieved so far.
   *
   * Measured on the nodes that have settled, not on the ones that succeeded:
   * with `done` alone, a run whose skipped nodes were half the graph divided
   * the elapsed time by half the work and doubled its own estimate. It is still
   * a per-node estimate, so it moves in steps rather than smoothly.
   */
  const etaSeconds = useMemo(() => {
    if (kpis.settled === 0 || kpis.total === 0) return null;
    const avgTimePerNode = elapsed / kpis.settled;
    const remaining = kpis.total - kpis.settled;
    return Math.round(avgTimePerNode * remaining);
  }, [elapsed, kpis.settled, kpis.total]);

  // ---- Pause / Abort handlers ----
  const handlePauseToggle = useCallback(() => {
    if (isPaused) resumeRun();
    else pauseRun();
    // Read now, not at the next tick: the clock stands where the pause left it.
    setNow(Date.now());
    // Routed through the broker: the envelope is mandatory since 1.5.0.
    sendBridgeMessage(isPaused ? 'forge:resume' : 'forge:pause');
  }, [isPaused, pauseRun, resumeRun]);

  const handleAbort = useCallback(() => {
    setShowAbortConfirm(true);
  }, []);

  /*
   * The screen stays until the run answers: it stops once the step under way
   * is done, and its answer says what it wrote. It used to leave for the input
   * screen at once, and the answer — the records the run had left in the
   * target, and the way to see them — came to no screen at all.
   */
  const handleAbortConfirm = useCallback(() => {
    setShowAbortConfirm(false);
    requestStop();
    addLog(forgeLogEntry('warn', t('forge.aborted')));
    // Routed through the broker: the envelope is mandatory since 1.5.0.
    sendBridgeMessage('forge:abort');
  }, [t, addLog, requestStop]);

  return (
    <div data-testid="forge-execution" className="flex flex-col gap-4 h-full">
      {/* The run's error used to go to the log alone, with Pause and Abort
          left disabled and no way off the screen. Said here with what the
          run had written, when the error says, and the way on: the results
          of what it wrote, or the Review it was started from. */}
      {runError && (
        <m.div
          variants={slideUp}
          initial="hidden"
          animate="visible"
          role="alert"
          data-testid="forge-execution-error"
          className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-error" />
          <div className="flex flex-1 flex-col gap-1">
            <p>{t('forge.runStoppedOn', { message: runError.message })}</p>
            {runError.stoppedRun && (
              <p data-testid="forge-execution-error-written">
                {t('forge.runStoppedWrote', { count: runError.stoppedRun.createdCount ?? 0 })}
              </p>
            )}
          </div>
          {runError.stoppedRun ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="forge-execution-see-stopped"
              onClick={showStoppedRun}
              icon={<FileText size={12} />}
            >
              {t('forge.seeStoppedRun')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              data-testid="forge-execution-back-to-review"
              onClick={reviewAgain}
              icon={<ArrowLeft size={12} />}
            >
              {t('forge.backToReview')}
            </Button>
          )}
        </m.div>
      )}

      {/* ---- Top bar: progress, timer, status ---- */}
      <m.div variants={slideUp} initial="hidden" animate="visible" className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 font-bold text-hue-forge">
            <Flame size={16} />
            <span data-testid="forge-execution-status">{t(STATUS_KEYS[shownStatus])}</span>
          </span>
          <span className="flex items-center gap-3 text-text-secondary tabular-nums">
            <span data-testid="forge-execution-timer">
              {t('forge.elapsed')}: {formatElapsed(elapsed)}
            </span>
            {/* Measured on the objects, it has nothing left to count once they
                have all settled — it read 0:00 while the run went on — and no
                time is left to a run that stopped, or is stopping. */}
            {!finishing && !stopped && !stopping && (
              <span data-testid="forge-execution-eta" className="text-hue-forge">
                {t('forge.eta')}:{' '}
                {etaSeconds !== null ? formatElapsed(etaSeconds) : t('forge.etaCalculating')}
              </span>
            )}
          </span>
        </div>
        <div data-testid="forge-execution-progress">
          <ProgressBar
            value={kpis.progress}
            ariaLabel={t('a11y.runProgress', { name: t('nav.forge') })}
            barClassName="bg-forge"
          />
        </div>
        {finishing && (
          <p className="text-xs text-text-secondary" data-testid="forge-execution-finishing">
            {t('forge.finishingNote')}
          </p>
        )}
        {stopping && !stopUnanswered && (
          <p className="text-xs text-text-secondary" data-testid="forge-execution-stopping">
            {t('forge.stoppingNote')}
          </p>
        )}
        {/* The run lands in the recent runs if it answers later: the input
            screen reads them again whenever a run ends. */}
        {stopUnanswered && (
          <div
            data-testid="forge-execution-stop-unanswered"
            className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warning" />
            <p className="flex-1">{t('forge.stopUnanswered')}</p>
            <Button
              variant="secondary"
              size="sm"
              data-testid="forge-execution-leave"
              onClick={leaveStoppingRun}
              icon={<ArrowLeft size={12} />}
            >
              {t('forge.backToStart')}
            </Button>
          </div>
        )}
        <ProgressAnnouncer
          message={
            stopped
              ? ''
              : stopUnanswered
                ? t('forge.stopUnanswered')
                : stopping
                  ? t('forge.stoppingNote')
                  : finishing
                    ? t('forge.finishingNote')
                    : t('a11y.progressAnnouncement', {
                        name: t('nav.forge'),
                        percent: kpis.progress,
                      })
          }
          // Said at once: at 100% the bar would otherwise be heard as the end,
          // and an abort as nothing at all. A stopped run is said by the page,
          // where it stopped, and by the alert above, why: its last
          // percentage, said again from here as the screen came back, told
          // nothing more. A finished run is said by the results.
          immediate={finishing || stopping || stopped}
          testId="forge-progress-status"
        />
      </m.div>

      {/* ---- Middle: SplitView (graph + logs) ---- */}
      <div className="flex-1 min-h-0 min-h-[300px]">
        <SplitView
          ratio="60/40"
          left={
            graph ? (
              <LiveGraph graph={graph as unknown as SharedForgeGraph} className="h-full" />
            ) : (
              <div className="flex h-full items-center justify-center text-text-secondary">
                {t('common.noData')}
              </div>
            )
          }
          right={
            <div className="flex flex-col h-full">
              <div className="flex gap-1 px-2 py-1" data-testid="log-filter-bar">
                <button
                  type="button"
                  data-testid="log-filter-all"
                  aria-pressed={logFilter === 'all'}
                  onClick={() => setLogFilter('all')}
                  className={cn(
                    'px-2 py-0.5 text-xs rounded-sm transition-colors',
                    logFilter === 'all'
                      ? 'bg-hue-forge text-(--sf-bg-primary) font-semibold'
                      : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {t('forge.logFilterAll')}
                </button>
                <button
                  type="button"
                  data-testid="log-filter-errors"
                  aria-pressed={logFilter === 'error'}
                  onClick={() => setLogFilter('error')}
                  className={cn(
                    'px-2 py-0.5 text-xs rounded-sm transition-colors',
                    logFilter === 'error'
                      ? 'bg-hue-forge text-(--sf-bg-primary) font-semibold'
                      : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {t('forge.logFilterErrors')}
                </button>
                <button
                  type="button"
                  data-testid="log-filter-warnings"
                  aria-pressed={logFilter === 'warn'}
                  onClick={() => setLogFilter('warn')}
                  className={cn(
                    'px-2 py-0.5 text-xs rounded-sm transition-colors',
                    logFilter === 'warn'
                      ? 'bg-hue-forge text-(--sf-bg-primary) font-semibold'
                      : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {t('forge.logFilterWarnings')}
                </button>
              </div>
              <LogStream
                onExport={save}
                entries={logs}
                filter={logFilter}
                hideFilterBar
                className="flex-1"
              />
            </div>
          }
        />
      </div>

      {/* ---- Bottom: KPIs + Controls ---- */}
      <m.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="space-y-3"
        data-testid="forge-execution-controls"
      >
        {/* KPI row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KPICard icon="check" label={t('forge.done')} value={kpis.done} variant="success" />
          <KPICard icon="sync" label={t('forge.running')} value={kpis.running} variant="default" />
          <KPICard icon="clock" label={t('forge.queued')} value={kpis.queued} variant="warning" />
          <KPICard icon="error" label={t('forge.failed')} value={kpis.failed} variant="error" />
          {/* The calls the run has made so far, once its progress counts
              them; until the first count comes, discovery's estimate for the
              whole run, said to be one. */}
          <KPICard
            icon="zap"
            label={t(apiCallsSoFar === null ? 'forge.apiCallsEstimated' : 'forge.apiCallsSoFar')}
            value={apiCallsSoFar ?? kpis.apiCalls ?? '—'}
            variant="default"
          />
        </div>

        {/* Control buttons: a run that stopped has nothing left to pause or
            abort, and its way on is with its error, above; one that is
            stopping has nothing left to do but answer. */}
        {!stopped && (
          <div className={cn('flex items-center gap-3')}>
            <Button
              variant="secondary"
              size="md"
              icon={isPaused ? <Play size={14} /> : <Pause size={14} />}
              onClick={handlePauseToggle}
              disabled={stopping}
              data-testid="forge-pause-button"
            >
              {isPaused ? t('forge.resume') : t('forge.pause')}
            </Button>
            <Button
              variant="danger"
              size="md"
              icon={<Square size={14} />}
              onClick={handleAbort}
              disabled={stopping}
              data-testid="forge-abort-button"
            >
              {t('forge.abort')}
            </Button>
          </div>
        )}
      </m.div>

      <DangerConfirm
        open={showAbortConfirm}
        onClose={() => setShowAbortConfirm(false)}
        onConfirm={handleAbortConfirm}
        title={t('forge.abort')}
        description={t('forge.abortConfirm')}
        confirmText={t('forge.abort')}
      />
    </div>
  );
};
