import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlow, MiniMap, Controls, Background } from '@xyflow/react';
import type { Node, Edge, FitViewOptions } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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

/** The minimap's size in pixels, React Flow's own, said here for the room the fit leaves it. */
const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 150;

/** The margin React Flow puts around a panel such as the minimap (`.react-flow__panel`). */
const PANEL_MARGIN = 15;

/**
 * How the graph is fitted to its pane, on first draw and from the controls'
 * fit button: React Flow's own padding on every side but the right, where
 * the strip the minimap stands in is left free, down the pane's whole height.
 * Fitted to the whole pane, the nodes on its right lay under the minimap: at
 * 1280×720 the execution graph's pane is 94 px high, less than the minimap,
 * which covered the contact of an account and its contacts. Left of that
 * strip, no node is under it however high the pane is. A graph too wide to
 * fit at the smallest zoom can still reach it, and is panned to as before.
 */
const FIT_CLEAR_OF_MINIMAP: FitViewOptions = {
  padding: { x: 0.1, y: 0.1, right: `${MINIMAP_WIDTH + 2 * PANEL_MARGIN}px` },
};

/**
 * Find the edge type (master-detail or lookup) for a given node based on
 * the edges pointing to it. Returns 'master-detail' if any incoming edge
 * is master-detail, 'lookup' if only lookups, null if no incoming edges.
 */
function getEdgeTypeForNode(
  objectApiName: string,
  edges: ForgeGraphEdge[],
): 'master-detail' | 'lookup' | null {
  const incomingEdges = edges.filter((e) => e.targetObject === objectApiName);
  if (incomingEdges.length === 0) return null;
  return incomingEdges.some((e) => e.type === 'master-detail') ? 'master-detail' : 'lookup';
}

/**
 * Compute Dagre layout positions based on graph topology.
 * Only depends on node names and edge connections -- NOT on node status/progress.
 */
function computeLayout(graph: ForgeGraph): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (graph.nodes.length === 0) return positions;

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

  for (const node of graph.nodes) {
    const pos = g.node(node.objectApiName);
    positions.set(node.objectApiName, {
      x: pos.x - NODE_WIDTH / 2,
      y: pos.y - NODE_HEIGHT / 2,
    });
  }
  return positions;
}

/**
 * Build React Flow nodes from pre-computed layout positions and current graph data.
 */
function buildFlowNodesFromLayout(
  graph: ForgeGraph,
  positions: Map<string, { x: number; y: number }>,
  onNodeClick?: (objectName: string) => void,
  onIncludeToggle?: (objectName: string) => void,
): Node<ProgressNodeData>[] {
  return graph.nodes.map((n) => {
    const pos = positions.get(n.objectApiName) ?? { x: 0, y: 0 };
    return {
      id: n.objectApiName,
      type: 'progressNode',
      position: pos,
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
export const LiveGraph: React.FC<LiveGraphProps> = ({
  graph,
  onNodeClick,
  onIncludeToggle,
  className,
}) => {
  const { t } = useTranslation();

  /** Stable key that changes only when graph topology changes. */
  const topologyKey = useMemo(() => {
    const nodeNames = graph.nodes
      .map((n) => n.objectApiName)
      .sort()
      .join(',');
    const edgeKeys = graph.edges
      .map((e) => `${e.sourceObject}->${e.targetObject}`)
      .sort()
      .join(',');
    return `${nodeNames}|${edgeKeys}`;
  }, [graph.nodes, graph.edges]);

  // Layout: only recomputes when topology changes (node names + edges)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => computeLayout(graph), [topologyKey]);

  // Nodes: recomputes when graph data changes (status, progress) but uses cached positions
  const nodes = useMemo(
    () => buildFlowNodesFromLayout(graph, positions, onNodeClick, onIncludeToggle),
    [graph, positions, onNodeClick, onIncludeToggle],
  );
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
      role="application"
      aria-label={t('seed.graph.title', 'Dependency Graph')}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleNodeClick}
        // React Flow makes each node's wrapper a focusable "button" around the
        // card, whose own controls then sat inside it: the name and the
        // checkbox are the node's keyboard stops.
        nodesFocusable={false}
        fitView
        fitViewOptions={FIT_CLEAR_OF_MINIMAP}
        proOptions={{ hideAttribution: true }}
      >
        {/* Nodes in the Forge mark as a class: the minimap sets `nodeColor` as a fill
            attribute, which takes no token and which a class rule overrides. */}
        <MiniMap
          style={{
            backgroundColor: 'var(--sf-bg-primary)',
            width: MINIMAP_WIDTH,
            height: MINIMAP_HEIGHT,
          }}
          nodeClassName="fill-hue-forge"
          maskColor="rgba(0,0,0,0.6)"
        />
        <Controls fitViewOptions={FIT_CLEAR_OF_MINIMAP} />
        <Background color="rgba(255,255,255,0.05)" gap={20} />
      </ReactFlow>
    </div>
  );
};
