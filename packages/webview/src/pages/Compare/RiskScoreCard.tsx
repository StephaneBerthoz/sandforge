import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Card, CardBody } from '../../components/ui/Card';
import type { CompareReport, DiffRiskLevel } from '@sandforge/shared';
import { CHANGE_LOOK, CHANGE_ORDER } from './changeLook';

/** Props for the RiskScoreCard component. */
export interface RiskScoreCardProps {
  report: CompareReport;
  className?: string;
}

/** Map risk score to the gauge stroke: the theme's raw severity, drawn, not read. */
function riskColor(score: number): string {
  if (score >= 75) return 'var(--sf-error, #EF4444)';
  if (score >= 50) return 'var(--sf-warning, #F59E0B)';
  if (score >= 25) return 'var(--sf-info, #3B82F6)';
  return 'var(--sf-success, #10B981)';
}

/**
 * Map risk score to the class its label is written in: the severity sized for
 * text, since the raw success colour reads 2:1 on a white editor.
 */
function riskLabelClass(score: number): string {
  if (score >= 75) return 'text-status-error';
  if (score >= 50) return 'text-status-warning';
  if (score >= 25) return 'text-status-info';
  return 'text-status-success';
}

/**
 * Map risk score to the level it is named by. The card wrote the level in
 * English under the gauge, whatever the language.
 */
function riskLevel(score: number): DiffRiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
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
  const label = t(`compare.riskLevel.${riskLevel(riskScore)}`);

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
                stroke="var(--sf-bg-input)"
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
                className={riskLabelClass(riskScore)}
                style={{
                  fontSize: 'var(--sf-font-size-xs)',
                  fontWeight: 600,
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
              {CHANGE_ORDER.map((kind) => (
                <Badge key={kind} variant={CHANGE_LOOK[kind].variant}>
                  {t(`compare.count.${kind}`, { count: summary[kind] })}
                </Badge>
              ))}
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
                    {/* It wrote the level's own code after the count: "3 high"
                        in every language, and "1 critical" agreed with nothing. */}
                    {t(`compare.riskCount.${level}`, { count })}
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
              {deploymentAdvice
                .map((a) =>
                  'count' in a
                    ? t(`compare.advice.${a.kind}`, { count: a.count })
                    : t(`compare.advice.${a.kind}`),
                )
                .join(' ')}
            </p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
};
