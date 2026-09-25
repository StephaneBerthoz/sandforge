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
import type {
  ForgeExecuteRequest,
  ForgeExecutionError,
  ForgeGraphNode,
  ForgeNodeStatus,
} from '@sandforge/shared';
import { leftOutAsEmptyTable, objectsBeyondTheGraph } from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
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
import { collator, formatElapsed, formatStoredDate, uiLocale } from '../../utils/formatters';
import { templateFromRun } from './forgeRunConfig';
import { useSaveForgeTemplate } from './useSaveForgeTemplate';
import { ForgeFilesResult } from './ForgeFilesResult';
import { estimatedApiCallsOf } from './forgeApiCalls';

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
  // Stopped by a cancel while it was written: some of its rows may be in the
  // target, never all of them. A warning, as an object skipped is.
  stopped: 'bg-status-warning/10 text-status-warning',
};

/** Props for the ForgeResults component. */
export interface ForgeResultsProps {
  /** Additional CSS classes for the root element. */
  className?: string;
}

/**
 * One row of the per-object table: an object of the graph, or one the run
 * read or wrote beyond it.
 */
interface ObjectRow {
  /** API name of the object. */
  objectApiName: string;
  /** What the run read of it; nothing for an object it did not read. */
  records: number | undefined;
  /** How the run left it. */
  status: ForgeNodeStatus;
  /** What went wrong with it as discovery described or counted it. */
  errors: readonly string[];
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
  const statusesBeyondGraph = useForgeStore((s) => s.statusesBeyondGraph);
  const forgeAgain = useForgeStore((s) => s.forgeAgain);
  const setPhase = useForgeStore((s) => s.setPhase);
  const logs = useForgeStore((s) => s.logs);
  const config = useForgeStore((s) => s.config);
  const anonymizationRules = useForgeStore((s) => s.anonymizationRules);
  const anonymizationPresetId = useForgeStore((s) => s.anonymizationPresetId);
  const runError = useForgeStore((s) => s.runError);
  const addNotification = useNotificationStore((s) => s.addNotification);
  const saver = useSaveForgeTemplate();

  /**
   * Why the run shown stopped, when an error ended it and these are the
   * results of what it had written by then; null for a run that answered.
   */
  const stoppedOn =
    runError?.stoppedRun && result && runError.stoppedRun.forgeId === result.forgeId
      ? runError.message
      : null;

  /**
   * Whether the run shown stopped before its end: an error ended it, or a
   * cancel. Its time is when it stopped, and what it never reached is still
   * to write.
   */
  const stoppedBeforeItsEnd = stoppedOn !== null || result?.cancelled === true;

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

  /**
   * Per object, the rows the run read to clone it; null for a result recorded
   * before the run said what it read.
   */
  const readByObject = useMemo(
    () =>
      result?.readByObject
        ? new Map(result.readByObject.map((r) => [r.objectApiName, r.read]))
        : null,
    [result?.readByObject],
  );

  // What the Records column says of a node: what the run read of it, nothing
  // for an object it did not read. The graph's count is discovery's, of the
  // whole table, which a record-scoped clone reads a few rows of: a clone of
  // one opportunity listed every table it touched in full. A result recorded
  // before the run said what it read still shows those counts, as it did.
  const recordsOf = useCallback(
    (node: ForgeGraphNode): number | undefined =>
      readByObject ? readByObject.get(node.objectApiName) : node.recordCount,
    [readByObject],
  );

  // Records the run set out to write: the ones it read. Counted from the
  // graph, the rate and the "written" line measured a clone of one
  // opportunity between two sandboxes, 272 records read, against the 4 315
  // rows discovery counted in the tables of its graph.
  const plannedRecords = useMemo(() => {
    if (result?.readByObject) return result.readByObject.reduce((sum, r) => sum + r.read, 0);
    return result?.graph.totalRecords ?? nodes.reduce((sum, n) => sum + n.recordCount, 0);
  }, [result, nodes]);

  // A record linked to the one the target already held is in the target, and
  // its children point at it: for the rate, it made it. A run with nothing to
  // write did all it had to, unless it failed outright: then it read nothing
  // because each read it tried failed.
  const successRate = useMemo(() => {
    if (plannedRecords === 0) return result?.status === 'failure' ? 0 : 100;
    return Math.round(((inserted + linked) / plannedRecords) * 100);
  }, [plannedRecords, inserted, linked, result?.status]);

  // Objects whose read failed, which the records read leave out: the rate and
  // the written count are measured without them, and a record-scoped run never
  // learned how many rows its scope held of them. Said nowhere, a run that
  // wrote every record it read and could not read its contacts ended partial
  // and read "100%". Empty for a run recorded before it said which reads failed.
  const failedReads = useMemo(() => result?.failedReads ?? [], [result?.failedReads]);

  /** What the page says of the reads that failed, next to the rate; empty when none did. */
  const readFailedNote =
    failedReads.length > 0 ? t('forge.readFailed', { objects: failedReads.join(', ') }) : '';

  // An object the run could not read makes no rate a success: the rate counts
  // the records read, and the clone is short of that object's.
  const successRateVariant =
    successRate >= 90 && failedReads.length === 0
      ? 'success'
      : successRate >= 50
        ? 'warning'
        : 'error';

  const anonymizedFieldCount = useMemo(
    () => nodes.reduce((sum, n) => sum + n.anonymizeFields.length, 0),
    [nodes],
  );

  /*
   * The calls the run made, as it counted them: its reads, the describes it
   * needed, its writes, the second pass and the files. The card added up
   * discovery's estimates instead — a guess at the writes of whole tables, 0
   * for every object of a starter template — and called it the calls the run
   * consumed. A result that counts none shows the estimate, and says so.
   */
  const apiCalls = result?.apiCalls;
  const estimatedApiCalls = useMemo(() => estimatedApiCallsOf(nodes), [nodes]);

  // Discovery's empty tables are most of a graph — 315 of the 400 objects a
  // clone of one opportunity between two sandboxes reached — and the table
  // listed each, the "Objects skipped" card and the copied report counted
  // them, and the objects left out for a reason worth reading were lost among
  // them. Said in one line, how many, as the clone command says them.
  const emptyTables = useMemo(() => nodes.filter(leftOutAsEmptyTable).length, [nodes]);

  // The objects the table lists: the graph's but its empty tables, and those
  // the run read or wrote beyond it — the catalog beyond the cap, the selling
  // model options, the parent an orphan needed — which are in its counts, its
  // log and its removal and had no row. A run reports their status as it
  // reports a node's; the result says which it could not read.
  const rows = useMemo((): ObjectRow[] => {
    const ofGraph = nodes
      .filter((node) => !leftOutAsEmptyTable(node))
      .map((node) => ({
        objectApiName: node.objectApiName,
        records: recordsOf(node),
        status: node.status,
        errors: node.errors,
      }));
    if (!result) return ofGraph;
    const unread = new Set(result.failedReads ?? []);
    const beyond = objectsBeyondTheGraph(result, nodes).map((objectApiName): ObjectRow => ({
      objectApiName,
      records: readByObject?.get(objectApiName),
      status: statusesBeyondGraph[objectApiName] ?? (unread.has(objectApiName) ? 'error' : 'done'),
      errors: [],
    }));
    return [...ofGraph, ...beyond];
  }, [nodes, result, readByObject, recordsOf, statusesBeyondGraph]);

  // Objects, not records: the run keeps no count of the records of an object
  // it skips, and the count a node carries is discovery's, of its whole table.
  // The card added those up, and a clone of one record read as having skipped
  // every row of each table it left out.
  const skippedObjects = useMemo(() => rows.filter((r) => r.status === 'skipped').length, [rows]);

  /** Whether the run failed an object, of the graph or beyond it: what Retry failed is for. */
  const failedObjects = useMemo(() => rows.some((r) => r.status === 'error'), [rows]);

  /*
   * A run that stopped before its end left objects it never reached, which no
   * row shows failed: the retry was offered only for a failed one, and the
   * rest of a cancelled clone could only be written again from the start.
   */
  const retryable = failedObjects || stoppedBeforeItsEnd;

  /** Sorted and filtered rows for the results table. */
  const sortedFilteredRows = useMemo(() => {
    let filtered = rows;
    if (statusFilter !== 'all') {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }
    // Records and statuses sort as the column shows them: an object the run
    // did not read sorts below one it read none of, and a status by its word,
    // in the panel's language. By its code, "Échoué" sorted where "error" did.
    const valueOf = (row: ObjectRow): string | number =>
      sortField === 'recordCount'
        ? (row.records ?? -1)
        : sortField === 'status'
          ? t(`forge.nodeStatus.${row.status}`)
          : row.objectApiName;
    const { compare } = collator();
    return [...filtered].sort((a, b) => {
      const aVal = valueOf(a);
      const bVal = valueOf(b);
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? compare(aVal, bVal) : compare(bVal, aVal);
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
  }, [rows, statusFilter, sortField, sortDir, t]);

  /** What the page says of the empty tables it does not list; empty when there were none. */
  const emptyTablesNote =
    emptyTables > 0 ? t('forge.emptyTablesLeftOut', { count: emptyTables }) : '';

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
      `- Objects skipped: ${String(skippedObjects)}`,
      `- ID Remaps: ${String(idRemaps)}`,
      `- Success Rate: ${String(successRate)}%`,
      // Next to the rate, as on the page: it counts the records read.
      ...(failedReads.length > 0
        ? [`- Could not be read (not in the rate): ${failedReads.join(', ')}`]
        : []),
      '',
      '## Per-Object Results',
      '',
      '| Object | Records | Status | Errors |',
      '|--------|---------|--------|--------|',
    ];

    // Each status as the run gave it, where the page names it in words: the
    // report is written in English throughout, headings and notes alike.
    for (const row of rows) {
      const errorText = row.errors.length > 0 ? row.errors.join(', ') : '-';
      lines.push(
        `| ${row.objectApiName} | ${String(row.records ?? '-')} | ${row.status} | ${errorText} |`,
      );
    }
    // Under the table, as on the page: the objects it does not list.
    if (emptyTables > 0) {
      lines.push(
        '',
        emptyTables === 1
          ? 'Not listed: 1 object discovery left out because its table is empty in the source.'
          : `Not listed: ${String(emptyTables)} objects discovery left out because their table is empty in the source.`,
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
  }, [
    inserted,
    linked,
    skippedObjects,
    idRemaps,
    successRate,
    failedReads,
    rows,
    emptyTables,
    existingRecords,
  ]);

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

  /*
   * Retry what failed: the clone run again against what this run wrote. The
   * objects that failed need what their rows point at, which this run wrote
   * and a new run would write a second time, and in a clone of one record
   * their rows are only known by reading the clone from its root again. So
   * the extension reads it as this run did, links each row this run wrote to
   * the record it made of it, and writes the others — the objects that
   * failed, those skipped for want of them, and a row refused among rows that
   * went in — filling in the lookups this run had to leave empty at them.
   *
   * The button used to put the failed nodes back to idle and show the
   * execution screen without asking the extension for anything: mission
   * control waited on a run that was never started.
   */
  const handleRetryFailed = useCallback(() => {
    if (!graph || !config || !result) return;
    // A new run, from the statuses up, as Review starts one.
    useForgeStore.getState().resetNodeStatuses();
    const { graph: retried, anonymizationRules, fileCopy } = useForgeStore.getState();
    if (!retried) return;
    // What Review sends, and the run it retries: the extension's history holds
    // what that run wrote.
    const requestId = sendBridgeMessage<ForgeExecuteRequest['payload']>('forge:execute', {
      graph: retried,
      config,
      anonymizationRules,
      ...(fileCopy.enabled
        ? {
            files: {
              maxFileSizeMB: fileCopy.maxFileSizeMB,
              acceptedAsIs: fileCopy.acceptedAsIs,
            },
          }
        : {}),
      retryOf: result.forgeId,
    });
    useForgeStore.getState().setExecutionRequestId(requestId);
    setPhase('execution');
  }, [graph, config, result, setPhase]);

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
        message={[
          // A run an error stopped did not finish: heard as "finished", what
          // it had written read as the whole of it.
          t(stoppedOn === null ? 'a11y.runFinished' : 'a11y.runStoppedWritten', {
            name: t('nav.forge'),
            written: inserted,
            total: plannedRecords,
          }),
          // "Written: N of N" is of the records read: said alone, a run short
          // of an object it could not read was heard as complete.
          readFailedNote,
        ]
          .filter(Boolean)
          .join(' ')}
        immediate
        testId="forge-results-status"
      />
      {/* Above what the run wrote, which is not the whole clone: the error
          that stopped it went with the execution screen. */}
      {stoppedOn !== null && (
        <div
          className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
          data-testid="forge-results-stopped"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-error" />
          <p>{t('forge.runStoppedOn', { message: stoppedOn })}</p>
        </div>
      )}
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
          label={t('forge.objectsSkipped')}
          value={skippedObjects}
          variant="warning"
        />
        <KPICard icon="arrow-swap" label={t('forge.idRemaps')} value={idRemaps} variant="default" />
        <KPICard
          icon="trophy"
          label={t('forge.successRate')}
          value={`${String(successRate)}%`}
          variant={successRateVariant}
        />
        <KPICard
          icon="shield"
          label={t('forge.anonymizedFields')}
          value={anonymizedFieldCount}
          variant="default"
        />
        <KPICard
          icon="zap"
          label={t(apiCalls === undefined ? 'forge.apiCallsEstimated' : 'forge.apiCallsConsumed')}
          value={apiCalls ?? estimatedApiCalls ?? '—'}
          variant="default"
        />
      </m.div>

      {/* Under the rate, which is of the records read: an object whose read
          failed is in none of the figures above, and without this a partial
          run read as a complete one. */}
      {readFailedNote && (
        <div
          className="rounded-sm border border-(--sf-warning) px-4 py-2 text-xs text-status-warning"
          role="status"
          data-testid="forge-results-read-failed"
        >
          {readFailedNote}
        </div>
      )}

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
            {/* When it stopped, for a run that did not complete. */}
            {t(stoppedBeforeItsEnd ? 'forge.executionStoppedAt' : 'forge.executionTimestamp')}:{' '}
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
              'px-2 py-1 rounded-sm text-xs',
              'bg-(--sf-bg-input)',
              'text-(--sf-text-input)',
              'border border-(--sf-border-input)',
            )}
          >
            <option value="all">{t('forge.filterByStatus')}</option>
            <option value="done">{t('forge.done')}</option>
            <option value="error">{t('forge.failed')}</option>
            <option value="skipped">{t('forge.skipped')}</option>
            <option value="stopped">{t('forge.stoppedObjects')}</option>
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
              {sortedFilteredRows.map((row) => (
                <tr
                  key={row.objectApiName}
                  data-testid="forge-results-row"
                  className="border-b border-subtle last:border-b-0"
                >
                  <td className="px-4 py-2 font-mono text-text-primary">{row.objectApiName}</td>
                  <td className="px-4 py-2 tabular-nums text-text-primary">{row.records ?? '-'}</td>
                  <td className="px-4 py-2">
                    {/* In words: the badge printed the code — "done",
                        "error" — in every language. The copied report keeps
                        the code: it is written in English throughout. */}
                    <span
                      data-testid={`forge-results-status-${row.status}`}
                      className={cn(
                        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                        statusBadgeStyles[row.status] ?? 'bg-surface-2 text-text-secondary',
                      )}
                    >
                      {t(`forge.nodeStatus.${row.status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">
                    {row.errors.length > 0 ? row.errors.join(', ') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {emptyTablesNote && (
          <p className="mt-2 text-xs text-text-secondary" data-testid="forge-results-empty-tables">
            {emptyTablesNote}
          </p>
        )}
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
          className="rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary"
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

      {/* Read, a field holding a file's content gives its file's address,
          never the file: the clone left each one empty, and says which. */}
      {result?.fileContentFieldsLeftOut && result.fileContentFieldsLeftOut.length > 0 && (
        <div
          className="rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary"
          role="status"
          data-testid="forge-results-file-content"
        >
          <p>{t('forge.fileContentLeftOut')}</p>
          <ul className="mt-1 space-y-0.5">
            {result.fileContentFieldsLeftOut.map(({ objectApiName, fields }) => (
              <li key={objectApiName} data-testid="forge-results-file-content-row">
                <span className="font-mono text-text-primary">{objectApiName}</span>
                {` — ${fields.join(', ')}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* A read stopped by a bound is not a failure and would otherwise leave
          the wizard showing an unqualified success for a partial clone. */}
      {result?.truncatedObjects && result.truncatedObjects.length > 0 && (
        <div
          className="rounded-sm border border-(--sf-warning) px-4 py-2 text-xs text-status-warning"
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
        {retryable && result && (
          <Button
            variant="secondary"
            size="md"
            icon={<RefreshCw size={14} />}
            onClick={handleRetryFailed}
            aria-describedby="forge-retry-failed-hint"
            data-testid="forge-retry-failed"
          >
            {t(stoppedBeforeItsEnd ? 'forge.retryStopped' : 'forge.retryFailed')}
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
      {/* What the retry writes, and what it does not write twice: a clone run
          again would otherwise be read as writing everything a second time. */}
      {retryable && result && (
        <p
          id="forge-retry-failed-hint"
          className="text-xs text-text-secondary"
          data-testid="forge-retry-failed-hint"
        >
          {t(stoppedBeforeItsEnd ? 'forge.retryStoppedHint' : 'forge.retryFailedHint')}
        </p>
      )}

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
              'bg-(--sf-bg-input) text-(--sf-text-input)',
              'border',
              nameMissing ? 'border-status-error/40' : 'border-(--sf-border-input)',
              'focus:outline-hidden focus:border-forge/50',
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
              'bg-(--sf-bg-input) text-(--sf-text-input)',
              'border border-(--sf-border-input)',
              'focus:outline-hidden focus:border-forge/50',
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
        {errors.map((err, index) => {
          // An object can have two reports at one stage — its rows refused at
          // insert, and the statuses it was not given back — so its name and
          // the stage do not tell the rows apart; their place in the list does.
          const key = `${err.objectApiName}__${err.stage}__${index}`;
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
                      className="rounded-sm border border-status-error/20 bg-surface-1 px-3 py-2"
                    >
                      <div className="font-mono text-text-secondary mb-1 break-all">
                        {sample.recordSummary}
                      </div>
                      <ul className="space-y-2">
                        {sample.messages.map((msg, mi) => {
                          const translated = translateForgeError(msg);
                          return (
                            <li key={mi} className="space-y-1">
                              <div className="text-status-error wrap-break-word font-mono">
                                └ {msg}
                              </div>
                              {translated && (
                                <div
                                  data-testid="forge-error-translation"
                                  className={cn(
                                    'ml-4 px-2 py-1 rounded-sm border text-text-primary',
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
