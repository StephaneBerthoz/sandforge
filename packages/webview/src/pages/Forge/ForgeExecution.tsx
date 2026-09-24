import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useFileSave } from '../../hooks/useFileSave';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import { Pause, Play, Square, Flame } from 'lucide-react';
import { SplitView } from '../../components/ui/SplitView';
import { LiveGraph } from '../../components/graph/LiveGraph';
import type { ForgeGraph as SharedForgeGraph } from '@sandforge/shared';
import { LogStream } from '../../components/ui/LogStream';
import type { LogEntry, LogFilter } from '../../components/ui/LogStream';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ProgressAnnouncer, ProgressBar } from '../../components/ui/ProgressBar';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeNodeStatus, ForgeLogEntry } from '../../stores/useForgeStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { slideUp, staggerContainer } from '../../motion/presets';
import { cn } from '../../theme';
import { formatElapsed } from '../../utils/formatters';

/** Where the run stands, as the controls set it or its error ended it. */
type ExecutionStatus = 'forging' | 'paused' | 'aborted';

/**
 * What the top bar says: the run's status, or, once every object on the graph
 * has settled and the run has not answered, that it is finishing.
 */
type ShownStatus = ExecutionStatus | 'finishing';

/** Maps the shown status to the i18n key. */
const STATUS_KEYS: Record<ShownStatus, string> = {
  forging: 'forge.forging',
  paused: 'forge.paused',
  finishing: 'forge.finishing',
  aborted: 'forge.aborted',
};

/**
 * Forge execution mission-control view.
 *
 * Displays real-time graph progress, log stream, KPI counters,
 * and pause/abort controls during a forge operation.
 */
export const ForgeExecution: React.FC = () => {
  const { save } = useFileSave();
  const { t } = useTranslation();

  /** Ref-based log ID counter — resets naturally on component remount. */
  const logIdRef = useRef(0);
  const nextLogId = useCallback(() => {
    logIdRef.current += 1;
    return `log-${logIdRef.current}`;
  }, []);
  const graph = useForgeStore((s) => s.graph);
  const updateNodeStatus = useForgeStore((s) => s.updateNodeStatus);
  const updateNodeCounts = useForgeStore((s) => s.updateNodeCounts);
  const setPhase = useForgeStore((s) => s.setPhase);
  const addLogToStore = useForgeStore((s) => s.addLog);
  const clearLogs = useForgeStore((s) => s.clearLogs);
  const setStoppedAt = useForgeStore((s) => s.setStoppedAt);
  const executionRequestId = useForgeStore((s) => s.executionRequestId);

  const [isPaused, setIsPaused] = useState(false);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus>('forging');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Timer ----
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Pause/resume timer when execution status changes
  useEffect(() => {
    if (isPaused || executionStatus === 'aborted') {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } else if (!timerRef.current && executionStatus === 'forging') {
      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    }
  }, [isPaused, executionStatus]);

  // Clear store logs on mount so a fresh execution starts clean, and forget
  // where the last run stopped: this one has not.
  const clearLogsRef = useLatestRef(clearLogs);
  const setStoppedAtRef = useLatestRef(setStoppedAt);
  useEffect(() => {
    clearLogsRef.current();
    setStoppedAtRef.current(null);
  }, [clearLogsRef, setStoppedAtRef]);

  /** Add a log entry (local state + store persistence). */
  const addLog = useCallback(
    (level: LogEntry['level'], message: string) => {
      const entry: LogEntry & ForgeLogEntry = {
        id: nextLogId(),
        timestamp: Date.now(),
        level,
        message,
      };
      setLogs((prev) => [...prev, entry]);
      addLogToStore(entry);
    },
    [nextLogId, addLogToStore],
  );

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
    const apiCalls = nodeList.reduce((sum, n) => sum + (n.estimatedApiCalls ?? 0), 0);
    /*
     * A node that was skipped or failed is finished with, so it counts toward
     * the bar. Dividing only the "done" nodes by the total left a completed run
     * showing 50% whenever half its objects had been skipped, with no card
     * accounting for them.
     */
    const settled = done + failed + skipped;
    const progress = total > 0 ? Math.round((settled / total) * 100) : 0;
    return { total, done, running, queued, failed, skipped, settled, apiCalls, progress };
  }, [graph]);
  /** Where the run stands, for recording where it stopped. */
  const progressRef = useLatestRef(kpis.progress);

  // ---- Bridge message listener ----
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview host.
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = event.data as Record<string, unknown> | undefined;
      if (!data) return;

      // Every panel receives every forge message. Once the run's request id is
      // known, a progress event, result or error correlated to another request
      // belongs to another run: such an error used to mark this run aborted.
      if (
        typeof executionRequestId === 'string' &&
        (data.type === 'forge:execute:response' ||
          data.type === 'forge:execute:error' ||
          data.type === 'forge:progress') &&
        data.correlationId !== executionRequestId
      ) {
        return;
      }

      // The run's end. Its answer is the store's to take (`takeRunAnswer`),
      // which shows the results; its error is this screen's to show.
      // `forge:progress` alone cannot close the run: on a backend failure it
      // simply stops arriving, no node reaches a terminal status, and mission
      // control spins forever with no way out but Abort.
      if (data.type === 'forge:execute:error') {
        const payload = data.payload as { message?: string } | undefined;
        setExecutionStatus('aborted');
        setStoppedAt(progressRef.current);
        addLog('error', payload?.message ?? t('forge.executeFailed'));
        return;
      }

      if (data.type !== 'forge:progress') return;

      // The extension emits forge:progress via buildResponse — the event
      // payload lives under `payload`, not at the message root.
      const payload = data.payload as Record<string, unknown> | undefined;
      if (!payload) return;
      const objectName = payload.objectName as string;
      const status = payload.status as ForgeNodeStatus;
      const progress = typeof payload.progress === 'number' ? payload.progress : undefined;

      updateNodeStatus(objectName, status, progress);
      // Counts ride the same event when the executor has them; a status change
      // that knows none leaves the node's own alone.
      updateNodeCounts(objectName, {
        recordCount: payload.recordCount as number | undefined,
        fieldCount: payload.fieldCount as number | undefined,
        createableFieldCount: payload.createableFieldCount as number | undefined,
      });

      const level: LogEntry['level'] = status === 'error' ? 'error' : 'info';
      const logMessage =
        typeof payload.message === 'string'
          ? payload.message
          : `${objectName}: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`;
      addLog(level, logMessage);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    updateNodeStatus,
    updateNodeCounts,
    addLog,
    setStoppedAt,
    progressRef,
    t,
    executionRequestId,
  ]);

  /*
   * Every object on the graph has settled while the run goes on: it is
   * finishing. Its last steps come after its last object — the lookups filled
   * in last, the files, the statuses given back, reading back when the target
   * dated its writes — and its answer says what the whole run did. This screen
   * used to leave for the results as soon as the last object settled: the
   * answer came after it had gone, and the results were shown without it. It
   * stays until the answer takes the page to them.
   */
  const finishing = executionStatus === 'forging' && kpis.total > 0 && kpis.settled === kpis.total;
  const shownStatus: ShownStatus = finishing ? 'finishing' : executionStatus;

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
    setIsPaused((prev) => {
      const next = !prev;
      setExecutionStatus(next ? 'paused' : 'forging');
      // Routed through the broker: the envelope is mandatory since 1.5.0.
      sendBridgeMessage(next ? 'forge:pause' : 'forge:resume');
      return next;
    });
  }, []);

  const handleAbort = useCallback(() => {
    setShowAbortConfirm(true);
  }, []);

  const handleAbortConfirm = useCallback(() => {
    setShowAbortConfirm(false);
    setExecutionStatus('aborted');
    addLog('warn', t('forge.aborted'));
    // Routed through the broker: the envelope is mandatory since 1.5.0.
    sendBridgeMessage('forge:abort');
    // This screen and its announcer leave with the phase change: the page
    // says the run stopped, from where it stood.
    setStoppedAt(kpis.progress);
    setPhase('input');
  }, [t, addLog, setPhase, setStoppedAt, kpis.progress]);

  return (
    <div data-testid="forge-execution" className="flex flex-col gap-4 h-full">
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
                have all settled: it read 0:00 while the run went on. */}
            {!finishing && (
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
        <ProgressAnnouncer
          message={
            finishing
              ? t('forge.finishingNote')
              : t('a11y.progressAnnouncement', {
                  name: t('nav.forge'),
                  percent: kpis.progress,
                })
          }
          // Said at once: at 100% the bar would otherwise be heard as the end.
          // A stopped run is said by the page, where it stopped, and a finished
          // one by the results.
          immediate={finishing}
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
                    'px-2 py-0.5 text-xs rounded transition-colors',
                    logFilter === 'all'
                      ? 'bg-hue-forge text-[var(--sf-bg-primary)] font-semibold'
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
                    'px-2 py-0.5 text-xs rounded transition-colors',
                    logFilter === 'error'
                      ? 'bg-hue-forge text-[var(--sf-bg-primary)] font-semibold'
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
                    'px-2 py-0.5 text-xs rounded transition-colors',
                    logFilter === 'warn'
                      ? 'bg-hue-forge text-[var(--sf-bg-primary)] font-semibold'
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
          <KPICard
            icon="zap"
            label={t('forge.apiCallsConsumed')}
            value={kpis.apiCalls}
            variant="default"
          />
        </div>

        {/* Control buttons */}
        <div className={cn('flex items-center gap-3')}>
          <Button
            variant="secondary"
            size="md"
            icon={isPaused ? <Play size={14} /> : <Pause size={14} />}
            onClick={handlePauseToggle}
            disabled={executionStatus === 'aborted'}
            data-testid="forge-pause-button"
          >
            {isPaused ? t('forge.resume') : t('forge.pause')}
          </Button>
          <Button
            variant="danger"
            size="md"
            icon={<Square size={14} />}
            onClick={handleAbort}
            disabled={executionStatus === 'aborted'}
            data-testid="forge-abort-button"
          >
            {t('forge.abort')}
          </Button>
        </div>
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
