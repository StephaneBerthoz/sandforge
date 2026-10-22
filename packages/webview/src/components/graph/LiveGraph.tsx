import React, { useEffect, useMemo, useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlow, MiniMap, Controls, Background, useReactFlow, useStoreApi } from '@xyflow/react';
import type { Dimensions, Node, Edge, FitViewOptions } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { ForgeGraph, ForgeGraphEdge } from '@sandforge/shared';
import { ProgressNode } from './ProgressNode';
import type { ProgressNodeData } from './ProgressNode';
import { AnimatedEdge } from './AnimatedEdge';
import type { AnimatedEdgeData } from './AnimatedEdge';
import { cn } from '../../theme';
import { useNodeSizes } from './useNodeSizes';

/** Props for the LiveGraph wrapper component. */
export interface LiveGraphProps {
  /** Complete Forge dependency graph to visualise. */
  graph: ForgeGraph;
  /** Callback when a node is clicked. */
  onNodeClick?: (objectName: string) => void;
  /** Callback when a node's include checkbox is toggled. */
  onIncludeToggle?: (objectName: string) => void;
  /** The objects a search matched, marked on their node. */
  highlighted?: ReadonlySet<string>;
  /** The object to bring into view, when one was asked for. */
  focus?: string | null;
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
  sizes: ReadonlyMap<string, Dimensions>,
  onNodeClick?: (objectName: string) => void,
  onIncludeToggle?: (objectName: string) => void,
  highlighted?: ReadonlySet<string>,
): Node<ProgressNodeData>[] {
  return graph.nodes.map((n) => {
    const pos = positions.get(n.objectApiName) ?? { x: 0, y: 0 };
    const size = sizes.get(n.objectApiName);
    return {
      id: n.objectApiName,
      type: 'progressNode',
      position: pos,
      // The size React Flow measured, handed back: the minimap draws a node
      // only at a size the node itself carries (useNodeSizes).
      ...(size ? { measured: size } : {}),
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
        highlighted: highlighted?.has(n.objectApiName) === true,
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
 * Fits the view on one node, each time another is asked for: rendered inside
 * React Flow, whose instance it reaches.
 */
const FitOnNode: React.FC<{ id: string }> = ({ id }) => {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.2 });
  }, [fitView, id]);
  return null;
};

/** A node's box on the graph's plane, and the pane's view of that plane. */
interface PlaneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where to centre the view so that a node lying wholly or partly outside the
 * pane comes into it, at the zoom it is drawn at; null when it is in view.
 *
 * @param transform - React Flow's `[x, y, zoom]` of the pane.
 */
export function centreToShow(
  node: PlaneBox,
  transform: readonly [number, number, number],
  pane: { width: number; height: number },
): { x: number; y: number } | null {
  const [tx, ty, zoom] = transform;
  const left = node.x * zoom + tx;
  const top = node.y * zoom + ty;
  const inView =
    left >= 0 &&
    top >= 0 &&
    left + node.width * zoom <= pane.width &&
    top + node.height * zoom <= pane.height;
  return inView ? null : { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * Brings into view the node a keyboard focus lands in. The node's name and
 * its checkbox are the graph's keyboard stops, not the node itself, and React
 * Flow pans only to a node that takes the focus itself; it also undoes the
 * scroll a browser makes to show what took the focus. A stop in a node out of
 * the pane — a wide graph at its smallest zoom, or zoomed in — took the focus
 * with nothing shown. Rendered inside React Flow, whose store it reads.
 */
const PanToFocusedNode: React.FC<{ container: RefObject<HTMLDivElement | null> }> = ({
  container,
}) => {
  const store = useStoreApi();
  const { setCenter } = useReactFlow();
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      // A click focuses the checkbox too: the view moves for the keyboard only.
      if (!(target instanceof HTMLElement) || !target.matches(':focus-visible')) return;
      const id = target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      const { nodeLookup, transform, width, height } = store.getState();
      const node = id === undefined ? undefined : nodeLookup.get(id);
      if (!node) return;
      const centre = centreToShow(
        {
          x: node.internals.positionAbsolute.x,
          y: node.internals.positionAbsolute.y,
          width: node.measured.width ?? NODE_WIDTH,
          height: node.measured.height ?? NODE_HEIGHT,
        },
        transform,
        { width, height },
      );
      if (centre) void setCenter(centre.x, centre.y, { zoom: transform[2] });
    };
    element.addEventListener('focusin', onFocusIn);
    return () => element.removeEventListener('focusin', onFocusIn);
  }, [container, store, setCenter]);
  return null;
};

/**
 * Wrapper component that converts a ForgeGraph into an interactive
 * React Flow visualisation with custom nodes, animated edges,
 * minimap, controls, and auto-layout.
 */
export const LiveGraph: React.FC<LiveGraphProps> = ({
  graph,
  onNodeClick,
  onIncludeToggle,
  highlighted,
  focus,
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
  const { sizes, onNodesChange } = useNodeSizes<Node<ProgressNodeData>>();
  const nodes = useMemo(
    () =>
      buildFlowNodesFromLayout(graph, positions, sizes, onNodeClick, onIncludeToggle, highlighted),
    [graph, positions, sizes, onNodeClick, onIncludeToggle, highlighted],
  );
  const edges = useMemo(() => buildFlowEdges(graph), [graph]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<ProgressNodeData>) => {
      onNodeClick?.(node.data.objectApiName);
    },
    [onNodeClick],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} data-testid="live-graph" className={cn('h-full w-full', className)}>
      {/* React Flow's own wrapper is the graph's one application, named here:
          a second one around it, named the same, was read twice. */}
      <ReactFlow
        aria-label={t('forgeRun.graph.title', 'Dependency Graph')}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleNodeClick}
        onNodesChange={onNodesChange}
        // React Flow makes each node's wrapper a focusable "button" around the
        // card, whose own controls then sat inside it: the name and the
        // checkbox are the node's keyboard stops.
        nodesFocusable={false}
        // An edge does nothing when it is picked: each one was a Tab stop
        // told, in English, that Delete removed it.
        edgesFocusable={false}
        fitView
        fitViewOptions={FIT_CLEAR_OF_MINIMAP}
        proOptions={{ hideAttribution: true }}
      >
        {/* Its colours and those of the controls are the theme's, set on React
            Flow's own variables in styles/globals.css: a colour given here as
            a prop would take precedence over them. */}
        <MiniMap style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }} />
        <Controls fitViewOptions={FIT_CLEAR_OF_MINIMAP} />
        {focus ? <FitOnNode id={focus} /> : null}
        <PanToFocusedNode container={containerRef} />
        {/* Its dots in the theme's border colour, as the Autopilot graph draws
            its own: a white at 5% was drawn on a white pane in a light theme,
            and the grid was gone. */}
        <Background color="var(--sf-border)" gap={20} />
      </ReactFlow>
    </div>
  );
};
