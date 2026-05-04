import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Activity, Database, Code, Lock, RefreshCw } from 'lucide-react';
import { cn } from '../../theme';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { OrgHealthDimension } from '@sandforge/shared';

/** Response shape from the health score endpoint. */
interface HealthScorePayload {
  success: boolean;
  overallScore: number;
  dimensions: OrgHealthDimension[];
  recommendations: string[];
  error?: string;
}

/** Icon for each dimension. */
function dimensionIcon(name: string): React.ReactNode {
  switch (name) {
    case 'apiUsage':
      return <Activity className="w-4 h-4" />;
    case 'storageUsage':
      return <Database className="w-4 h-4" />;
    case 'metadataComplexity':
      return <Code className="w-4 h-4" />;
    case 'codeCoverage':
      return <Shield className="w-4 h-4" />;
    case 'securitySettings':
      return <Lock className="w-4 h-4" />;
    default:
      return <Activity className="w-4 h-4" />;
  }
}

/** Score to color. */
function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-red-400';
}

/** Score to badge variant. */
function scoreBadgeVariant(score: number): 'success' | 'warning' | 'error' {
  if (score >= 80) return 'success';
  if (score >= 60) return 'warning';
  return 'error';
}

/** Angle computation for radar chart. */
function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleRad: number,
): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

/** SVG radar chart showing dimension scores. */
const RadarChart: React.FC<{ dimensions: OrgHealthDimension[]; size?: number }> = ({
  dimensions,
  size = 240,
}) => {
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size / 2 - 30;
  const levels = 5;

  const angleStep = (2 * Math.PI) / dimensions.length;
  const startAngle = -Math.PI / 2;

  const gridLines = useMemo(() => {
    const lines: React.ReactNode[] = [];
    for (let level = 1; level <= levels; level++) {
      const r = (maxRadius / levels) * level;
      const points = dimensions
        .map((_, i) => {
          const angle = startAngle + i * angleStep;
          const { x, y } = polarToCartesian(cx, cy, r, angle);
          return `${x},${y}`;
        })
        .join(' ');
      lines.push(
        <polygon
          key={`grid-${level}`}
          points={points}
          fill="none"
          stroke="var(--vscode-input-background, #3c3c3c)"
          strokeWidth={1}
          opacity={0.5}
        />,
      );
    }
    return lines;
  }, [dimensions, maxRadius, cx, cy, angleStep, startAngle]);

  const axes = useMemo(
    () =>
      dimensions.map((_, i) => {
        const angle = startAngle + i * angleStep;
        const { x, y } = polarToCartesian(cx, cy, maxRadius, angle);
        return (
          <line
            key={`axis-${i}`}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="var(--vscode-input-background, #3c3c3c)"
            strokeWidth={1}
            opacity={0.3}
          />
        );
      }),
    [dimensions, maxRadius, cx, cy, angleStep, startAngle],
  );

  const dataPoints = dimensions.map((dim, i) => {
    const angle = startAngle + i * angleStep;
    const r = (dim.score / 100) * maxRadius;
    return polarToCartesian(cx, cy, r, angle);
  });

  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');

  const labels = dimensions.map((dim, i) => {
    const angle = startAngle + i * angleStep;
    const labelRadius = maxRadius + 20;
    const { x, y } = polarToCartesian(cx, cy, labelRadius, angle);
    return (
      <text
        key={`label-${i}`}
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={10}
        fill="var(--sf-text-secondary, #868686)"
        data-testid={`radar-label-${dim.name}`}
      >
        {dim.label}
      </text>
    );
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} data-testid="radar-chart">
      {gridLines}
      {axes}
      <polygon
        points={dataPolygon}
        fill="var(--sf-accent, #3B82F6)"
        fillOpacity={0.2}
        stroke="var(--sf-accent, #3B82F6)"
        strokeWidth={2}
      />
      {dataPoints.map((p, i) => (
        <circle
          key={`point-${i}`}
          cx={p.x}
          cy={p.y}
          r={4}
          fill="var(--sf-accent, #3B82F6)"
          data-testid={`radar-point-${dimensions[i].name}`}
        />
      ))}
      {labels}
    </svg>
  );
};

/** Org Health Score panel with radar chart and recommendations. */
export const OrgHealthPanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const healthMutation = useBridgeMutation<HealthScorePayload>('monitor:health-score', {
    responseType: 'monitor:health-score:response',
  });

  const handleScan = () => {
    if (!selectedOrgId) return;
    healthMutation.mutate({ orgId: selectedOrgId });
  };

  const data = healthMutation.data;

  return (
    <div
      className="rounded-lg border border-subtle bg-surface-1 p-4"
      data-testid="org-health-panel"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.orgHealth.title', 'Org Health Score')}
          </h3>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={handleScan}
          disabled={!selectedOrgId || healthMutation.loading}
          loading={healthMutation.loading}
          data-testid="scan-health-btn"
        >
          <RefreshCw className={cn('w-3.5 h-3.5 mr-1', healthMutation.loading && 'animate-spin')} />
          {t('monitor.orgHealth.scan', 'Scan')}
        </Button>
      </div>

      {healthMutation.error && (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 mb-4"
          data-testid="health-error"
        >
          {healthMutation.error}
        </div>
      )}

      {!data && !healthMutation.loading && !healthMutation.error && (
        <div
          className="flex flex-col items-center justify-center py-8 text-center"
          data-testid="health-empty"
        >
          <Shield className="w-10 h-10 text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">
            {t(
              'monitor.orgHealth.emptyDescription',
              'Click Scan to analyze your org health across API usage, storage, metadata complexity, code coverage, and security.',
            )}
          </p>
        </div>
      )}

      {data?.success && (
        <div className="flex flex-col gap-4">
          {/* Overall score + radar */}
          <div className="flex flex-col lg:flex-row items-center gap-6">
            <div className="flex flex-col items-center gap-2">
              <div
                className={cn('text-4xl font-bold tabular-nums', scoreColor(data.overallScore))}
                data-testid="overall-score"
              >
                {data.overallScore}
              </div>
              <span className="text-xs text-text-muted">
                {t('monitor.orgHealth.overallScore', 'Overall Score')}
              </span>
              <Badge variant={scoreBadgeVariant(data.overallScore)}>
                {data.overallScore >= 80
                  ? t('monitor.orgHealth.healthy', 'Healthy')
                  : data.overallScore >= 60
                    ? t('monitor.orgHealth.needsAttention', 'Needs Attention')
                    : t('monitor.orgHealth.critical', 'Critical')}
              </Badge>
            </div>

            <RadarChart dimensions={data.dimensions} />
          </div>

          {/* Dimension details */}
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
            data-testid="dimension-cards"
          >
            {data.dimensions.map((dim) => (
              <div
                key={dim.name}
                className="rounded-lg border border-subtle bg-surface-2 p-3 flex flex-col gap-2"
                data-testid={`dim-${dim.name}`}
              >
                <div className="flex items-center gap-2">
                  {dimensionIcon(dim.name)}
                  <span className="text-xs font-medium text-text-primary flex-1">{dim.label}</span>
                  <Badge variant={scoreBadgeVariant(dim.score)}>{dim.score}</Badge>
                </div>
                <p className="text-[11px] text-text-secondary">{dim.detail}</p>
              </div>
            ))}
          </div>

          {/* Recommendations */}
          {data.recommendations.length > 0 && (
            <div data-testid="recommendations">
              <h4 className="text-xs font-semibold text-text-primary mb-2">
                {t('monitor.orgHealth.recommendations', 'Recommendations')}
              </h4>
              <div className="flex flex-col gap-1.5">
                {data.recommendations.map((rec, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 px-3 py-2 rounded bg-surface-2 text-xs text-text-secondary"
                  >
                    <span className="text-amber-400 shrink-0 mt-0.5">&#x25CF;</span>
                    <span>{rec}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
