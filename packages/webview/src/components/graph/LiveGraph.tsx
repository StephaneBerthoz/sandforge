import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, { MiniMap, Controls, Background } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { ForgeGraph, ForgeGraphEdge } from '@sandforge/shared';
import { ProgressNode } from './ProgressNode';
import type { ProgressNodeData } from './ProgressNode';
import { AnimatedEdge } from './AnimatedEdge';
import type { AnimatedEdgeData } from './AnimatedEdge';
import { cn } from '../../theme';

/** Props for the LiveGraph wrapper component. */
export interface LiveGraphProps {
  /** Complete Forge dependency graph to visualise. */
  graph: ForgeGraph;
  /** Callback when a node is clicked. */
  onNodeClick?: (objectName: string) => void;
  /** Callback when a node's include checkbox is toggled. */
  onIncludeToggle?: (objectName: string) => void;
  /** Additional CSS class for the container. */
  className?: string;
}

/** Custom node types registered with React Flow. */
const nodeTypes = { progressNode: ProgressNode };

/** Custom edge types registered with React Flow. */
const edgeTypes = { animatedEdge: AnimatedEdge };

/** Node width in pixels for Dagre layout. */
const NODE_WIDTH = 220;

/** Node height in pixels for Dagre layout. */
const NODE_HEIGHT = 140;

/**
 * Find the edge type (master-detail or lookup) for a given node based on
 * the edges pointing to it. Returns 'master-detail' if any incoming edge
 * is master-detail, 'lookup' if only lookups, null if no incoming edges.
 */
function getEdgeTypeForNode(objectApiName: string, edges: ForgeGraphEdge[]): 'master-detail' | 'lookup' | null {
  const incomingEdges = edges.filter((e) => e.targetObject === objectApiName);
  if (incomingEdges.length === 0) return null;
  return incomingEdges.some((e) => e.type === 'master-detail') ? 'master-detail' : 'lookup';
}

/**
 * Compute Dagre layout for graph nodes and edges.
 * Uses vertical top-down (TB) layout with automatic positioning.
 */
function buildFlowNodes(
  graph: ForgeGraph,
  onNodeClick?: (objectName: string) => void,
  onIncludeToggle?: (objectName: string) => void,
): Node<ProgressNodeData>[] {
  if (graph.nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 120 });

  for (const node of graph.nodes) {
    g.setNode(node.objectApiName, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.sourceObject, edge.targetObject);
  }

  dagre.layout(g);

  return graph.nodes.map((n) => {
    const pos = g.node(n.objectApiName);
    return {
      id: n.objectApiName,
      type: 'progressNode',
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
      data: {
        objectApiName: n.objectApiName,
        recordCount: n.recordCount,
        fieldCount: n.fieldCount,
        createableFieldCount: n.createableFieldCount,
        estimatedSizeMB: n.estimatedSizeMB,
        status: n.status,
        progress: n.progress,
        included: n.included,
        hasPII: n.piiFields.length > 0,
        piiCount: n.piiFields.length,
        errorCount: n.errors.length,
        edgeType: getEdgeTypeForNode(n.objectApiName, graph.edges),
        onSelect: onNodeClick,
        onIncludeToggle,
      },
    };
  });
}

/**
 * Convert ForgeGraph edges into React Flow Edges with AnimatedEdge type.
 */
function buildFlowEdges(graph: ForgeGraph): Edge<AnimatedEdgeData>[] {
  return graph.edges.map((e, idx) => ({
    id: `edge-${e.sourceObject}-${e.targetObject}-${idx}`,
    source: e.sourceObject,
    target: e.targetObject,
    type: 'animatedEdge',
    data: {
      relationshipType: e.type,
      relationshipName: e.relationshipName,
    },
  }));
}

/**
 * Wrapper component that converts a ForgeGraph into an interactive
 * React Flow visualisation with custom nodes, animated edges,
 * minimap, controls, and auto-layout.
 */
export const LiveGraph: React.FC<LiveGraphProps> = ({ graph, onNodeClick, onIncludeToggle, className }) => {
  const { t } = useTranslation();
  const nodes = useMemo(() => buildFlowNodes(graph, onNodeClick, onIncludeToggle), [graph, onNodeClick, onIncludeToggle]);
  const edges = useMemo(() => buildFlowEdges(graph), [graph]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<ProgressNodeData>) => {
      onNodeClick?.(node.data.objectApiName);
    },
    [onNodeClick],
  );

  return (
    <div
      data-testid="live-graph"
      className={cn('h-full w-full', className)}
      role="img"
      aria-label={t('seed.graph.title', 'Dependency Graph')}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleNodeClick}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap
          style={{ backgroundColor: '#0A0A0F' }}
          nodeColor="#F97316"
          maskColor="rgba(0,0,0,0.6)"
        />
        <Controls />
        <Background color="rgba(255,255,255,0.05)" gap={20} />
      </ReactFlow>
    </div>
  );
};
