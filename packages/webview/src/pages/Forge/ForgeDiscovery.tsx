import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ArrowLeft, Play, Box, Database, HardDrive, Clock, Loader2 } from 'lucide-react';
import { SplitView } from '../../components/ui/SplitView';
import { LiveGraph } from '../../components/graph/LiveGraph';
import { ForgeNodeDetail } from './ForgeNodeDetail';
import { MetadataDiffBanner } from './MetadataDiffBanner';
import { Button } from '../../components/ui/Button';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeGraphNode, ForgeGraph } from '../../stores/useForgeStore';
import type { BaseMessage } from '@sandforge/shared';
import { useMessageListener } from '../../hooks/useMessageBus';
import { slideUp, staggerContainer } from '../../motion/presets';
import { formatSizeMB, formatDurationSec } from '../../utils/formatters';

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

  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null);
  const [loading, setLoading] = useState(!graph);
  const [error, setError] = useState<string | null>(null);

  /** Listen for graph discovery response from the extension. */
  useMessageListener<BaseMessage & { payload: { graph: ForgeGraph } }>(
    'forge:discover:response',
    useCallback((msg) => {
      setGraph(msg.payload.graph);
      setLoading(false);
      setError(null);
    }, [setGraph]),
  );

  /** Listen for graph discovery error from the extension. */
  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:discover:error',
    useCallback((msg) => {
      setLoading(false);
      setError(msg.payload.message);
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
      </div>
    );
  }

  // Error or no graph
  if (!graph) {
    return (
      <div
        data-testid="forge-discovery-empty"
        className="flex flex-col items-center justify-center gap-4 py-16 text-text-secondary"
      >
        <p>{error ?? t('common.noData')}</p>
        <Button variant="secondary" onClick={handleBack} icon={<ArrowLeft size={14} />}>
          {t('common.back')}
        </Button>
      </div>
    );
  }

  return (
    <motion.div
      data-testid="forge-discovery"
      className="flex flex-col gap-4"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* Metadata diff banner — placeholder, always hidden for now */}
      <MetadataDiffBanner diffs={[]} />

      {/* Split view: graph + detail */}
      <motion.div variants={slideUp} className="h-[480px]">
        <SplitView
          ratio="60/40"
          left={
            <LiveGraph
              graph={graph}
              onNodeClick={handleNodeClick}
              className="h-full"
            />
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
      </motion.div>

      {/* Stats bar */}
      <motion.div
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
      </motion.div>

      {/* Action bar */}
      <motion.div variants={slideUp} className="flex items-center justify-between">
        <Button
          data-testid="forge-back-btn"
          variant="ghost"
          onClick={handleBack}
          icon={<ArrowLeft size={14} />}
        >
          {t('common.back')}
        </Button>
        <Button
          data-testid="forge-execute-btn"
          variant="primary"
          onClick={handleExecute}
          icon={<Play size={14} />}
        >
          {t('forge.executeForge')}
        </Button>
      </motion.div>
    </motion.div>
  );
};
