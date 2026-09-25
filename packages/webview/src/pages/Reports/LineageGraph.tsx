import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlow, type Node, type Edge, Position } from '@xyflow/react';
import type { DataLineageGraph, LineageNode } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';

/** LineageGraph component props. */
export interface LineageGraphProps {
  lineage?: DataLineageGraph;
  className?: string;
}

type NodeType = LineageNode['type'];

/** Left to right, the order a record passes through the node types. */
const COLUMN_ORDER: readonly NodeType[] = [
  'source',
  'transform',
  'filter',
  'object',
  'destination',
];

/** Border colour of each lineage node type: the theme's raw colours, drawn, not read. */
const nodeTypeColors: Record<NodeType, string> = {
  source: 'var(--sf-info, #3794ff)',
  transform: 'var(--sf-warning, #F59E0B)',
  filter: 'var(--sf-breakpoint-icon)',
  object: 'var(--sf-border)',
  destination: 'var(--sf-success, #10B981)',
};

/**
 * The legend badge of each node type, in the severity its border is drawn in.
 * Written in the border colour itself on the default badge, a name read as low
 * as 1.00:1 (Quiet Light).
 */
const nodeTypeBadgeVariants: Record<NodeType, BadgeVariant> = {
  source: 'info',
  transform: 'warning',
  filter: 'error',
  object: 'default',
  destination: 'success',
};

/** Graph visualization of data lineage using React Flow. */
export const LineageGraph: React.FC<LineageGraphProps> = ({ lineage, className }) => {
  const { t } = useTranslation();

  /** The node types this graph draws, in column order: the legend names only these. */
  const presentTypes = useMemo(
    () => COLUMN_ORDER.filter((type) => lineage?.nodes.some((node) => node.type === type)),
    [lineage],
  );

  const { nodes, edges } = useMemo(() => {
    if (!lineage) return { nodes: [] as Node[], edges: [] as Edge[] };

    /** A source that is not an org is named by what it is, then by its own label. */
    const labelOf = (node: LineageNode): string => {
      if (node.type !== 'source' || !node.origin || node.origin === 'org') return node.label;
      const kind = t(`reports.lineageOrigin.${node.origin}`);
      return node.label ? `${kind} · ${node.label}` : kind;
    };

    // Columns are counted over the types present, so a run traced as
    // source → objects → destination is not drawn with two empty columns.
    const columnCounts: Partial<Record<NodeType, number>> = {};

    const flowNodes: Node[] = lineage.nodes.map((node) => {
      const col = Math.max(0, presentTypes.indexOf(node.type));
      const row = columnCounts[node.type] ?? 0;
      columnCounts[node.type] = row + 1;

      return {
        id: node.id,
        position: { x: col * 220 + 20, y: row * 90 + 20 },
        data: { label: labelOf(node) },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: 'var(--sf-bg-card)',
          color: 'var(--sf-text-primary)',
          border: `2px solid ${nodeTypeColors[node.type] ?? 'var(--sf-border)'}`,
          borderRadius: '6px',
          padding: '8px 12px',
          fontSize: '11px',
          width: 180,
        },
      };
    });

    const flowEdges: Edge[] = lineage.edges.map((edge, i) => ({
      id: `ledge-${i}`,
      source: edge.sourceId,
      target: edge.targetId,
      label:
        edge.label ??
        (edge.recordCount ? t('common.recordCount', { count: edge.recordCount }) : undefined),
      style: { stroke: 'var(--sf-border)' },
      labelStyle: { fontSize: 9, fill: 'var(--sf-text-secondary)' },
      // React Flow draws the label on a white rectangle unless told otherwise.
      labelBgStyle: { fill: 'var(--sf-bg-primary)' },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [lineage, presentTypes, t]);

  return (
    <div data-testid="lineage-graph" className={className}>
      <Card>
        <CardHeader title={t('reports.lineage')} />
        <CardBody>
          {!lineage ? (
            <EmptyState title={t('reports.noLineageData')} />
          ) : (
            <div className="flex flex-col gap-3">
              {/* Legend */}
              <div className="flex gap-2" data-testid="lineage-legend">
                {presentTypes.map((type) => (
                  <Badge key={type} variant={nodeTypeBadgeVariants[type]}>
                    {t(`reports.${type}`)}
                  </Badge>
                ))}
              </div>

              {/* Stats */}
              <div className="flex gap-3 text-[10px] text-[var(--sf-text-secondary)]">
                <span>{t('reports.nodeCount', { count: lineage.nodes.length })}</span>
                <span>{t('reports.edgeCount', { count: lineage.edges.length })}</span>
              </div>

              {/* React Flow graph */}
              {nodes.length > 0 && (
                <div
                  style={{
                    width: '100%',
                    height: Math.max(250, nodes.length * 40),
                  }}
                  className={cn('border border-[var(--sf-border)] rounded')}
                  data-testid="lineage-flow"
                >
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    fitView
                    nodesDraggable={false}
                    nodesConnectable={false}
                    panOnDrag={false}
                    zoomOnScroll={false}
                    preventScrolling={false}
                    proOptions={{ hideAttribution: true }}
                  />
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
