import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useFileSave } from '../../hooks/useFileSave';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import {
  Copy,
  Save,
  RotateCcw,
  Download,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  FileText,
  AlertTriangle,
  Lightbulb,
} from 'lucide-react';
import type { ForgeExecutionError } from '@sandforge/shared';
import { translateForgeError } from './forgeErrorTranslator';
import { KPICard } from '../../components/ui/KPICard';
import { ProgressAnnouncer } from '../../components/ui/ProgressBar';
import { Button } from '../../components/ui/Button';
import { VirtualList } from '../../components/ui/VirtualList';
import { LogStream } from '../../components/ui/LogStream';
import type { LogEntry } from '../../components/ui/LogStream';
import { useForgeStore } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { staggerContainer, slideUp } from '../../motion/presets';
import { cn } from '../../theme';
import { formatElapsed, formatStoredDate, uiLocale } from '../../utils/formatters';
import { templateFromRun } from './forgeRunConfig';
import { useSaveForgeTemplate } from './useSaveForgeTemplate';
import { ForgeFilesResult } from './ForgeFilesResult';

/**
 * Above this many source -> target pairs the Id map switches from a plain
 * table to a virtualized list.
 *
 * The executor returns one pair per cloned record, so a 100 000-record clone
 * used to mount 100 000 `<tr>` and 200 000 `<td>` at once and froze the tab.
 * Below the threshold the plain table stays: it keeps the real table
 * semantics, and a few hundred rows cost nothing.
 */
export const ID_REMAP_VIRTUALIZE_THRESHOLD = 200;

/** Status badge colors. */
const statusBadgeStyles: Record<string, string> = {
  done: 'bg-status-success/10 text-status-success',
  error: 'bg-status-error/10 text-status-error',
  skipped: 'bg-status-warning/10 text-status-warning',
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
 * copying reports, exporting JSON, or starting a new forge.
 */
export const ForgeResults: React.FC<ForgeResultsProps> = ({ className }) => {
  const { save } = useFileSave();
  const { t } = useTranslation();
  const result = useForgeStore((s) => s.result);
  const graph = useForgeStore((s) => s.graph);
  const forgeAgain = useForgeStore((s) => s.forgeAgain);
  const setPhase = useForgeStore((s) => s.setPhase);
  const setGraph = useForgeStore((s) => s.setGraph);
  const logs = useForgeStore((s) => s.logs);
  const config = useForgeStore((s) => s.config);
  const anonymizationRules = useForgeStore((s) => s.anonymizationRules);
  const anonymizationPresetId = useForgeStore((s) => s.anonymizationPresetId);
  const addNotification = useNotificationStore((s) => s.addNotification);
  const saver = useSaveForgeTemplate();

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);

  // Sort/filter state
  type SortField = 'objectApiName' | 'recordCount' | 'status';
  type SortDir = 'asc' | 'desc';
  const [sortField, setSortField] = useState<SortField>('objectApiName');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showLogs, setShowLogs] = useState(false);

  // What the run created, as the executor counted it. A run never fills in the
  // graph's own per-node counts, so after a real one they add up to zero; a
  // result recorded before the count was carried still falls back on them.
  const inserted = useMemo(
    () => result?.createdCount ?? nodes.reduce((sum, n) => sum + n.successCount, 0),
    [result?.createdCount, nodes],
  );

  /** Records the target already held and named: linked to, neither created nor failed. */
  const linked = result?.linkedExistingCount ?? 0;

  const skipped = useMemo(
    () => nodes.filter((n) => n.status === 'skipped').reduce((sum, n) => sum + n.recordCount, 0),
    [nodes],
  );

  const idRemaps = result?.idRemapCount ?? 0;

  /** Source -> target Id pairs, ordered as the run produced them. */
  const idRemapRows = useMemo(
    () => Object.entries(result?.idRemapTable ?? {}),
    [result?.idRemapTable],
  );

  /** Source ids whose target is a record the target org already held. */
  const existingSourceIds = useMemo(
    () => new Set(result?.idRemapExisting ?? []),
    [result?.idRemapExisting],
  );

  /** Per object, the rows the target refused because it already held them. */
  const existingRecords = useMemo(() => result?.existingRecords ?? [], [result?.existingRecords]);

  /** Records the run set out to write. */
  const plannedRecords = useMemo(
    () => result?.graph.totalRecords ?? nodes.reduce((sum, n) => sum + n.recordCount, 0),
    [result, nodes],
  );

  // A record linked to the one the target already held is in the target, and
  // its children point at it: for the rate, it made it.
  const successRate = useMemo(() => {
    if (plannedRecords === 0) return 100;
    return Math.round(((inserted + linked) / plannedRecords) * 100);
  }, [plannedRecords, inserted, linked]);

  const anonymizedFieldCount = useMemo(
    () => nodes.reduce((sum, n) => sum + n.anonymizeFields.length, 0),
    [nodes],
  );

  const totalApiCalls = useMemo(
    () => nodes.reduce((sum, n) => sum + n.estimatedApiCalls, 0),
    [nodes],
  );

  const failedNodes = useMemo(() => nodes.filter((n) => n.status === 'error'), [nodes]);

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
      `- Linked to existing: ${String(linked)}`,
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
      lines.push(
        `| ${node.objectApiName} | ${String(node.recordCount)} | ${node.status} | ${errorText} |`,
      );
    }

    if (existingRecords.length > 0) {
      lines.push('', '## Already in the Target', '', '| Object | Linked | Not identified |');
      lines.push('|--------|--------|----------------|');
      for (const e of existingRecords) {
        lines.push(`| ${e.objectApiName} | ${String(e.linked)} | ${String(e.unidentified)} |`);
      }
    }

    return lines.join('\n');
  }, [inserted, linked, skipped, idRemaps, successRate, nodes, existingRecords]);

  /** Copy a markdown report summary to the clipboard. */
  const handleCopyReport = useCallback(async () => {
    const report = buildReport();
    await navigator.clipboard.writeText(report);
  }, [buildReport]);

  /** Serialize result to JSON and copy to clipboard. */
  const handleExportJson = useCallback(async () => {
    const json = JSON.stringify(result, null, 2);
    await navigator.clipboard.writeText(json);
    addNotification({
      level: 'success',
      title: t('forge.exportJson'),
      message: t('forge.exportJson'),
      autoDismissMs: 3000,
    });
  }, [result, addNotification, t]);

  /** Retry only failed nodes by resetting them and going back to execution. */
  const handleRetryFailed = useCallback(() => {
    if (!graph || failedNodes.length === 0) return;
    const retryGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.status === 'error'
          ? {
              ...n,
              status: 'idle' as const,
              progress: 0,
              errors: [],
              successCount: 0,
              failureCount: 0,
            }
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

  /* ---- Save as template ---- */
  const [saveOpen, setSaveOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [nameMissing, setNameMissing] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // The form opens on its first field, and a finished save hands focus back
  // to the button that opened it: the form, and the field that had focus in
  // it, are gone.
  useEffect(() => {
    if (saveOpen) nameInputRef.current?.focus();
  }, [saveOpen]);

  useEffect(() => {
    if (!saver.saved) return;
    setSaveOpen(false);
    setTemplateName('');
    setTemplateDescription('');
    saveButtonRef.current?.focus();
  }, [saver.saved]);

  /**
   * Save the run's configuration as a template the Template tab lists: its
   * input, depth and caps, the anonymization it was reviewed with, and the org
   * it wrote to.
   */
  const handleSaveTemplate = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      // Enter in a field submits too, and a second save in flight would store
      // the run twice, under two ids.
      if (!config || saver.saving) return;
      if (!templateName.trim()) {
        setNameMissing(true);
        nameInputRef.current?.focus();
        return;
      }
      const savedAt = new Date().toISOString();
      saver.save(
        templateFromRun({
          id: `tpl-${Date.now()}`,
          name: templateName,
          description: templateDescription,
          config,
          anonymizationRules,
          anonymizationPresetId,
          objectCount: nodes.filter((n) => n.included).length,
          recordCount: plannedRecords,
          savedAt,
        }),
      );
    },
    [
      config,
      templateName,
      templateDescription,
      anonymizationRules,
      anonymizationPresetId,
      nodes,
      plannedRecords,
      saver,
    ],
  );

  return (
    <div data-testid="forge-results" className={cn('flex flex-col gap-4', className)}>
      {/* The execution screen's announcer unmounts in the pass that shows this
          one, so the finished run is spoken from here. */}
      <ProgressAnnouncer
        message={t('a11y.runFinished', {
          name: t('nav.forge'),
          written: inserted,
          total: plannedRecords,
        })}
        immediate
        testId="forge-results-status"
      />
      {/* KPI row */}
      <m.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className={cn(
          'grid grid-cols-2 gap-3 sm:grid-cols-3',
          linked > 0 ? 'lg:grid-cols-7' : 'lg:grid-cols-6',
        )}
      >
        <KPICard icon="check" label={t('forge.inserted')} value={inserted} variant="success" />
        {/* Shown only when the target held some: a card reading zero on every
            ordinary run would be noise. */}
        {linked > 0 && (
          <KPICard icon="link" label={t('forge.linkedExisting')} value={linked} variant="success" />
        )}
        <KPICard
          icon="debug-step-over"
          label={t('forge.skipped')}
          value={skipped}
          variant="warning"
        />
        <KPICard icon="arrow-swap" label={t('forge.idRemaps')} value={idRemaps} variant="default" />
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
      </m.div>

      {/* Duration + timestamp */}
      {result && (
        <div className="flex items-center gap-4 text-sm text-text-secondary">
          <span data-testid="forge-results-duration">
            {t('forge.executionDuration')}:{' '}
            <strong className="text-text-primary">
              {formatElapsed(Math.round(result.duration / 1000))}
            </strong>
          </span>
          <span data-testid="forge-results-timestamp">
            {t('forge.executionTimestamp')}:{' '}
            <strong className="text-text-primary">
              {/* A stored time that is not a date read "Invalid Date". */}
              {formatStoredDate(result.timestamp, (date) => date.toLocaleString(uiLocale())) ??
                t('common.dateUnknown')}
            </strong>
          </span>
        </div>
      )}

      {/* Per-object results table */}
      <m.div variants={slideUp} initial="hidden" animate="visible">
        <div className="flex items-center gap-2 mb-2">
          <select
            data-testid="forge-results-status-filter"
            aria-label={t('forge.statusFilterLabel')}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={cn(
              'px-2 py-1 rounded text-xs',
              'bg-[var(--sf-bg-input)]',
              'text-[var(--sf-text-input)]',
              'border border-[var(--sf-border-input)]',
            )}
          >
            <option value="all">{t('forge.filterByStatus')}</option>
            <option value="done">{t('forge.done')}</option>
            <option value="error">{t('forge.failed')}</option>
            <option value="skipped">{t('forge.skipped')}</option>
          </select>
        </div>
        <div className="overflow-x-auto rounded-lg border border-subtle bg-surface-1">
          <table className="w-full text-sm" data-testid="forge-results-table">
            <thead>
              <tr className="border-b border-subtle text-left text-text-secondary">
                {/* Each sort trigger is a real button — a click handler on the
                    <th> alone is unreachable by keyboard — while aria-sort stays
                    on the <th>, the only element it is announced from. */}
                <th
                  className="px-4 py-2 font-medium select-none"
                  aria-sort={
                    sortField === 'objectApiName'
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  <button
                    type="button"
                    data-testid="forge-results-sort-object"
                    className="inline-flex w-full cursor-pointer items-center gap-1 text-left hover:text-text-primary"
                    onClick={() => handleSort('objectApiName')}
                  >
                    {t('forge.object')}
                    {sortField === 'objectApiName' &&
                      (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th
                  className="px-4 py-2 font-medium select-none"
                  aria-sort={
                    sortField === 'recordCount'
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  <button
                    type="button"
                    data-testid="forge-results-sort-records"
                    className="inline-flex w-full cursor-pointer items-center gap-1 text-left hover:text-text-primary"
                    onClick={() => handleSort('recordCount')}
                  >
                    {t('forge.records')}
                    {sortField === 'recordCount' &&
                      (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th
                  className="px-4 py-2 font-medium select-none"
                  aria-sort={
                    sortField === 'status'
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  <button
                    type="button"
                    data-testid="forge-results-sort-status"
                    className="inline-flex w-full cursor-pointer items-center gap-1 text-left hover:text-text-primary"
                    onClick={() => handleSort('status')}
                  >
                    {t('forge.status')}
                    {sortField === 'status' &&
                      (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
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
                  <td className="px-4 py-2 font-mono text-text-primary">{node.objectApiName}</td>
                  <td className="px-4 py-2 tabular-nums text-text-primary">{node.recordCount}</td>
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
      </m.div>

      {/* Source -> target Id map. The executor has always returned this table;
          only its count used to survive, so a finished clone could report
          "312 records" without being able to say where any one of them went. */}
      {idRemapRows.length > 0 && (
        <div
          data-testid="forge-id-mapping"
          className="rounded-lg border border-subtle bg-surface-1 p-3"
        >
          <h3 className="text-sm font-semibold text-text-primary mb-2">
            {t('forge.idMapping.title')}
          </h3>
          <p className="text-xs text-text-secondary mb-2">
            {t('forge.idMapping.subtitle', { count: idRemapRows.length })}
            {existingSourceIds.size > 0 &&
              ` ${t('forge.idMapping.existingNote', { count: existingSourceIds.size })}`}
          </p>
          {idRemapRows.length > ID_REMAP_VIRTUALIZE_THRESHOLD ? (
            <div data-testid="forge-id-mapping-virtual">
              <div className="flex text-xs text-left text-text-secondary">
                <span className="w-1/2 py-1 pr-3 font-medium">{t('forge.idMapping.sourceId')}</span>
                <span className="w-1/2 py-1 font-medium">{t('forge.idMapping.targetId')}</span>
              </div>
              <VirtualList
                items={idRemapRows}
                keyExtractor={([sourceId]) => sourceId}
                estimatedItemHeight={24}
                maxHeight="16rem"
                renderItem={([sourceId, targetId]) => (
                  <div data-testid="forge-id-mapping-row" className="flex text-xs">
                    <span className="w-1/2 py-1 pr-3 font-mono text-text-secondary truncate">
                      {sourceId}
                    </span>
                    <span className="w-1/2 py-1 font-mono text-text-primary truncate">
                      {targetId}
                      {existingSourceIds.has(sourceId) && <ExistingBadge />}
                    </span>
                  </div>
                )}
              />
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs" data-testid="forge-id-mapping-table">
                <thead>
                  <tr className="text-left text-text-secondary">
                    <th className="py-1 pr-3 font-medium">{t('forge.idMapping.sourceId')}</th>
                    <th className="py-1 font-medium">{t('forge.idMapping.targetId')}</th>
                  </tr>
                </thead>
                <tbody>
                  {idRemapRows.map(([sourceId, targetId]) => (
                    <tr key={sourceId} data-testid="forge-id-mapping-row">
                      <td className="py-1 pr-3 font-mono text-text-secondary">{sourceId}</td>
                      <td className="py-1 font-mono text-text-primary">
                        {targetId}
                        {existingSourceIds.has(sourceId) && <ExistingBadge />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Rows the target refused because it already held them. Linked ones are
          neither created nor failed, and a duplicate Salesforce did not name
          is a failure whose children lost their lookup — both need saying,
          and the per-object table has no word for either. */}
      {existingRecords.length > 0 && (
        <div
          className="rounded border border-subtle px-4 py-2 text-xs text-text-secondary"
          role="status"
          data-testid="forge-results-existing"
        >
          <p className="font-medium text-text-primary">{t('forge.existingRecords.title')}</p>
          <p className="mt-0.5">{t('forge.existingRecords.hint')}</p>
          <ul className="mt-1 space-y-0.5">
            {existingRecords.map((e) => (
              <li key={e.objectApiName} data-testid="forge-results-existing-row">
                <span className="font-mono text-text-primary">{e.objectApiName}</span>
                {e.linked > 0 && ` — ${t('forge.existingRecords.linked', { count: e.linked })}`}
                {e.unidentified > 0 && (
                  <span className="text-status-warning">
                    {` — ${t('forge.existingRecords.unidentified', { count: e.unidentified })}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The files of the cloned records, for a run asked to copy them: what
          it copied, and every file it left out with why. */}
      {result?.files && <ForgeFilesResult files={result.files} />}

      {/* A read stopped by a bound is not a failure and would otherwise leave
          the wizard showing an unqualified success for a partial clone. */}
      {result?.truncatedObjects && result.truncatedObjects.length > 0 && (
        <div
          className="rounded border border-[var(--sf-warning)] px-4 py-2 text-xs text-status-warning"
          role="status"
          data-testid="forge-results-truncated"
        >
          {t('forge.truncatedRead', { objects: result.truncatedObjects.join(', ') })}
        </div>
      )}

      {/* Structured execution errors, grouped by object/stage */}
      {result?.errors && result.errors.length > 0 && <ForgeErrorsPanel errors={result.errors} />}

      {/* Collapsible execution logs */}
      {logs.length > 0 && (
        <m.div variants={slideUp} initial="hidden" animate="visible">
          <button
            type="button"
            data-testid="forge-results-toggle-logs"
            onClick={() => setShowLogs((prev) => !prev)}
            className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors mb-2"
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform', showLogs && 'rotate-90')}
            />
            <FileText size={14} />
            {showLogs ? t('forge.hideLogs') : t('forge.showLogs')}
            <span className="text-text-secondary">({String(logs.length)})</span>
          </button>
          {showLogs && (
            <LogStream
              onExport={save}
              entries={logs as unknown as LogEntry[]}
              className="max-h-64"
              autoScroll={false}
            />
          )}
        </m.div>
      )}

      {/* Actions row */}
      <m.div
        variants={slideUp}
        initial="hidden"
        animate="visible"
        className="flex flex-wrap items-center gap-3"
      >
        <Button
          ref={saveButtonRef}
          variant="secondary"
          size="md"
          icon={<Save size={14} />}
          disabled={!config}
          aria-expanded={saveOpen}
          aria-controls="forge-save-template-form"
          onClick={() => setSaveOpen((open) => !open)}
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
      </m.div>

      {saveOpen && (
        <form
          id="forge-save-template-form"
          data-testid="forge-save-template-form"
          aria-labelledby="forge-save-template-title"
          onSubmit={handleSaveTemplate}
          noValidate
          className="flex flex-col gap-2 rounded-lg border border-forge/30 bg-surface-1 p-3"
        >
          <p id="forge-save-template-title" className="text-sm font-semibold text-text-primary">
            {t('forge.savedTemplate.formTitle')}
          </p>
          <p className="text-xs text-text-secondary">{t('forge.savedTemplate.saveHint')}</p>
          <label htmlFor="forge-save-template-name" className="text-xs text-text-primary">
            {t('forge.templateName')}
          </label>
          <input
            ref={nameInputRef}
            id="forge-save-template-name"
            data-testid="forge-save-template-name"
            type="text"
            value={templateName}
            maxLength={120}
            aria-required="true"
            aria-invalid={nameMissing}
            aria-describedby={nameMissing ? 'forge-save-template-name-error' : undefined}
            onChange={(e) => {
              setTemplateName(e.target.value);
              if (e.target.value.trim()) setNameMissing(false);
            }}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm',
              'bg-[var(--sf-bg-input)] text-[var(--sf-text-input)]',
              'border',
              nameMissing ? 'border-status-error/40' : 'border-[var(--sf-border-input)]',
              'focus:outline-none focus:border-forge/50',
            )}
          />
          {nameMissing && (
            <p
              id="forge-save-template-name-error"
              role="alert"
              data-testid="forge-save-template-name-error"
              className="text-xs text-status-error"
            >
              {t('forge.savedTemplate.nameRequired')}
            </p>
          )}
          <label htmlFor="forge-save-template-desc" className="text-xs text-text-primary">
            {t('forge.templateDescription')}
          </label>
          <input
            id="forge-save-template-desc"
            data-testid="forge-save-template-desc"
            type="text"
            value={templateDescription}
            maxLength={500}
            onChange={(e) => setTemplateDescription(e.target.value)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm',
              'bg-[var(--sf-bg-input)] text-[var(--sf-text-input)]',
              'border border-[var(--sf-border-input)]',
              'focus:outline-none focus:border-forge/50',
            )}
          />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={saver.saving}
              data-testid="forge-save-template-submit"
            >
              {t('common.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSaveOpen(false);
                setNameMissing(false);
                saveButtonRef.current?.focus();
              }}
              data-testid="forge-save-template-cancel"
            >
              {t('forge.cancelEdit')}
            </Button>
          </div>
          {saver.error && (
            <p
              role="alert"
              data-testid="forge-save-template-error"
              className="text-xs text-status-error"
            >
              {t('forge.savedTemplate.saveFailed', { message: saver.error })}
            </p>
          )}
        </form>
      )}
      <p
        role="status"
        data-testid="forge-save-template-saved"
        className="text-xs text-text-primary"
      >
        {saver.saved ? t('forge.savedTemplate.saved', { name: saver.saved.name }) : ''}
      </p>
    </div>
  );
};

/**
 * Marks an Id-map row whose target is a record the target org already held:
 * the map alone reads every row as a record this run created.
 */
const ExistingBadge: React.FC = () => {
  const { t } = useTranslation();
  return (
    <span
      data-testid="forge-id-mapping-existing"
      className="ml-2 inline-block rounded-full bg-surface-2 px-1.5 font-sans text-text-secondary"
    >
      {t('forge.idMapping.existingBadge')}
    </span>
  );
};

/** Stage label colour and i18n key. */
const stageStyles: Record<ForgeExecutionError['stage'], { labelKey: string; cls: string }> = {
  insert: { labelKey: 'forge.stage.insert', cls: 'bg-status-error/10 text-status-error' },
  query: { labelKey: 'forge.stage.query', cls: 'bg-hue-orange/10 text-hue-orange' },
  scope: { labelKey: 'forge.stage.scope', cls: 'bg-status-warning/10 text-status-warning' },
};

/**
 * Structured errors panel — surfaces `ForgeExecutionResult.errors` from the
 * executor, grouped by object and stage, with up to three sample
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
    <m.div
      variants={slideUp}
      initial="hidden"
      animate="visible"
      data-testid="forge-errors-panel"
      // The border marks the panel: a tint here sat under every stage badge's own.
      className="rounded-lg border border-status-error/30"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-status-error/20">
        <AlertTriangle size={16} className="text-status-error" />
        <h3 className="text-sm font-semibold text-text-primary">
          {t('forge.errorsPanel.title', { defaultValue: 'Execution errors' })}
        </h3>
        <span className="text-xs text-text-secondary ml-auto tabular-nums">
          {t('common.objectCount', { count: errors.length })} ·{' '}
          {t('common.recordCount', { count: totals })}
        </span>
      </div>
      <ul className="divide-y divide-status-error/10">
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
                <span
                  className={cn(
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    stage.cls,
                  )}
                >
                  {t(stage.labelKey)}
                </span>
                <span className="ml-auto text-xs text-text-secondary tabular-nums">
                  {err.failedCount}
                  {err.attemptedCount > 0 ? `/${err.attemptedCount}` : ''}
                </span>
              </button>
              {isOpen && err.samples.length > 0 && (
                <div className="mt-2 ml-6 space-y-2 text-xs" data-testid="forge-errors-samples">
                  {err.samples.map((sample, idx) => (
                    <div
                      key={idx}
                      className="rounded border border-status-error/20 bg-surface-1 px-3 py-2"
                    >
                      <div className="font-mono text-text-secondary mb-1 break-all">
                        {sample.recordSummary}
                      </div>
                      <ul className="space-y-2">
                        {sample.messages.map((msg, mi) => {
                          const translated = translateForgeError(msg);
                          return (
                            <li key={mi} className="space-y-1">
                              <div className="text-status-error break-words font-mono">└ {msg}</div>
                              {translated && (
                                <div
                                  data-testid="forge-error-translation"
                                  className={cn(
                                    'ml-4 px-2 py-1 rounded border text-text-primary',
                                    translated.severity === 'error' &&
                                      'border-status-error/30 bg-status-error/5',
                                    translated.severity === 'warning' &&
                                      'border-status-warning/30 bg-status-warning/5',
                                    translated.severity === 'info' &&
                                      'border-status-info/30 bg-status-info/5',
                                  )}
                                >
                                  <div className="flex items-start gap-1.5">
                                    <Lightbulb
                                      size={12}
                                      className="mt-0.5 shrink-0 text-hue-yellow"
                                    />
                                    <div>
                                      <div className="text-text-primary">
                                        {t(translated.explanationKey, translated.vars ?? {})}
                                      </div>
                                      <div className="text-text-primary mt-1 italic">
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
    </m.div>
  );
};
