import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, { type Node, type Edge, Position } from 'reactflow';
import type { DataLineageGraph } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';

/** LineageGraph component props. */
export interface LineageGraphProps {
  lineage?: DataLineageGraph;
  className?: string;
}

/** Color mapping for lineage node types. */
const nodeTypeColors: Record<string, string> = {
  source: 'var(--sf-info, #3794ff)',
  transform: 'var(--sf-warning, #F59E0B)',
  filter: 'var(--vscode-debugIcon-breakpointForeground, #A855F7)',
  destination: 'var(--sf-success, #10B981)',
};

/** Graph visualization of data lineage using React Flow. */
export const LineageGraph: React.FC<LineageGraphProps> = ({ lineage, className }) => {
  const { t } = useTranslation();

  const { nodes, edges } = useMemo(() => {
    if (!lineage) return { nodes: [] as Node[], edges: [] as Edge[] };

    const columnMap: Record<string, number> = {
      source: 0,
      transform: 1,
      filter: 2,
      destination: 3,
    };

    const columnCounts: Record<string, number> = { source: 0, transform: 0, filter: 0, destination: 0 };

    const flowNodes: Node[] = lineage.nodes.map((node) => {
      const col = columnMap[node.type] ?? 1;
      const row = columnCounts[node.type] ?? 0;
      columnCounts[node.type] = row + 1;

      return {
        id: node.id,
        position: { x: col * 220 + 20, y: row * 90 + 20 },
        data: { label: node.label },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: 'var(--vscode-editorWidget-background, #252526)',
          color: 'var(--vscode-editor-foreground, #d4d4d4)',
          border: `2px solid ${nodeTypeColors[node.type] ?? 'var(--vscode-panel-border, #3c3c3c)'}`,
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
      label: edge.label ?? (edge.recordCount ? `${edge.recordCount} ${edge.recordCount === 1 ? 'record' : 'records'}` : undefined),
      style: { stroke: 'var(--vscode-panel-border, #3c3c3c)' },
      labelStyle: { fontSize: 9, fill: 'var(--vscode-descriptionForeground, #868686)' },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [lineage]);

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
                {Object.entries(nodeTypeColors).map(([type, color]) => (
                  <Badge key={type} variant="default">
                    <span style={{ color }}>{t(`reports.${type}`)}</span>
                  </Badge>
                ))}
              </div>

              {/* Stats */}
              <div className="flex gap-3 text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                <span>{lineage.nodes.length} {t('reports.nodes').toLowerCase()}</span>
                <span>{lineage.edges.length} {t('reports.edges').toLowerCase()}</span>
              </div>

              {/* React Flow graph */}
              {nodes.length > 0 && (
                <div
                  style={{ width: '100%', height: Math.max(250, Math.max(...Object.values({ source: 0, transform: 0, filter: 0, destination: 0 })) * 90 + 100, nodes.length * 40) }}
                  className={cn('border border-[var(--vscode-panel-border,#3c3c3c)] rounded')}
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
