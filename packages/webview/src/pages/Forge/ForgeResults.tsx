import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Copy, Save, RotateCcw, Download, RefreshCw, ChevronUp, ChevronDown, ChevronRight, FileText, AlertTriangle, Lightbulb } from 'lucide-react';
import type { ForgeExecutionError } from '@sandforge/shared';
import { translateForgeError } from './forgeErrorTranslator';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { LogStream } from '../../components/ui/LogStream';
import type { LogEntry } from '../../components/ui/LogStream';
import { useForgeStore } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { staggerContainer, slideUp } from '../../motion/presets';
import { cn } from '../../theme';
import { formatElapsed } from '../../utils/formatters';

/** Status badge colors. */
const statusBadgeStyles: Record<string, string> = {
  done: 'bg-green-500/20 text-green-400',
  error: 'bg-red-500/20 text-red-400',
  skipped: 'bg-yellow-500/20 text-yellow-400',
};

/** Props for the ForgeResults component. */
export interface ForgeResultsProps {
  /** Additional CSS classes for the root element. */
  className?: string;
}

/**
 * Forge results summary view.
 *
 * Displays KPI cards with inserted/skipped/remapped counts,
 * a per-object results table, and action buttons for
 * saving templates, copying reports, or starting a new forge.
 */
export const ForgeResults: React.FC<ForgeResultsProps> = ({ className }) => {
  const { t } = useTranslation();
  const result = useForgeStore((s) => s.result);
  const graph = useForgeStore((s) => s.graph);
  const forgeAgain = useForgeStore((s) => s.forgeAgain);
  const setPhase = useForgeStore((s) => s.setPhase);
  const setGraph = useForgeStore((s) => s.setGraph);
  const logs = useForgeStore((s) => s.logs);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);

  // Sort/filter state
  type SortField = 'objectApiName' | 'recordCount' | 'status';
  type SortDir = 'asc' | 'desc';
  const [sortField, setSortField] = useState<SortField>('objectApiName');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showLogs, setShowLogs] = useState(false);

  const inserted = useMemo(
    () => nodes.reduce((sum, n) => sum + n.successCount, 0),
    [nodes],
  );

  const skipped = useMemo(
    () => nodes.filter((n) => n.status === 'skipped').reduce((sum, n) => sum + n.recordCount, 0),
    [nodes],
  );

  const idRemaps = result?.idRemapCount ?? 0;

  const successRate = useMemo(() => {
    const total = result?.graph.totalRecords ?? nodes.reduce((sum, n) => sum + n.recordCount, 0);
    if (total === 0) return 100;
    return Math.round((inserted / total) * 100);
  }, [result, nodes, inserted]);

  const anonymizedFieldCount = useMemo(
    () => nodes.reduce((sum, n) => sum + n.anonymizeFields.length, 0),
    [nodes],
  );

  const totalApiCalls = useMemo(
    () => nodes.reduce((sum, n) => sum + n.estimatedApiCalls, 0),
    [nodes],
  );

  const failedNodes = useMemo(
    () => nodes.filter((n) => n.status === 'error'),
    [nodes],
  );

  /** Sorted and filtered nodes for the results table. */
  const sortedFilteredNodes = useMemo(() => {
    let filtered = nodes;
    if (statusFilter !== 'all') {
      filtered = filtered.filter((n) => n.status === statusFilter);
    }
    return [...filtered].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
  }, [nodes, statusFilter, sortField, sortDir]);

  /** Handle sort column click. */
  const handleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('asc');
      return field;
    });
  }, []);

  /** Build a markdown report from the current results. */
  const buildReport = useCallback((): string => {
    const lines: string[] = [
      '# Forge Execution Report',
      '',
      `- Inserted: ${String(inserted)}`,
      `- Skipped: ${String(skipped)}`,
      `- ID Remaps: ${String(idRemaps)}`,
      `- Success Rate: ${String(successRate)}%`,
      '',
      '## Per-Object Results',
      '',
      '| Object | Records | Status | Errors |',
      '|--------|---------|--------|--------|',
    ];

    for (const node of nodes) {
      const errorText = node.errors.length > 0 ? node.errors.join(', ') : '-';
      lines.push(`| ${node.objectApiName} | ${String(node.recordCount)} | ${node.status} | ${errorText} |`);
    }

    return lines.join('\n');
  }, [inserted, skipped, idRemaps, successRate, nodes]);

  /** Copy a markdown report summary to the clipboard. */
  const handleCopyReport = useCallback(async () => {
    const report = buildReport();
    await navigator.clipboard.writeText(report);
  }, [buildReport]);

  /** Placeholder for save-as-template action. */
  const handleSaveTemplate = useCallback(() => {
    addNotification({ level: 'info', title: t('forge.saveTemplate'), message: 'Coming soon', autoDismissMs: 3000 });
  }, [addNotification, t]);

  /** Serialize result to JSON and copy to clipboard. */
  const handleExportJson = useCallback(async () => {
    const json = JSON.stringify(result, null, 2);
    await navigator.clipboard.writeText(json);
    addNotification({ level: 'success', title: t('forge.exportJson'), message: t('forge.exportJson'), autoDismissMs: 3000 });
  }, [result, addNotification, t]);

  /** Retry only failed nodes by resetting them and going back to execution. */
  const handleRetryFailed = useCallback(() => {
    if (!graph || failedNodes.length === 0) return;
    const retryGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.status === 'error'
          ? { ...n, status: 'idle' as const, progress: 0, errors: [], successCount: 0, failureCount: 0 }
          : n,
      ),
    };
    setGraph(retryGraph);
    setPhase('execution');
  }, [graph, failedNodes, setGraph, setPhase]);

  /** Soft reset: clear result but keep config. */
  const handleForgeAgain = useCallback(() => {
    forgeAgain();
  }, [forgeAgain]);

  return (
    <div data-testid="forge-results" className={cn('flex flex-col gap-4', className)}>
      {/* KPI row */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        <KPICard
          icon="check"
          label={t('forge.inserted')}
          value={inserted}
          variant="success"
        />
        <KPICard
          icon="debug-step-over"
          label={t('forge.skipped')}
          value={skipped}
          variant="warning"
        />
        <KPICard
          icon="arrow-swap"
          label={t('forge.idRemaps')}
          value={idRemaps}
          variant="default"
        />
        <KPICard
          icon="trophy"
          label={t('forge.successRate')}
          value={`${String(successRate)}%`}
          variant={successRate >= 90 ? 'success' : successRate >= 50 ? 'warning' : 'error'}
        />
        <KPICard
          icon="shield"
          label={t('forge.anonymizedFields')}
          value={anonymizedFieldCount}
          variant="default"
        />
        <KPICard
          icon="zap"
          label={t('forge.apiCallsConsumed')}
          value={totalApiCalls}
          variant="default"
        />
      </motion.div>

      {/* Duration + timestamp */}
      {result && (
        <div className="flex items-center gap-4 text-sm text-text-secondary">
          <span data-testid="forge-results-duration">
            {t('forge.executionDuration')}: <strong className="text-text-primary">{formatElapsed(Math.round(result.duration / 1000))}</strong>
          </span>
          <span data-testid="forge-results-timestamp">
            {t('forge.executionTimestamp')}: <strong className="text-text-primary">{new Date(result.timestamp).toLocaleString()}</strong>
          </span>
        </div>
      )}

      {/* Per-object results table */}
      <motion.div variants={slideUp} initial="hidden" animate="visible">
        <div className="flex items-center gap-2 mb-2">
          <select
            data-testid="forge-results-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={cn(
              'px-2 py-1 rounded text-xs',
              'bg-[var(--vscode-input-background,#1e1e3a)]',
              'text-[var(--vscode-input-foreground,#d4d4d4)]',
              'border border-[var(--vscode-input-border,#3a3a5c)]',
            )}
          >
            <option value="all">{t('forge.filterByStatus')}</option>
            <option value="done">{t('forge.done')}</option>
            <option value="error">{t('forge.failed')}</option>
            <option value="skipped">{t('forge.skipped')}</option>
          </select>
        </div>
        <div className="overflow-x-auto rounded-lg border border-subtle bg-surface-1">
          <table
            className="w-full text-sm"
            data-testid="forge-results-table"
          >
            <thead>
              <tr className="border-b border-subtle text-left text-text-secondary">
                <th
                  className="px-4 py-2 font-medium cursor-pointer hover:text-text-primary select-none"
                  data-testid="forge-results-sort-object"
                  onClick={() => handleSort('objectApiName')}
                >
                  {t('forge.object')}
                  {sortField === 'objectApiName' && (sortDir === 'asc' ? <ChevronUp size={12} className="inline ml-1" /> : <ChevronDown size={12} className="inline ml-1" />)}
                </th>
                <th
                  className="px-4 py-2 font-medium cursor-pointer hover:text-text-primary select-none"
                  data-testid="forge-results-sort-records"
                  onClick={() => handleSort('recordCount')}
                >
                  {t('forge.records')}
                  {sortField === 'recordCount' && (sortDir === 'asc' ? <ChevronUp size={12} className="inline ml-1" /> : <ChevronDown size={12} className="inline ml-1" />)}
                </th>
                <th
                  className="px-4 py-2 font-medium cursor-pointer hover:text-text-primary select-none"
                  data-testid="forge-results-sort-status"
                  onClick={() => handleSort('status')}
                >
                  {t('forge.status')}
                  {sortField === 'status' && (sortDir === 'asc' ? <ChevronUp size={12} className="inline ml-1" /> : <ChevronDown size={12} className="inline ml-1" />)}
                </th>
                <th className="px-4 py-2 font-medium">{t('forge.errors')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedFilteredNodes.map((node) => (
                <tr
                  key={node.objectApiName}
                  data-testid="forge-results-row"
                  className="border-b border-subtle last:border-b-0"
                >
                  <td className="px-4 py-2 font-mono text-text-primary">
                    {node.objectApiName}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-text-primary">
                    {node.recordCount}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={cn(
                        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                        statusBadgeStyles[node.status] ?? 'bg-surface-2 text-text-secondary',
                      )}
                    >
                      {node.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">
                    {node.errors.length > 0 ? node.errors.join(', ') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Structured execution errors (Wave 2.6 — grouped by object/stage) */}
      {result?.errors && result.errors.length > 0 && (
        <ForgeErrorsPanel errors={result.errors} />
      )}

      {/* Collapsible execution logs */}
      {logs.length > 0 && (
        <motion.div variants={slideUp} initial="hidden" animate="visible">
          <button
            type="button"
            data-testid="forge-results-toggle-logs"
            onClick={() => setShowLogs((prev) => !prev)}
            className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors mb-2"
          >
            <ChevronRight size={14} className={cn('transition-transform', showLogs && 'rotate-90')} />
            <FileText size={14} />
            {showLogs ? t('forge.hideLogs') : t('forge.showLogs')}
            <span className="text-text-muted">({String(logs.length)})</span>
          </button>
          {showLogs && (
            <LogStream
              entries={logs as unknown as LogEntry[]}
              className="max-h-64"
              autoScroll={false}
            />
          )}
        </motion.div>
      )}

      {/* Actions row */}
      <motion.div variants={slideUp} initial="hidden" animate="visible" className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="md"
          icon={<Save size={14} />}
          onClick={handleSaveTemplate}
          data-testid="forge-save-template"
        >
          {t('forge.saveTemplate')}
        </Button>
        <Button
          variant="secondary"
          size="md"
          icon={<Copy size={14} />}
          onClick={handleCopyReport}
          data-testid="forge-copy-report"
        >
          {t('forge.copyReport')}
        </Button>
        <Button
          variant="secondary"
          size="md"
          icon={<Download size={14} />}
          onClick={handleExportJson}
          data-testid="forge-export-json"
        >
          {t('forge.exportJson')}
        </Button>
        {failedNodes.length > 0 && (
          <Button
            variant="secondary"
            size="md"
            icon={<RefreshCw size={14} />}
            onClick={handleRetryFailed}
            data-testid="forge-retry-failed"
          >
            {t('forge.retryFailed')}
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          icon={<RotateCcw size={14} />}
          onClick={handleForgeAgain}
          data-testid="forge-again"
        >
          {t('forge.forgeAgain')}
        </Button>
      </motion.div>
    </div>
  );
};

/** Stage label colour and human-readable text. */
const stageStyles: Record<ForgeExecutionError['stage'], { label: string; cls: string }> = {
  insert: { label: 'Insert', cls: 'bg-red-500/20 text-red-400' },
  query: { label: 'Query', cls: 'bg-orange-500/20 text-orange-400' },
  scope: { label: 'Scope', cls: 'bg-yellow-500/20 text-yellow-400' },
};

/**
 * Structured errors panel — surfaces `ForgeExecutionResult.errors` from the
 * executor (Wave 2.6) grouped by object and stage, with up to three sample
 * failures and the raw Salesforce status codes. Lets the user see exactly
 * which fields/records broke without re-running the operation.
 */
const ForgeErrorsPanel: React.FC<{ errors: ForgeExecutionError[] }> = ({ errors }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const totals = useMemo(() => {
    let totalFailed = 0;
    for (const e of errors) totalFailed += e.failedCount;
    return totalFailed;
  }, [errors]);

  return (
    <motion.div
      variants={slideUp}
      initial="hidden"
      animate="visible"
      data-testid="forge-errors-panel"
      className="rounded-lg border border-red-500/30 bg-red-500/5"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-red-500/20">
        <AlertTriangle size={16} className="text-red-400" />
        <h3 className="text-sm font-semibold text-text-primary">
          {t('forge.errorsPanel.title', { defaultValue: 'Execution errors' })}
        </h3>
        <span className="text-xs text-text-muted ml-auto tabular-nums">
          {errors.length} {t('forge.object', { defaultValue: 'objects' })} · {totals} {t('forge.records', { defaultValue: 'records' })}
        </span>
      </div>
      <ul className="divide-y divide-red-500/10">
        {errors.map((err) => {
          const key = `${err.objectApiName}__${err.stage}`;
          const isOpen = expanded.has(key);
          const stage = stageStyles[err.stage];
          return (
            <li key={key} data-testid="forge-errors-row" className="px-4 py-2">
              <button
                type="button"
                onClick={() => toggleExpand(key)}
                className="w-full flex items-center gap-2 text-left text-sm hover:text-text-primary transition-colors"
                aria-expanded={isOpen}
              >
                <ChevronRight
                  size={14}
                  className={cn('transition-transform shrink-0', isOpen && 'rotate-90')}
                />
                <span className="font-mono text-text-primary truncate">{err.objectApiName}</span>
                <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', stage.cls)}>
                  {stage.label}
                </span>
                <span className="ml-auto text-xs text-text-secondary tabular-nums">
                  {err.failedCount}{err.attemptedCount > 0 ? `/${err.attemptedCount}` : ''}
                </span>
              </button>
              {isOpen && err.samples.length > 0 && (
                <div className="mt-2 ml-6 space-y-2 text-xs" data-testid="forge-errors-samples">
                  {err.samples.map((sample, idx) => (
                    <div
                      key={idx}
                      className="rounded border border-red-500/20 bg-surface-1 px-3 py-2"
                    >
                      <div className="font-mono text-text-secondary mb-1 break-all">
                        {sample.recordSummary}
                      </div>
                      <ul className="space-y-2">
                        {sample.messages.map((msg, mi) => {
                          const translated = translateForgeError(msg);
                          return (
                            <li key={mi} className="space-y-1">
                              <div className="text-red-300 break-words font-mono">└ {msg}</div>
                              {translated && (
                                <div
                                  data-testid="forge-error-translation"
                                  className={cn(
                                    'ml-4 px-2 py-1 rounded border text-text-primary',
                                    translated.severity === 'error' && 'border-red-500/30 bg-red-500/5',
                                    translated.severity === 'warning' && 'border-yellow-500/30 bg-yellow-500/5',
                                    translated.severity === 'info' && 'border-blue-500/30 bg-blue-500/5',
                                  )}
                                >
                                  <div className="flex items-start gap-1.5">
                                    <Lightbulb size={12} className="mt-0.5 shrink-0 text-yellow-400" />
                                    <div>
                                      <div className="text-text-primary">
                                        {t(translated.explanationKey, translated.vars ?? {})}
                                      </div>
                                      <div className="text-text-secondary mt-1 italic">
                                        → {t(translated.actionKey, translated.vars ?? {})}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
};
