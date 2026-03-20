import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Copy, Save, RotateCcw, Download, RefreshCw } from 'lucide-react';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { useForgeStore } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { staggerContainer, slideUp } from '../../motion/presets';
import { cn } from '../../theme';

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
  const reset = useForgeStore((s) => s.reset);
  const setPhase = useForgeStore((s) => s.setPhase);
  const setGraph = useForgeStore((s) => s.setGraph);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);

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

  /** Reset forge to go back to input phase. */
  const handleForgeAgain = useCallback(() => {
    reset();
  }, [reset]);

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

      {/* Per-object results table */}
      <motion.div variants={slideUp} initial="hidden" animate="visible">
        <div className="overflow-x-auto rounded-lg border border-subtle bg-surface-1">
          <table
            className="w-full text-sm"
            data-testid="forge-results-table"
          >
            <thead>
              <tr className="border-b border-subtle text-left text-text-secondary">
                <th className="px-4 py-2 font-medium">{t('forge.object')}</th>
                <th className="px-4 py-2 font-medium">{t('forge.records')}</th>
                <th className="px-4 py-2 font-medium">{t('forge.status')}</th>
                <th className="px-4 py-2 font-medium">{t('forge.errors')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr
                  key={node.objectApiName}
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
