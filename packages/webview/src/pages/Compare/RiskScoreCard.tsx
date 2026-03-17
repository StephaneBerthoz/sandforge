import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Card, CardBody } from '../../components/ui/Card';
import type { CompareReport, DiffRiskLevel } from '@sandforge/shared';

/** Props for the RiskScoreCard component. */
export interface RiskScoreCardProps {
  report: CompareReport;
  className?: string;
}

/** Map risk score to color. */
function riskColor(score: number): string {
  if (score >= 75) return 'var(--sf-error, #EF4444)';
  if (score >= 50) return 'var(--sf-warning, #F59E0B)';
  if (score >= 25) return 'var(--sf-info, #3B82F6)';
  return 'var(--sf-success, #10B981)';
}

/** Map risk score to label. */
function riskLabel(score: number): string {
  if (score >= 75) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 25) return 'Medium';
  return 'Low';
}

/** Badge variant for risk level. */
const riskBadgeVariant: Record<DiffRiskLevel, BadgeVariant> = {
  none: 'default',
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

/**
 * Visual card showing the overall risk score for a compare report.
 * Displays a circular gauge, summary counts, and deployment advice.
 */
export const RiskScoreCard: React.FC<RiskScoreCardProps> = ({ report, className }) => {
  const { t } = useTranslation();

  const { riskScore, summary, deploymentAdvice } = report;
  const color = riskColor(riskScore);
  const label = riskLabel(riskScore);

  const gaugeSize = 100;
  const strokeWidth = 7;
  const radius = (gaugeSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - riskScore / 100);

  return (
    <Card className={className} data-testid="risk-score-card">
      <CardBody>
        <div style={{ display: 'flex', gap: 'var(--sf-space-4)', alignItems: 'flex-start' }}>
          {/* Gauge */}
          <div
            style={{ position: 'relative', width: gaugeSize, height: gaugeSize, flexShrink: 0 }}
            data-testid="risk-gauge"
          >
            <svg
              width={gaugeSize}
              height={gaugeSize}
              viewBox={`0 0 ${gaugeSize} ${gaugeSize}`}
              style={{ transform: 'rotate(-90deg)' }}
            >
              <circle
                cx={gaugeSize / 2}
                cy={gaugeSize / 2}
                r={radius}
                fill="none"
                stroke="var(--vscode-input-background, #3c3c3c)"
                strokeWidth={strokeWidth}
              />
              <circle
                cx={gaugeSize / 2}
                cy={gaugeSize / 2}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
              />
            </svg>
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: gaugeSize,
                height: gaugeSize,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span
                style={{
                  fontSize: 'var(--sf-font-size-2xl, 1.5rem)',
                  fontWeight: 700,
                  color: 'var(--sf-text-primary)',
                }}
                data-testid="risk-score-value"
              >
                {riskScore}
              </span>
              <span
                style={{
                  fontSize: 'var(--sf-font-size-xs)',
                  fontWeight: 600,
                  color,
                }}
                data-testid="risk-score-label"
              >
                {label}
              </span>
            </div>
          </div>

          {/* Summary */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3
              style={{
                fontSize: 'var(--sf-font-size-sm)',
                fontWeight: 600,
                color: 'var(--sf-text-primary)',
                margin: '0 0 var(--sf-space-2)',
              }}
            >
              {t('compare.riskScore', 'Risk Score')}
            </h3>

            {/* Change type counts */}
            <div
              style={{
                display: 'flex',
                gap: 'var(--sf-space-2)',
                flexWrap: 'wrap',
                marginBottom: 'var(--sf-space-2)',
              }}
              data-testid="risk-summary-counts"
            >
              <Badge variant="success">{summary.added} {t('compare.added', 'added')}</Badge>
              <Badge variant="error">{summary.removed} {t('compare.removed', 'removed')}</Badge>
              <Badge variant="warning">{summary.modified} {t('compare.modified', 'modified')}</Badge>
            </div>

            {/* Risk breakdown */}
            <div
              style={{
                display: 'flex',
                gap: 'var(--sf-space-1)',
                flexWrap: 'wrap',
                marginBottom: 'var(--sf-space-2)',
              }}
              data-testid="risk-breakdown"
            >
              {Object.entries(summary.byRisk)
                .filter(([, count]) => count > 0)
                .map(([level, count]) => (
                  <Badge
                    key={level}
                    variant={riskBadgeVariant[level as DiffRiskLevel] ?? 'default'}
                  >
                    {count} {level}
                  </Badge>
                ))}
            </div>

            {/* Deployment advice */}
            <p
              style={{
                fontSize: 'var(--sf-font-size-xs)',
                color: 'var(--sf-text-secondary)',
                margin: 0,
                lineHeight: 1.4,
              }}
              data-testid="deployment-advice"
            >
              {deploymentAdvice}
            </p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
};
