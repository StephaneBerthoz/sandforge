import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** Sankey node definition. */
export interface SankeyNode {
  id: string;
  label: string;
  group: 'source' | 'target';
}

/** Sankey link definition. */
export interface SankeyLink {
  sourceId: string;
  targetId: string;
  value: number;
}

/** SankeyFlow component props. */
export interface SankeyFlowProps {
  nodes: SankeyNode[];
  links: SankeyLink[];
  width?: number;
  height?: number;
  className?: string;
}

/** D3-style Sankey flow visualization rendered as SVG. */
export const SankeyFlow: React.FC<SankeyFlowProps> = ({
  nodes,
  links,
  width = 600,
  height = 300,
  className,
}) => {
  const { t } = useTranslation();

  if (nodes.length === 0) {
    return (
      <div
        className={cn('text-xs text-center text-[var(--sf-text-secondary)] py-4', className)}
        data-testid="sankey-flow"
      >
        {t('common.noData')}
      </div>
    );
  }

  const sourceNodes = nodes.filter((n) => n.group === 'source');
  const targetNodes = nodes.filter((n) => n.group === 'target');
  const maxValue = Math.max(...links.map((l) => l.value), 1);
  const nodeWidth = 20;
  const padding = 40;

  const sourceYScale = (height - 2 * padding) / Math.max(sourceNodes.length, 1);
  const targetYScale = (height - 2 * padding) / Math.max(targetNodes.length, 1);

  const sourcePositions = new Map<string, { x: number; y: number }>();
  sourceNodes.forEach((n, i) => {
    sourcePositions.set(n.id, { x: padding, y: padding + i * sourceYScale + sourceYScale / 2 });
  });

  const targetPositions = new Map<string, { x: number; y: number }>();
  targetNodes.forEach((n, i) => {
    targetPositions.set(n.id, {
      x: width - padding - nodeWidth,
      y: padding + i * targetYScale + targetYScale / 2,
    });
  });

  return (
    <div className={className} data-testid="sankey-flow">
      <span className="text-xs font-medium text-[var(--sf-text-primary)] block mb-2">
        {t('sync.dataFlow')}
      </span>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        data-testid="sankey-svg"
      >
        {/* Links */}
        {links.map((link, i) => {
          const src = sourcePositions.get(link.sourceId);
          const tgt = targetPositions.get(link.targetId);
          if (!src || !tgt) return null;
          const strokeWidth = Math.max(2, (link.value / maxValue) * 20);
          const midX = (src.x + nodeWidth + tgt.x) / 2;
          return (
            <path
              key={i}
              d={`M${src.x + nodeWidth},${src.y} C${midX},${src.y} ${midX},${tgt.y} ${tgt.x},${tgt.y}`}
              fill="none"
              stroke="var(--sf-accent)"
              strokeWidth={strokeWidth}
              opacity={0.3}
              data-testid={`link-${link.sourceId}-${link.targetId}`}
            />
          );
        })}

        {/* Source nodes */}
        {sourceNodes.map((node) => {
          const pos = sourcePositions.get(node.id);
          if (!pos) return null;
          return (
            <g key={node.id} data-testid={`node-${node.id}`}>
              <rect
                x={pos.x}
                y={pos.y - 10}
                width={nodeWidth}
                height={20}
                fill="var(--sf-accent)"
                rx={3}
              />
              <text
                x={pos.x - 4}
                y={pos.y + 4}
                textAnchor="end"
                fontSize={10}
                fill="var(--sf-text-primary)"
              >
                {node.label}
              </text>
            </g>
          );
        })}

        {/* Target nodes */}
        {targetNodes.map((node) => {
          const pos = targetPositions.get(node.id);
          if (!pos) return null;
          return (
            <g key={node.id} data-testid={`node-${node.id}`}>
              <rect
                x={pos.x}
                y={pos.y - 10}
                width={nodeWidth}
                height={20}
                fill="var(--sf-success, #10B981)"
                rx={3}
              />
              <text
                x={pos.x + nodeWidth + 4}
                y={pos.y + 4}
                fontSize={10}
                fill="var(--sf-text-primary)"
              >
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};
