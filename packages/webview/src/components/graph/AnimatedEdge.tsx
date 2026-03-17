import React from 'react';
import { getBezierPath } from 'reactflow';
import type { EdgeProps } from 'reactflow';

/** Data payload carried by an AnimatedEdge in the React Flow graph. */
export interface AnimatedEdgeData {
  /** Salesforce relationship type. */
  relationshipType: 'master-detail' | 'lookup';
  /** Display name of the relationship. */
  relationshipName: string;
}

/** CSS keyframe id for the dash-offset animation. */
const EDGE_ANIMATION_NAME = 'sf-edge-dash';

/**
 * Inline style tag content for the dash animation.
 * Injected once alongside the edge SVG so the animation works
 * without any external stylesheet dependency.
 */
const animationStyle = `
@keyframes ${EDGE_ANIMATION_NAME} {
  to { stroke-dashoffset: -20; }
}
`;

/**
 * Custom React Flow edge with animated dash for active relationships.
 *
 * - Master-detail edges are rendered as solid, thicker lines (strokeWidth 2).
 * - Lookup edges are rendered as dashed, thinner lines (strokeWidth 1).
 * - Both animate the dash offset to convey data flow direction.
 */
export const AnimatedEdge: React.FC<EdgeProps<AnimatedEdgeData>> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}) => {
  const relationshipType = data?.relationshipType ?? 'lookup';
  const relationshipName = data?.relationshipName ?? '';

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const isMasterDetail = relationshipType === 'master-detail';
  const strokeWidth = isMasterDetail ? 2 : 1;
  const strokeDasharray = isMasterDetail ? undefined : '5,5';
  const strokeColor = '#F97316';
  const defaultColor = 'rgba(255,255,255,0.3)';

  return (
    <g data-testid="animated-edge">
      <style>{animationStyle}</style>
      {/* Invisible wider path for easier mouse interaction */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={10}
      />
      {/* Visible path */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={style?.stroke ?? defaultColor}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray ?? '20,20'}
        style={{
          animation: `${EDGE_ANIMATION_NAME} 1s linear infinite`,
          ...style,
          stroke: style?.stroke ?? strokeColor,
        }}
      />
      {/* Label */}
      {relationshipName && (
        <text
          x={labelX}
          y={labelY}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-text-muted"
          style={{ fontSize: 9 }}
        >
          {relationshipName}
        </text>
      )}
    </g>
  );
};
