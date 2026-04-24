import React, { useMemo } from 'react';
import { getBezierPath } from 'reactflow';
import type { EdgeProps } from 'reactflow';

/** Data payload for the RelationEdge custom ReactFlow edge. */
export interface RelationEdgeData {
  /** Type of Salesforce relationship */
  relationshipType: 'lookup' | 'master_detail' | 'hierarchical' | 'polymorphic';
  /** Whether the relationship field is required */
  required: boolean;
  /** Whether the parent node is currently active (extracting/loading/anonymizing) */
  isActive: boolean;
}

/** Unique marker ID for the polymorphic diamond end marker. */
const DIAMOND_MARKER_ID = 'sf-diamond-marker';

/**
 * SVG diamond marker definition for polymorphic relationships.
 * Rendered once as a <defs> element and referenced via marker-end.
 */
const DiamondMarkerDef: React.FC = () => (
  <defs>
    <marker
      id={DIAMOND_MARKER_ID}
      viewBox="0 0 12 12"
      refX={6}
      refY={6}
      markerWidth={12}
      markerHeight={12}
      orient="auto-start-reverse"
    >
      <path d="M6 0 L12 6 L6 12 L0 6 Z" fill="#a78bfa" />
    </marker>
  </defs>
);

/**
 * Compute edge style properties based on relationship type.
 * - master_detail: solid thick line (orange)
 * - lookup: dashed line (blue)
 * - hierarchical: curved dotted line (cyan)
 * - polymorphic: solid line with diamond marker (purple)
 */
function getEdgeStyle(
  relationshipType: string,
  isActive: boolean,
): { strokeDasharray?: string; strokeWidth: number; stroke: string; markerEnd?: string } {
  const base = {
    strokeWidth: 2,
    stroke: '#6b7280',
    strokeDasharray: undefined as string | undefined,
    markerEnd: undefined as string | undefined,
  };

  switch (relationshipType) {
    case 'master_detail':
      base.stroke = '#f59e0b';
      base.strokeWidth = 3;
      break;
    case 'lookup':
      base.stroke = '#3b82f6';
      base.strokeDasharray = '6 4';
      break;
    case 'hierarchical':
      base.stroke = '#06b6d4';
      base.strokeDasharray = '2 4';
      break;
    case 'polymorphic':
      base.stroke = '#a78bfa';
      base.markerEnd = `url(#${DIAMOND_MARKER_ID})`;
      break;
  }

  if (isActive) {
    base.strokeDasharray = base.strokeDasharray ?? '8 4';
  }

  return base;
}

/**
 * RelationEdge — Custom ReactFlow edge representing a Salesforce
 * relationship between two objects.
 *
 * Visual style varies by relationship type:
 * - master_detail: solid thick orange line
 * - lookup: dashed blue line
 * - hierarchical: dotted cyan line
 * - polymorphic: solid purple line with diamond marker
 *
 * Active edges (parent node processing) get an animated dash stroke.
 */
export const RelationEdge: React.FC<EdgeProps<RelationEdgeData>> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}) => {
  const relType = data?.relationshipType ?? 'lookup';
  const isActive = data?.isActive ?? false;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const style = useMemo(() => getEdgeStyle(relType, isActive), [relType, isActive]);

  return (
    <g data-testid="relation-edge">
      <DiamondMarkerDef />
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.strokeDasharray}
        markerEnd={style.markerEnd}
        className={isActive ? 'animate-[dash_1s_linear_infinite]' : ''}
      />
    </g>
  );
};
