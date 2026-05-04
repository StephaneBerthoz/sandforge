import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Pause, Play, Square, Flame } from 'lucide-react';
import { SplitView } from '../../components/ui/SplitView';
import { LiveGraph } from '../../components/graph/LiveGraph';
import type { ForgeGraph as SharedForgeGraph } from '@sandforge/shared';
import { LogStream } from '../../components/ui/LogStream';
import type { LogEntry, LogFilter } from '../../components/ui/LogStream';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeNodeStatus, ForgeLogEntry } from '../../stores/useForgeStore';
import { slideUp, staggerContainer } from '../../motion/presets';
import { cn } from '../../theme';
import { formatElapsed } from '../../utils/formatters';

/** Status label key used for the execution status display. */
type ExecutionStatus = 'forging' | 'paused' | 'complete' | 'aborted';

/** Maps execution status to the i18n key. */
const STATUS_KEYS: Record<ExecutionStatus, string> = {
  forging: 'forge.forging',
  paused: 'forge.paused',
  complete: 'forge.complete',
  aborted: 'forge.aborted',
};

/**
 * Forge execution mission-control view.
 *
 * Displays real-time graph progress, log stream, KPI counters,
 * and pause/abort controls during a forge operation.
 */
export const ForgeExecution: React.FC = () => {
  const { t } = useTranslation();

  /** Ref-based log ID counter — resets naturally on component remount. */
  const logIdRef = useRef(0);
  const nextLogId = useCallback(() => {
    logIdRef.current += 1;
    return `log-${logIdRef.current}`;
  }, []);
  const graph = useForgeStore((s) => s.graph);
  const updateNodeStatus = useForgeStore((s) => s.updateNodeStatus);
  const setPhase = useForgeStore((s) => s.setPhase);
  const addLogToStore = useForgeStore((s) => s.addLog);
  const clearLogs = useForgeStore((s) => s.clearLogs);

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
    if (isPaused || executionStatus === 'complete' || executionStatus === 'aborted') {
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

  // Clear store logs on mount so a fresh execution starts clean
  useEffect(() => {
    clearLogs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---- Bridge message listener ----
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview host.
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = event.data as Record<string, unknown> | undefined;
      if (!data || data.type !== 'forge:progress') return;

      const objectName = data.objectName as string;
      const status = data.status as ForgeNodeStatus;
      const progress = typeof data.progress === 'number' ? data.progress : undefined;

      updateNodeStatus(objectName, status, progress);

      const level: LogEntry['level'] = status === 'error' ? 'error' : 'info';
      const logMessage =
        typeof data.message === 'string'
          ? data.message
          : `${objectName}: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`;
      addLog(level, logMessage);

      // Check if all nodes are terminal
      if (graph) {
        const updatedNodes = graph.nodes.map((n) =>
          n.objectApiName === objectName ? { ...n, status, progress: progress ?? n.progress } : n,
        );
        const allTerminal = updatedNodes.every(
          (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped',
        );
        if (allTerminal) {
          setExecutionStatus('complete');
          setPhase('results');
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [graph, updateNodeStatus, setPhase, addLog]);

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
    const apiCalls = nodeList.reduce((sum, n) => sum + (n.estimatedApiCalls ?? 0), 0);
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, done, running, queued, failed, apiCalls, progress };
  }, [graph]);

  // ETA calculation
  const etaSeconds = useMemo(() => {
    if (kpis.done === 0 || kpis.total === 0) return null;
    const avgTimePerNode = elapsed / kpis.done;
    const remaining = kpis.total - kpis.done;
    return Math.round(avgTimePerNode * remaining);
  }, [elapsed, kpis.done, kpis.total]);

  // ---- Pause / Abort handlers ----
  const handlePauseToggle = useCallback(() => {
    setIsPaused((prev) => {
      const next = !prev;
      setExecutionStatus(next ? 'paused' : 'forging');
      // Send bridge message
      try {
        const win = window as unknown as Record<string, unknown>;
        const vscode = win.vscodeApi as { postMessage: (m: unknown) => void } | undefined;
        vscode?.postMessage({ type: next ? 'forge:pause' : 'forge:resume' });
      } catch {
        // no-op outside VSCode
      }
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
    try {
      const win = window as unknown as Record<string, unknown>;
      const vscode = win.vscodeApi as { postMessage: (m: unknown) => void } | undefined;
      vscode?.postMessage({ type: 'forge:abort' });
    } catch {
      // no-op outside VSCode
    }
    setPhase('input');
  }, [t, addLog, setPhase]);

  return (
    <div data-testid="forge-execution" className="flex flex-col gap-4 h-full">
      {/* ---- Top bar: progress, timer, status ---- */}
      <motion.div variants={slideUp} initial="hidden" animate="visible" className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 font-bold text-forge">
            <Flame size={16} />
            <span data-testid="forge-execution-status">{t(STATUS_KEYS[executionStatus])}</span>
          </span>
          <span className="flex items-center gap-3 text-text-secondary tabular-nums">
            <span data-testid="forge-execution-timer">
              {t('forge.elapsed')}: {formatElapsed(elapsed)}
            </span>
            <span data-testid="forge-execution-eta" className="text-forge">
              {t('forge.eta')}:{' '}
              {etaSeconds !== null ? formatElapsed(etaSeconds) : t('forge.etaCalculating')}
            </span>
          </span>
        </div>
        <div
          className="h-2 w-full rounded-full bg-surface-2 overflow-hidden"
          data-testid="forge-execution-progress"
        >
          <div
            className="h-full rounded-full bg-forge transition-all duration-300 ease-out"
            style={{ width: `${kpis.progress}%` }}
            role="progressbar"
            aria-valuenow={kpis.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </motion.div>

      {/* ---- Middle: SplitView (graph + logs) ---- */}
      <div className="flex-1 min-h-0 min-h-[300px]">
        <SplitView
          ratio="60/40"
          left={
            graph ? (
              <LiveGraph graph={graph as unknown as SharedForgeGraph} className="h-full" />
            ) : (
              <div className="flex h-full items-center justify-center text-text-muted">
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
                      ? 'bg-forge text-white font-semibold'
                      : 'text-text-muted hover:text-text-secondary',
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
                      ? 'bg-forge text-white font-semibold'
                      : 'text-text-muted hover:text-text-secondary',
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
                      ? 'bg-forge text-white font-semibold'
                      : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  {t('forge.logFilterWarnings')}
                </button>
              </div>
              <LogStream entries={logs} filter={logFilter} hideFilterBar className="flex-1" />
            </div>
          }
        />
      </div>

      {/* ---- Bottom: KPIs + Controls ---- */}
      <motion.div
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
            disabled={executionStatus === 'complete' || executionStatus === 'aborted'}
            data-testid="forge-pause-button"
          >
            {isPaused ? t('forge.resume') : t('forge.pause')}
          </Button>
          <Button
            variant="danger"
            size="md"
            icon={<Square size={14} />}
            onClick={handleAbort}
            disabled={executionStatus === 'complete' || executionStatus === 'aborted'}
            data-testid="forge-abort-button"
          >
            {t('forge.abort')}
          </Button>
        </div>
      </motion.div>

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
