import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import {
  ArrowLeft,
  Play,
  Box,
  Database,
  HardDrive,
  Clock,
  Loader2,
  LayoutGrid,
  List,
  RotateCcw,
  CheckSquare,
  XSquare,
  Search,
  AlertTriangle,
} from 'lucide-react';
import { SplitView } from '../../components/ui/SplitView';
import { LiveGraph } from '../../components/graph/LiveGraph';
import { ForgeNodeDetail } from './ForgeNodeDetail';
import { ForgeTableView } from './ForgeTableView';

import { Button } from '../../components/ui/Button';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeGraphNode, ForgeGraph, ForgeConfig } from '../../stores/useForgeStore';
import type { BaseMessage } from '@sandforge/shared';
import { useMessageListener, useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { slideUp, staggerContainer } from '../../motion/presets';
import { formatSizeMB, formatDurationSec } from '../../utils/formatters';
import { cn } from '../../theme';

/**
 * Main discovery phase component for the Forge wizard.
 *
 * Displays the dependency graph in a SplitView with node details,
 * metadata diff banner (placeholder), stats bar, and navigation buttons.
 */
export const ForgeDiscovery: React.FC = () => {
  const { t } = useTranslation();
  const graph = useForgeStore((s) => s.graph);
  const setGraph = useForgeStore((s) => s.setGraph);
  const setPhase = useForgeStore((s) => s.setPhase);
  const toggleNodeIncluded = useForgeStore((s) => s.toggleNodeIncluded);
  const toggleAnonymizeField = useForgeStore((s) => s.toggleAnonymizeField);

  const config = useForgeStore((s) => s.config);
  const setAllNodesIncluded = useForgeStore((s) => s.setAllNodesIncluded);
  const sendMessage = useSendMessage();

  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null);
  const [loading, setLoading] = useState(!graph);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph');
  const [searchQuery, setSearchQuery] = useState('');
  /** Live counters streamed by the extension during graph discovery. */
  const [discoveryProgress, setDiscoveryProgress] = useState<{
    discoveredCount: number;
    queueRemaining: number;
  } | null>(null);

  /** Listen for graph discovery response from the extension. */
  useMessageListener<BaseMessage & { payload: { graph: ForgeGraph } }>(
    'forge:discover:response',
    useCallback(
      (msg) => {
        // Discovery is fire-and-forget: leaving the phase does not stop the
        // BFS, and the response still lands during the exit animation. Adopting
        // that graph would drop the user back into a phase they walked out of.
        if (useForgeStore.getState().phase !== 'discovery') return;
        setGraph(msg.payload.graph);
        setLoading(false);
        setError(null);
        setDiscoveryProgress(null);
      },
      [setGraph],
    ),
  );

  /** Listen for graph discovery error from the extension. */
  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:discover:error',
    useCallback((msg) => {
      setLoading(false);
      setError(msg.payload.message);
      setDiscoveryProgress(null);
    }, []),
  );

  /**
   * Listen for throttled discovery progress from the extension
   * (ForgeHandler emits `forge:discover:progress` ~10/s during the BFS).
   * Keeps the wizard visibly alive on large orgs instead of a frozen spinner.
   */
  useMessageListener<
    BaseMessage & {
      payload: { objectApiName: string; discoveredCount: number; queueRemaining: number };
    }
  >(
    'forge:discover:progress',
    useCallback((msg) => {
      setDiscoveryProgress({
        discoveredCount: msg.payload.discoveredCount,
        queueRemaining: msg.payload.queueRemaining,
      });
    }, []),
  );

  /** Resolve the selected node from the graph. */
  const selectedNode: ForgeGraphNode | undefined = useMemo(
    () => graph?.nodes.find((n) => n.objectApiName === selectedNodeName),
    [graph, selectedNodeName],
  );

  /** Handle node click in the graph. */
  const handleNodeClick = useCallback((objectName: string) => {
    setSelectedNodeName(objectName);
  }, []);

  /** Navigate back to input phase. */
  const handleBack = useCallback(() => {
    setPhase('input');
  }, [setPhase]);

  /** Advance to review phase. */
  const handleExecute = useCallback(() => {
    setPhase('review');
  }, [setPhase]);

  /** Re-run the same discovery from the stored config. */
  const handleRetry = useCallback(() => {
    if (!config) return;
    setLoading(true);
    setError(null);
    setDiscoveryProgress(null);
    sendMessage(buildMessage<{ config: ForgeConfig }>('forge:discover', { config }));
  }, [config, sendMessage]);

  /** Handle include toggle for the selected node. */
  const handleToggleIncluded = useCallback(() => {
    if (selectedNodeName) {
      toggleNodeIncluded(selectedNodeName);
    }
  }, [selectedNodeName, toggleNodeIncluded]);

  /** Handle anonymize toggle for the selected node. */
  const handleToggleAnonymize = useCallback(
    (fieldName: string) => {
      if (selectedNodeName) {
        toggleAnonymizeField(selectedNodeName, fieldName);
      }
    },
    [selectedNodeName, toggleAnonymizeField],
  );

  /** Auto-select first matching node when searching in graph view. */
  useEffect(() => {
    if (searchQuery && graph && viewMode === 'graph') {
      const match = graph.nodes.find((n) =>
        n.objectApiName.toLowerCase().includes(searchQuery.toLowerCase()),
      );
      if (match) {
        setSelectedNodeName(match.objectApiName);
      }
    }
  }, [searchQuery, graph, viewMode]);

  /** Computed stats from the graph. */
  const stats = useMemo(() => {
    if (!graph) {
      return { objectCount: 0, recordCount: 0, estSize: '0 KB', estDuration: '0s' };
    }
    return {
      objectCount: graph.nodes.filter((n) => n.included).length,
      recordCount: graph.totalRecords,
      estSize: formatSizeMB(graph.estimatedSizeMB),
      estDuration: formatDurationSec(graph.estimatedDurationSeconds),
    };
  }, [graph]);

  // Loading state while waiting for extension response
  if (loading) {
    return (
      <div
        data-testid="forge-discovery-loading"
        className="flex flex-col items-center justify-center gap-4 py-16 text-text-secondary"
      >
        <Loader2 size={32} className="animate-spin text-forge" />
        <p>{t('forge.discovery')}</p>
        {discoveryProgress && (
          <p
            data-testid="forge-discovery-progress"
            className="text-xs tabular-nums text-text-muted"
          >
            {t('forge.discoveryProgress', {
              discovered: discoveryProgress.discoveredCount,
              queued: discoveryProgress.queueRemaining,
            })}
          </p>
        )}
        {/* A BFS over a wide org can run for minutes; without this the spinner
            is the whole screen and the only way out is reloading the window. */}
        <Button
          data-testid="forge-discovery-cancel"
          variant="secondary"
          onClick={handleBack}
          icon={<ArrowLeft size={14} />}
        >
          {t('common.back')}
        </Button>
      </div>
    );
  }

  // Error or no graph (retry discovery)
  if (!graph) {
    return (
      <div
        data-testid="forge-discovery-empty"
        className="flex flex-col items-center justify-center gap-4 py-16 text-text-secondary"
      >
        <p>{error ?? t('common.noData')}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleBack} icon={<ArrowLeft size={14} />}>
            {t('common.back')}
          </Button>
          {error && config && (
            <Button
              variant="primary"
              data-testid="forge-retry-discovery"
              onClick={handleRetry}
              icon={<RotateCcw size={14} />}
            >
              {t('forge.retryDiscovery')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <m.div
      data-testid="forge-discovery"
      className="flex flex-col gap-4 h-full"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* A failed discovery only reached the screen when there was nothing to
          show. Re-discovering from an earlier graph (Back -> Discover, or a
          return from Review) leaves that graph in the store, so `!graph` is
          false and the error had nowhere to render: the user kept reading the
          previous org's graph as if it were the new one, and could execute it.
          Say the run failed, next to the graph it failed to replace. */}
      {error && (
        <m.div
          variants={slideUp}
          role="alert"
          data-testid="forge-discovery-error"
          className="flex items-center gap-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
        >
          <AlertTriangle size={14} className="shrink-0 text-status-error" />
          <span className="flex-1">{error}</span>
          {config && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="forge-discovery-error-retry"
              onClick={handleRetry}
              icon={<RotateCcw size={12} />}
            >
              {t('forge.retryDiscovery')}
            </Button>
          )}
        </m.div>
      )}

      {/* View mode toggle + search input */}
      <m.div variants={slideUp} className="flex items-center gap-2">
        <div className="flex rounded-md border border-subtle overflow-hidden">
          <button
            type="button"
            data-testid="forge-view-graph"
            onClick={() => setViewMode('graph')}
            className={cn(
              'px-2.5 py-1.5 text-xs transition-colors',
              viewMode === 'graph'
                ? 'bg-forge text-white'
                : 'text-text-muted hover:text-text-secondary',
            )}
            aria-pressed={viewMode === 'graph'}
          >
            <LayoutGrid size={14} className="inline mr-1" />
            {t('forge.graphView')}
          </button>
          <button
            type="button"
            data-testid="forge-view-table"
            onClick={() => setViewMode('table')}
            className={cn(
              'px-2.5 py-1.5 text-xs transition-colors',
              viewMode === 'table'
                ? 'bg-forge text-white'
                : 'text-text-muted hover:text-text-secondary',
            )}
            aria-pressed={viewMode === 'table'}
          >
            <List size={14} className="inline mr-1" />
            {t('forge.tableView')}
          </button>
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            data-testid="forge-node-search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('forge.searchNodes')}
            className={cn(
              'w-full pl-8 pr-3 py-1.5 rounded-md text-xs',
              'bg-[var(--sf-bg-input)]',
              'text-[var(--sf-text-input)]',
              'border border-[var(--sf-border-input)]',
              'focus:outline-none focus:border-forge/50',
            )}
          />
        </div>
      </m.div>

      {/* Split view: graph/table + detail */}
      <m.div variants={slideUp} className="flex-1 min-h-0 min-h-[350px]">
        <SplitView
          ratio="60/40"
          left={
            viewMode === 'graph' ? (
              <LiveGraph graph={graph} onNodeClick={handleNodeClick} className="h-full" />
            ) : (
              <ForgeTableView
                graph={graph}
                selectedNodeName={selectedNodeName}
                onNodeClick={handleNodeClick}
                onToggleIncluded={(name) => toggleNodeIncluded(name)}
                searchQuery={searchQuery}
                className="h-full overflow-auto"
              />
            )
          }
          right={
            selectedNode ? (
              <ForgeNodeDetail
                node={selectedNode}
                onToggleIncluded={handleToggleIncluded}
                onToggleAnonymize={handleToggleAnonymize}
              />
            ) : (
              <div
                data-testid="forge-select-node-empty"
                className="flex h-full items-center justify-center p-4 text-sm text-text-secondary"
              >
                {t('forge.selectNode')}
              </div>
            )
          }
        />
      </m.div>

      {/* Stats bar */}
      <m.div
        variants={slideUp}
        data-testid="forge-stats-bar"
        className="flex items-center gap-6 rounded-lg border border-subtle bg-surface-1 px-4 py-3"
      >
        <div className="flex items-center gap-1.5 text-sm">
          <Box size={14} className="text-text-secondary" />
          <span className="text-text-secondary">{t('forge.objects')}:</span>
          <span className="font-medium text-text-primary" data-testid="stat-objects">
            {stats.objectCount}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <Database size={14} className="text-text-secondary" />
          <span className="text-text-secondary">{t('forge.records')}:</span>
          <span className="font-medium text-text-primary" data-testid="stat-records">
            {stats.recordCount}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <HardDrive size={14} className="text-text-secondary" />
          <span className="text-text-secondary">{t('forge.estSize')}:</span>
          <span className="font-medium text-text-primary" data-testid="stat-size">
            {stats.estSize}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <Clock size={14} className="text-text-secondary" />
          <span className="text-text-secondary">{t('forge.estDuration')}:</span>
          <span className="font-medium text-text-primary" data-testid="stat-duration">
            {stats.estDuration}
          </span>
        </div>
      </m.div>

      {/* Action bar */}
      <m.div variants={slideUp} className="flex items-center justify-between">
        <Button
          data-testid="forge-back-btn"
          variant="ghost"
          onClick={handleBack}
          icon={<ArrowLeft size={14} />}
        >
          {t('common.back')}
        </Button>
        {/* Select All / Deselect All */}
        <div className="flex items-center gap-2">
          <Button
            data-testid="forge-select-all"
            variant="ghost"
            size="sm"
            onClick={() => setAllNodesIncluded(true)}
            icon={<CheckSquare size={14} />}
          >
            {t('forge.selectAll')}
          </Button>
          <Button
            data-testid="forge-deselect-all"
            variant="ghost"
            size="sm"
            onClick={() => setAllNodesIncluded(false)}
            icon={<XSquare size={14} />}
          >
            {t('forge.deselectAll')}
          </Button>
        </div>
        <Button
          data-testid="forge-execute-btn"
          variant="primary"
          onClick={handleExecute}
          icon={<Play size={14} />}
        >
          {t('forge.reviewAndExecute')}
        </Button>
      </m.div>
    </m.div>
  );
};
