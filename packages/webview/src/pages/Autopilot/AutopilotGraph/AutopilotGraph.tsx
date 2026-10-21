import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ReactFlow, Background, MiniMap, ReactFlowProvider } from '@xyflow/react';
import type { Dimensions, Node, Edge, FitViewOptions, OnNodesChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  AutopilotNode as AutopilotNodeType,
  AutopilotEdge as AutopilotEdgeType,
} from '@sandforge/shared';
import { ObjectNode } from './ObjectNode';
import type { ObjectNodeData } from './ObjectNode';
import { RelationEdge } from './RelationEdge';
import type { RelationEdgeData } from './RelationEdge';
import { GraphLegend, LEGEND_HEIGHT } from './GraphLegend';
import { GraphControls, CONTROLS_WIDTH } from './GraphControls';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { useNodeSizes } from '../../../components/graph/useNodeSizes';

/** The minimap's height in pixels, React Flow's own, said here for the room the fit leaves it. */
const MINIMAP_HEIGHT = 150;

/** The margin React Flow puts around a panel such as the minimap (`.react-flow__panel`). */
const PANEL_MARGIN = 15;

/** How far the legend and the controls stand from the pane's edges: `bottom-3`, `right-3`. */
const OVERLAY_MARGIN = 12;

/**
 * How the graph is fitted to its pane, on first draw and from the controls'
 * fit button: clear of what the pane draws over it. The minimap and the
 * legend stand along its bottom, the controls at its top right: the fit
 * leaves a strip along the bottom as high as the taller of the two, one down
 * the right as wide as the controls, and its own padding on the other sides.
 * Fitted to the whole pane, the nodes at its bottom lay under them: at
 * 1280×720 the contact of an account and its contacts had a corner under the
 * minimap and one under the legend. Fitted left of a strip as wide as the
 * minimap, as the Forge graph is, the contact still lay under the legend. A
 * graph too big to fit at the smallest zoom can still reach them, and is
 * panned to as before.
 */
const FIT_CLEAR_OF_OVERLAYS: FitViewOptions = {
  padding: {
    x: 0.2,
    y: 0.2,
    bottom: `${Math.max(LEGEND_HEIGHT + 2 * OVERLAY_MARGIN, MINIMAP_HEIGHT + 2 * PANEL_MARGIN)}px`,
    right: `${CONTROLS_WIDTH + 2 * OVERLAY_MARGIN}px`,
  },
};

/** Vertical spacing between graph levels in pixels. */
const LEVEL_Y_SPACING = 150;

/** Horizontal spacing between nodes at the same level in pixels. */
const NODE_X_SPACING = 250;

/** Active node statuses that trigger edge animations. */
const ACTIVE_STATUSES = new Set(['extracting', 'anonymizing', 'loading']);

/** Custom node types registration for ReactFlow. */
const nodeTypes = { objectNode: ObjectNode };

/** Custom edge types registration for ReactFlow. */
const edgeTypes = { relationEdge: RelationEdge };

/**
 * The minimap draws each node in the token its card and the legend use,
 * through `nodeColor`: React Flow writes it as the node's inline `fill`,
 * which takes a `var()`. A `fill-*` class did not reach the node: Tailwind's
 * utilities sit in a cascade layer, and React Flow's own unlayered rule for a
 * minimap node wins over any of them.
 */
const MINIMAP_NODE_FILLS: Record<string, string> = {
  pending: 'var(--color-text-secondary)',
  queued: 'var(--color-text-secondary)',
  extracting: 'var(--color-hue-blue)',
  anonymizing: 'var(--color-hue-purple)',
  loading: 'var(--color-hue-green)',
  completed: 'var(--color-status-success)',
  failed: 'var(--color-status-error)',
  skipped: 'var(--color-text-muted)',
};

/**
 * Convert an AutopilotNode from the store into a ReactFlow Node.
 * Uses a simple level-based layout: Y = level * LEVEL_Y_SPACING, X = index * NODE_X_SPACING.
 */
function toReactFlowNode(
  node: AutopilotNodeType,
  indexInLevel: number,
  selectedNodeName: string | null,
  size: Dimensions | undefined,
  t: TFunction,
): Node<ObjectNodeData> {
  const selected = node.objectApiName === selectedNodeName;
  return {
    id: node.objectApiName,
    type: 'objectNode',
    // React Flow's own selection is the store's: Enter and Space select the
    // focused node through it, and Escape lets it go.
    selected,
    // What a screen reader hears on the node: its card's name, status and
    // counts are drawn, not read. A button that Enter presses, pressed while
    // its details are shown.
    ariaRole: 'button',
    ariaLabel: [
      t('autopilot.graph.nodeLabel', {
        object: node.objectApiName,
        status: t(`autopilot.graph.${node.status}`, { defaultValue: node.status }),
        success: node.successCount,
        total: node.recordCount,
      }),
      node.failureCount > 0 ? t('autopilot.graph.nodeFailed', { count: node.failureCount }) : '',
      node.piiFields.length > 0 ? t('autopilot.graph.piiDetected') : '',
    ]
      .filter(Boolean)
      .join('. '),
    domAttributes: { 'aria-pressed': selected },
    position: {
      x: indexInLevel * NODE_X_SPACING,
      y: node.level * LEVEL_Y_SPACING,
    },
    // The size React Flow measured, handed back: the minimap draws a node
    // only at a size the node itself carries (useNodeSizes).
    ...(size ? { measured: size } : {}),
    data: {
      objectApiName: node.objectApiName,
      recordCount: node.recordCount,
      status: node.status,
      progress: node.progress,
      successCount: node.successCount,
      failureCount: node.failureCount,
      elapsedMs: node.elapsedMs,
      apiCallsUsed: node.apiCallsUsed,
      hasPii: node.piiFields.length > 0,
      isSelected: selected,
    },
  };
}

/**
 * Convert an AutopilotEdge from the store into a ReactFlow Edge.
 * Applies the correct edge type and marks the edge as active when its source node is active.
 */
function toReactFlowEdge(
  edge: AutopilotEdgeType,
  nodes: AutopilotNodeType[],
): Edge<RelationEdgeData> {
  const sourceNode = nodes.find((n) => n.objectApiName === edge.from);
  const isActive = sourceNode ? ACTIVE_STATUSES.has(sourceNode.status) : false;

  return {
    id: `${edge.from}-${edge.fieldApiName}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: 'relationEdge',
    data: {
      relationshipType: edge.relationshipType,
      required: edge.required,
      isActive,
    },
  };
}

/**
 * AutopilotGraph — Main ReactFlow canvas displaying the Salesforce object
 * dependency graph during autopilot execution.
 *
 * Uses a simple level-based layout algorithm:
 * - Y position is determined by node.level (topological depth)
 * - X position spreads nodes evenly within the same level
 *
 * Reads graph data from the autopilot Zustand store.
 */
export const AutopilotGraph: React.FC = () => {
  const { t } = useTranslation();
  const graph = useAutopilotStore((s) => s.graph);
  const selectedNodeName = useAutopilotStore((s) => s.selectedNodeName);
  const selectNode = useAutopilotStore((s) => s.selectNode);
  const [minimapVisible, setMinimapVisible] = useState(true);
  const { sizes, onNodesChange } = useNodeSizes<Node<ObjectNodeData>>();

  /** Convert store nodes to ReactFlow nodes, grouped by level for X positioning. */
  const rfNodes = useMemo<Node<ObjectNodeData>[]>(() => {
    if (!graph) return [];

    const levelMap = new Map<number, AutopilotNodeType[]>();
    for (const node of graph.nodes) {
      const existing = levelMap.get(node.level);
      if (existing) {
        existing.push(node);
      } else {
        levelMap.set(node.level, [node]);
      }
    }

    const result: Node<ObjectNodeData>[] = [];
    for (const [, nodesAtLevel] of levelMap) {
      nodesAtLevel.forEach((node, idx) => {
        result.push(toReactFlowNode(node, idx, selectedNodeName, sizes.get(node.objectApiName), t));
      });
    }
    return result;
  }, [graph, selectedNodeName, sizes, t]);

  /** Convert store edges to ReactFlow edges. */
  const rfEdges = useMemo<Edge<RelationEdgeData>[]>(() => {
    if (!graph) return [];
    return graph.edges.map((edge) => toReactFlowEdge(edge, graph.nodes));
  }, [graph]);

  /** Handle node click to select it in the store. */
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      selectNode(node.id === selectedNodeName ? null : node.id);
    },
    [selectNode, selectedNodeName],
  );

  /*
   * Enter or Space on a focused node selects it through React Flow's own
   * selection, which never calls onNodeClick: the pick arrives as a 'select'
   * change, and the sizes kept for the minimap were all this graph read of
   * those changes. Node detail stayed empty and Skip disabled for anyone
   * without a mouse.
   */
  const handleNodesChange = useCallback<OnNodesChange<Node<ObjectNodeData>>>(
    (changes) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type !== 'select') continue;
        if (change.selected) selectNode(change.id);
        else if (useAutopilotStore.getState().selectedNodeName === change.id) selectNode(null);
      }
    },
    [onNodesChange, selectNode],
  );

  /*
   * React Flow tells each focused node, in English whatever the panel's
   * language, that Delete removes it and the arrows move it: neither does
   * anything here. Said in the panel's language, it says what Enter does.
   */
  const ariaLabelConfig = useMemo(
    () => ({
      'node.a11yDescription.default': t('autopilot.graph.nodeKeys'),
      'node.a11yDescription.keyboardDisabled': t('autopilot.graph.nodeKeys'),
      'minimap.ariaLabel': t('autopilot.graph.minimap'),
    }),
    [t],
  );

  const handleToggleMinimap = useCallback(() => {
    setMinimapVisible((prev) => !prev);
  }, []);

  return (
    <ReactFlowProvider>
      <div data-testid="autopilot-graph" className="relative h-full w-full">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={handleNodeClick}
          onNodesChange={handleNodesChange}
          // A node is not moved, removed nor an edge picked: the graph shows
          // the plan, and its only keyboard action is to open a node.
          nodesDraggable={false}
          deleteKeyCode={null}
          edgesFocusable={false}
          ariaLabelConfig={ariaLabelConfig}
          fitView
          fitViewOptions={FIT_CLEAR_OF_OVERLAYS}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--sf-border)" gap={20} />
          {minimapVisible && (
            // Its background and the mask over what is out of view are the
            // theme's, set on React Flow's own variables in styles/globals.css.
            <MiniMap
              nodeColor={(node) => {
                const status = (node.data as ObjectNodeData | undefined)?.status ?? 'pending';
                return MINIMAP_NODE_FILLS[status] ?? MINIMAP_NODE_FILLS.pending;
              }}
              style={{ height: MINIMAP_HEIGHT }}
            />
          )}
        </ReactFlow>
        <GraphLegend />
        <GraphControls
          minimapVisible={minimapVisible}
          onToggleMinimap={handleToggleMinimap}
          fitViewOptions={FIT_CLEAR_OF_OVERLAYS}
        />
      </div>
    </ReactFlowProvider>
  );
};
