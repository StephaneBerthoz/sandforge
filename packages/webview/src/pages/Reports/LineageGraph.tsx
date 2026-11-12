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

/**
 * A node's width, and the distance from one column to the next. The edge
 * between two columns carries its label, "1,200 records" or "upsert": columns
 * 220 apart for nodes 180 wide left it 40 pixels, and the nodes on either
 * side cut "1,200 records" to "00 recor". 140 pixels hold it.
 */
const NODE_WIDTH = 180;
const COLUMN_STEP = 320;

/** The distance from one row of a column to the next, and a node of two lines of label. */
const ROW_STEP = 90;
const NODE_HEIGHT = 50;

/**
 * The smallest zoom the graph is drawn at. Fitted to whatever the panel held,
 * five columns in an 800-pixel panel fell to React Flow's own floor of 0.5:
 * 11-pixel text read as 5.5, and the first and last nodes were cut. At 0.9 it
 * reads as the 10 pixels of the page's smallest text, and a graph the panel
 * cannot hold at that zoom scrolls in its box.
 */
const READABLE_ZOOM = 0.9;

/** What React Flow's fit adds around the graph: its default padding of 0.1. */
const FIT_ROOM = 1.1;

/** The box the fit draws a graph of `columns` by `rows` in at {@link READABLE_ZOOM}, or larger. */
function readableBox(columns: number, rows: number): { minWidth: number; height: number } {
  const room = FIT_ROOM * READABLE_ZOOM;
  return {
    minWidth: Math.ceil(((columns - 1) * COLUMN_STEP + NODE_WIDTH) * room),
    height: Math.max(250, Math.ceil(((rows - 1) * ROW_STEP + NODE_HEIGHT) * room)),
  };
}

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

  const { nodes, edges, box } = useMemo(() => {
    if (!lineage) return { nodes: [] as Node[], edges: [] as Edge[], box: readableBox(1, 1) };

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
        position: { x: col * COLUMN_STEP + 20, y: row * ROW_STEP + 20 },
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
          width: NODE_WIDTH,
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
      labelStyle: { fontSize: 11, fill: 'var(--sf-text-secondary)' },
      // React Flow draws the label on a white rectangle unless told otherwise.
      labelBgStyle: { fill: 'var(--sf-bg-primary)' },
    }));

    return {
      nodes: flowNodes,
      edges: flowEdges,
      box: readableBox(presentTypes.length, Math.max(...Object.values(columnCounts))),
    };
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
                  role="region"
                  aria-label={t('reports.lineage')}
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a graph wider than the panel scrolls, and the drawing pans by no key: the region takes the focus itself, so the keyboard can scroll it (axe scrollable-region-focusable).
                  tabIndex={0}
                  className={cn(
                    'overflow-x-auto rounded border border-[var(--sf-border)]',
                    'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)',
                  )}
                  data-testid="lineage-scroll"
                >
                  <div style={{ width: '100%', ...box }} data-testid="lineage-flow">
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
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
