import React, { useMemo, useCallback, useState } from 'react';
import ReactFlow, { Background, MiniMap, ReactFlowProvider } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import type {
  AutopilotNode as AutopilotNodeType,
  AutopilotEdge as AutopilotEdgeType,
} from '@sandforge/shared';
import { ObjectNode } from './ObjectNode';
import type { ObjectNodeData } from './ObjectNode';
import { RelationEdge } from './RelationEdge';
import type { RelationEdgeData } from './RelationEdge';
import { GraphLegend } from './GraphLegend';
import { GraphControls } from './GraphControls';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

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
 * Convert an AutopilotNode from the store into a ReactFlow Node.
 * Uses a simple level-based layout: Y = level * LEVEL_Y_SPACING, X = index * NODE_X_SPACING.
 */
function toReactFlowNode(
  node: AutopilotNodeType,
  indexInLevel: number,
  selectedNodeName: string | null,
): Node<ObjectNodeData> {
  return {
    id: node.objectApiName,
    type: 'objectNode',
    position: {
      x: indexInLevel * NODE_X_SPACING,
      y: node.level * LEVEL_Y_SPACING,
    },
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
      isSelected: node.objectApiName === selectedNodeName,
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
  const graph = useAutopilotStore((s) => s.graph);
  const selectedNodeName = useAutopilotStore((s) => s.selectedNodeName);
  const selectNode = useAutopilotStore((s) => s.selectNode);
  const [minimapVisible, setMinimapVisible] = useState(true);

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
        result.push(toReactFlowNode(node, idx, selectedNodeName));
      });
    }
    return result;
  }, [graph, selectedNodeName]);

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
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#333" gap={20} />
          {minimapVisible && (
            <MiniMap
              nodeColor={(node) => {
                const status = (node.data as ObjectNodeData | undefined)?.status ?? 'pending';
                const colors: Record<string, string> = {
                  pending: '#6b7280',
                  queued: '#9ca3af',
                  extracting: '#3b82f6',
                  anonymizing: '#a855f7',
                  loading: '#22c55e',
                  completed: '#16a34a',
                  failed: '#ef4444',
                  skipped: '#d1d5db',
                };
                return colors[status] ?? '#6b7280';
              }}
              maskColor="rgba(0,0,0,0.6)"
              className="!bg-[var(--sf-bg-primary)]"
            />
          )}
        </ReactFlow>
        <GraphLegend />
        <GraphControls minimapVisible={minimapVisible} onToggleMinimap={handleToggleMinimap} />
      </div>
    </ReactFlowProvider>
  );
};
