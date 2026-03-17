import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetadataComponentType } from '@sandforge/shared';
import type { ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { LiveGraph } from '../../components/graph/LiveGraph';

/** Affected component in impact analysis. */
export interface AffectedComponent {
  fullName: string;
  componentType: MetadataComponentType;
  impactType: 'direct' | 'indirect';
}

/** Dependency link between components. */
export interface DependencyLink {
  source: string;
  target: string;
  type: 'references' | 'extends' | 'triggers' | 'layout';
}

/** Impact analysis result. */
export interface ImpactAnalysis {
  impactScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedComponents: AffectedComponent[];
  dependencies: DependencyLink[];
  recommendations: string[];
}

/** ImpactGraph component props. */
export interface ImpactGraphProps {
  analysis?: ImpactAnalysis;
  className?: string;
}

/**
 * Convert ImpactAnalysis data to ForgeGraph format for LiveGraph.
 *
 * Maps affected components to ForgeGraphNodes and dependency links
 * to ForgeGraphEdges so the LiveGraph component can render them.
 */
function toForgeGraph(analysis: ImpactAnalysis): ForgeGraph {
  const nodes: ForgeGraphNode[] = analysis.affectedComponents.map((comp) => ({
    objectApiName: comp.fullName,
    recordCount: 0,
    fieldCount: 0,
    status: comp.impactType === 'direct' ? 'running' : 'idle',
    progress: comp.impactType === 'direct' ? 100 : 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto' as const,
  }));

  const edges: ForgeGraphEdge[] = analysis.dependencies.map((dep) => ({
    sourceObject: dep.source,
    targetObject: dep.target,
    relationshipName: dep.type,
    type: 'lookup' as const,
  }));

  return {
    nodes,
    edges,
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/** Graph visualization of impact analysis using LiveGraph. */
export const ImpactGraph: React.FC<ImpactGraphProps> = ({ analysis, className }) => {
  const { t } = useTranslation();

  const forgeGraph = useMemo(() => {
    if (!analysis) return null;
    return toForgeGraph(analysis);
  }, [analysis]);

  return (
    <Card className={className}>
      <CardHeader title={t('compare.impact')} />
      <CardBody>
        {!analysis ? (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('common.noData')}
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="impact-graph">
            {/* Summary row */}
            <div className="flex items-center gap-3">
              <Badge variant={analysis.riskLevel === 'low' ? 'success' : analysis.riskLevel === 'medium' ? 'warning' : 'error'}>
                {analysis.riskLevel}
              </Badge>
              <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                Impact Score: {analysis.impactScore}
              </span>
              <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                {analysis.affectedComponents.length} affected components
              </span>
            </div>

            {/* LiveGraph visualization */}
            {forgeGraph && forgeGraph.nodes.length > 0 && (
              <div
                style={{ width: '100%', height: Math.max(200, forgeGraph.nodes.length * 80) }}
                data-testid="impact-live-graph"
              >
                <LiveGraph graph={forgeGraph} />
              </div>
            )}

            {/* Recommendations */}
            {analysis.recommendations.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="impact-recommendations">
                <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                  Recommendations
                </span>
                {analysis.recommendations.map((rec, i) => (
                  <div
                    key={i}
                    className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] pl-2 border-l-2 border-[var(--vscode-textLink-foreground,#3794ff)]"
                  >
                    {rec}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
};
