import React, { useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ObjectNode, ERDEdge } from '@sandforge/shared';

/** Props for ERDMiniMap component. */
export interface ERDMiniMapProps {
  nodes: ObjectNode[];
  edges: ERDEdge[];
  insertionOrder: string[];
  selectedObjects: string[];
  onObjectClick: (apiName: string) => void;
  circularDeps?: string[][];
}

/** Layout constants for the ERD graph. */
const NODE_W = 160;
const NODE_H = 56;
const H_GAP = 40;
const V_GAP = 32;
const PAD = 20;

/** Compute node positions based on topological levels. */
function computeLayout(
  nodes: ObjectNode[],
  edges: ERDEdge[],
  insertionOrder: string[],
): Map<string, { x: number; y: number; level: number }> {
  const positions = new Map<string, { x: number; y: number; level: number }>();

  // Compute level for each node based on dependency depth
  const levels = new Map<string, number>();
  const nodeSet = new Set(nodes.map((n) => n.apiName));

  // Build parent map (source depends on target → target is parent)
  const parents = new Map<string, string[]>();
  for (const node of nodes) {
    parents.set(node.apiName, []);
  }
  for (const edge of edges) {
    if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) {
      const existing = parents.get(edge.source) ?? [];
      existing.push(edge.target);
      parents.set(edge.source, existing);
    }
  }

  // Compute levels using insertion order
  for (const name of insertionOrder) {
    const parentNames = parents.get(name) ?? [];
    const parentLevels = parentNames
      .map((p) => levels.get(p) ?? 0)
      .filter((l) => l >= 0);
    const level = parentLevels.length > 0 ? Math.max(...parentLevels) + 1 : 0;
    levels.set(name, level);
  }

  // Group nodes by level
  const levelGroups = new Map<number, string[]>();
  for (const [name, level] of levels) {
    const group = levelGroups.get(level) ?? [];
    group.push(name);
    levelGroups.set(level, group);
  }

  // Position nodes
  const sortedLevels = [...levelGroups.keys()].sort((a, b) => a - b);
  for (const level of sortedLevels) {
    const group = levelGroups.get(level) ?? [];
    for (let i = 0; i < group.length; i++) {
      positions.set(group[i], {
        x: PAD + i * (NODE_W + H_GAP),
        y: PAD + level * (NODE_H + V_GAP),
        level,
      });
    }
  }

  return positions;
}

/**
 * ERD Mini-Map: pure SVG visualization of object relationships.
 * Shows objects as rectangles with arrows for Lookup/MasterDetail relationships.
 */
export const ERDMiniMap: React.FC<ERDMiniMapProps> = ({
  nodes,
  edges,
  insertionOrder,
  selectedObjects,
  onObjectClick,
  circularDeps = [],
}) => {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const positions = useMemo(
    () => computeLayout(nodes, edges, insertionOrder),
    [nodes, edges, insertionOrder],
  );

  const circularSet = useMemo(
    () => new Set(circularDeps.flat()),
    [circularDeps],
  );

  const orderMap = useMemo(() => {
    const map = new Map<string, number>();
    insertionOrder.forEach((name, i) => map.set(name, i + 1));
    return map;
  }, [insertionOrder]);

  // Compute SVG viewBox size
  const { svgWidth, svgHeight } = useMemo(() => {
    let maxX = 400;
    let maxY = 200;
    for (const pos of positions.values()) {
      maxX = Math.max(maxX, pos.x + NODE_W + PAD);
      maxY = Math.max(maxY, pos.y + NODE_H + PAD);
    }
    return { svgWidth: maxX, svgHeight: maxY };
  }, [positions]);

  /** Mouse wheel zoom. */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform((prev) => ({
      ...prev,
      scale: Math.max(0.3, Math.min(2, prev.scale * delta)),
    }));
  }, []);

  /** Mouse down for pan. */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  }, [transform.x, transform.y]);

  /** Mouse move for pan. */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      setTransform((prev) => ({
        ...prev,
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      }));
    },
    [dragging],
  );

  /** Mouse up stops pan. */
  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  if (nodes.length === 0) {
    return (
      <div
        data-testid="erd-minimap-empty"
        className="text-xs text-center py-8"
        style={{ color: 'var(--sf-text-muted)' }}
      >
        {t('seed.noObjectsSelected', 'No objects selected')}
      </div>
    );
  }

  return (
    <div data-testid="erd-minimap" style={{ overflow: 'hidden', border: '1px solid var(--sf-border)', borderRadius: 'var(--sf-radius-md)' }}>
      <svg
        ref={svgRef}
        width="100%"
        height={Math.min(svgHeight * transform.scale + 40, 400)}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        data-testid="erd-svg"
      >
        <defs>
          <marker id="arrow-lookup" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="var(--sf-info, #3B82F6)" />
          </marker>
          <marker id="arrow-master" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="var(--sf-error, #EF4444)" />
          </marker>
        </defs>

        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          {/* Edges */}
          {edges.map((edge, i) => {
            const from = positions.get(edge.source);
            const to = positions.get(edge.target);
            if (!from || !to) return null;

            const x1 = from.x + NODE_W / 2;
            const y1 = from.y;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y + NODE_H;
            const isMaster = edge.type === 'MasterDetail';

            return (
              <line
                key={`edge-${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={isMaster ? 'var(--sf-error, #EF4444)' : 'var(--sf-info, #3B82F6)'}
                strokeWidth={isMaster ? 2.5 : 1.5}
                strokeDasharray={isMaster ? undefined : '6 3'}
                markerEnd={isMaster ? 'url(#arrow-master)' : 'url(#arrow-lookup)'}
                data-testid={`edge-${edge.source}-${edge.target}`}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const pos = positions.get(node.apiName);
            if (!pos) return null;

            const isSelected = selectedObjects.includes(node.apiName);
            const isCircular = circularSet.has(node.apiName);
            const order = orderMap.get(node.apiName);

            return (
              <g
                key={node.apiName}
                data-testid={`erd-node-${node.apiName}`}
                onClick={() => onObjectClick(node.apiName)}
                style={{ cursor: 'pointer' }}
              >
                {/* Node rectangle */}
                <rect
                  x={pos.x}
                  y={pos.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={isSelected ? 'var(--sf-bg-active, #1a3a5c)' : 'var(--sf-bg-card, #252526)'}
                  stroke={
                    isCircular
                      ? 'var(--sf-error, #EF4444)'
                      : isSelected
                        ? 'var(--sf-info, #3B82F6)'
                        : 'var(--sf-border, #3c3c3c)'
                  }
                  strokeWidth={isCircular ? 2 : 1.5}
                />

                {/* Object name */}
                <text
                  x={pos.x + 12}
                  y={pos.y + 20}
                  fill="var(--sf-text-primary, #d4d4d4)"
                  fontSize="11"
                  fontWeight="600"
                  fontFamily="var(--vscode-font-family)"
                >
                  {node.label.length > 18 ? `${node.label.slice(0, 16)}..` : node.label}
                </text>

                {/* Record count */}
                <text
                  x={pos.x + 12}
                  y={pos.y + 38}
                  fill="var(--sf-text-muted, #868686)"
                  fontSize="10"
                  fontFamily="var(--vscode-font-family)"
                >
                  {node.recordCount.toLocaleString()} {t('seed.records', 'records')}
                </text>

                {/* Order badge */}
                {order !== undefined && (
                  <>
                    <circle
                      cx={pos.x + NODE_W - 14}
                      cy={pos.y + 14}
                      r={10}
                      fill={isSelected ? 'var(--sf-info, #3B82F6)' : 'var(--sf-text-muted, #868686)'}
                    />
                    <text
                      x={pos.x + NODE_W - 14}
                      y={pos.y + 18}
                      fill="white"
                      fontSize="9"
                      fontWeight="700"
                      textAnchor="middle"
                      fontFamily="var(--vscode-font-family)"
                    >
                      {order}
                    </text>
                  </>
                )}

                {/* Auto-added indicator */}
                {!isSelected && (
                  <text
                    x={pos.x + NODE_W - 14}
                    y={pos.y + NODE_H - 6}
                    fill="var(--sf-warning, #F59E0B)"
                    fontSize="8"
                    textAnchor="middle"
                    fontFamily="var(--vscode-font-family)"
                  >
                    {t('seed.autoAdded', 'auto')}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};
