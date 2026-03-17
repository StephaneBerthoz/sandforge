import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HealthReport, HealthFactor } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

export interface HealthScoreCardProps {
  report: HealthReport;
  className?: string;
}

/** Status icon codicon name */
function statusIcon(status: HealthFactor['status']): string {
  switch (status) {
    case 'healthy': return 'check';
    case 'warning': return 'warning';
    case 'critical': return 'error';
  }
}

/** Status color CSS variable */
function statusColor(status: HealthFactor['status']): string {
  switch (status) {
    case 'healthy': return 'var(--sf-success, #10B981)';
    case 'warning': return 'var(--sf-warning, #F59E0B)';
    case 'critical': return 'var(--sf-error, #EF4444)';
  }
}

/** Score color for gauge */
function gaugeColor(score: number): string {
  if (score >= 75) return 'var(--sf-success, #10B981)';
  if (score >= 50) return 'var(--sf-warning, #F59E0B)';
  return 'var(--sf-error, #EF4444)';
}

/** Impact in points for a factor based on weight and score loss */
function impactPoints(factor: HealthFactor): number {
  return Math.round((100 - factor.score) * factor.weight);
}

/** SVG radial gauge (270 degree arc) */
const RadialGauge: React.FC<{ score: number; size?: number }> = ({ score, size = 120 }) => {
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - 16) / 2;
  const startAngle = 135;
  const totalAngle = 270;
  const circumference = (totalAngle / 360) * 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;
  const color = gaugeColor(score);

  const polarToCartesian = (angle: number) => ({
    x: cx + radius * Math.cos((angle * Math.PI) / 180),
    y: cy + radius * Math.sin((angle * Math.PI) / 180),
  });

  const start = polarToCartesian(startAngle);
  const end = polarToCartesian(startAngle + totalAngle);
  const largeArc = totalAngle > 180 ? 1 : 0;

  const bgPath = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} data-testid="health-gauge">
      {/* Background arc */}
      <path
        d={bgPath}
        fill="none"
        stroke="var(--vscode-input-background, #3c3c3c)"
        strokeWidth={8}
        strokeLinecap="round"
      />
      {/* Filled arc */}
      <path
        d={bgPath}
        fill="none"
        stroke={color}
        strokeWidth={8}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        style={{ transition: 'stroke-dasharray 0.6s ease-out' }}
      />
      {/* Score text */}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="24" fontWeight="bold" fill="var(--sf-text-primary, #d4d4d4)">
        {score}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" fill="var(--sf-text-secondary, #868686)">
        /100
      </text>
    </svg>
  );
};

export const HealthScoreCard: React.FC<HealthScoreCardProps> = ({ report, className }) => {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <div data-testid="health-score-card">
      <Card className={cn('border-0 bg-transparent shadow-none', className)}>
        <CardBody>
          <div className="flex flex-col items-center gap-[var(--sf-space-2)]">
            <span className="text-xs font-medium text-[var(--sf-text-secondary)]">
              {t('monitor.health', 'Health Score')}
            </span>
            <RadialGauge score={report.overallScore} />
            <p className="text-xs text-center text-[var(--sf-text-secondary)]" data-testid="health-summary">
              {report.summary}
            </p>

            {report.topRisks.length > 0 && (
              <div className="w-full flex flex-col gap-[var(--sf-space-1)] mt-[var(--sf-space-1)]" data-testid="top-risks">
                {report.topRisks.map((risk) => (
                  <div key={risk.name} className="flex items-center gap-[var(--sf-space-1)] text-[10px]">
                    <span className={`codicon codicon-${statusIcon(risk.status)}`} style={{ color: statusColor(risk.status) }} aria-hidden="true" />
                    <span className="flex-1 truncate text-[var(--sf-text-primary)]">{risk.name}: {risk.detail}</span>
                    <span className="text-[var(--sf-text-secondary)]">-{impactPoints(risk)} pts</span>
                  </div>
                ))}
              </div>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowModal(true)}
              data-testid="view-full-report"
            >
              {t('monitor.viewFullReport', 'View Full Report')}
            </Button>
          </div>
        </CardBody>
      </Card>
      </div>

      {showModal && (
        <HealthReportModal report={report} onClose={() => setShowModal(false)} />
      )}
    </>
  );
};

/** Full report modal */
const HealthReportModal: React.FC<{ report: HealthReport; onClose: () => void }> = ({ report, onClose }) => {
  const { t } = useTranslation();
  const categories = ['limits', 'jobs', 'storage'] as const;
  const dialogRef = useRef<HTMLDivElement>(null);

  /** Close on Escape and trap focus within the modal. */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    const closeBtn = dialogRef.current?.querySelector<HTMLElement>('[data-testid="close-report-modal"]');
    closeBtn?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label={t('monitor.healthReport', 'Health Report')} data-testid="health-report-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-[var(--sf-radius-lg)] bg-[var(--vscode-editor-background,#1e1e1e)] border border-[var(--vscode-panel-border,#3c3c3c)] shadow-[var(--sf-shadow-lg)] p-[var(--sf-space-4)]">
        <div className="flex items-center justify-between mb-[var(--sf-space-4)]">
          <h2 className="text-lg font-semibold text-[var(--sf-text-primary)]">
            {t('monitor.healthReport', 'Health Report')}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close', 'Close')} data-testid="close-report-modal">
            <span className="codicon codicon-close" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex items-center gap-[var(--sf-space-3)] mb-[var(--sf-space-4)]">
          <RadialGauge score={report.overallScore} size={80} />
          <div>
            <Badge variant={report.overallStatus === 'healthy' ? 'success' : report.overallStatus === 'warning' ? 'warning' : 'error'}>
              {report.overallStatus}
            </Badge>
            <p className="text-xs text-[var(--sf-text-secondary)] mt-[var(--sf-space-1)]">{report.summary}</p>
          </div>
        </div>

        {categories.map((cat) => {
          const catFactors = report.factors.filter((f) => f.category === cat);
          if (catFactors.length === 0) return null;
          return (
            <div key={cat} className="mb-[var(--sf-space-3)]" data-testid={`category-${cat}`}>
              <h3 className="text-sm font-medium text-[var(--sf-text-primary)] mb-[var(--sf-space-2)] capitalize">{cat}</h3>
              <div className="flex flex-col gap-[var(--sf-space-2)]">
                {catFactors.map((factor) => (
                  <div key={factor.name} className="p-[var(--sf-space-2)] rounded-[var(--sf-radius-md)] bg-[var(--vscode-input-background,#3c3c3c)]">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-[var(--sf-space-1)]">
                        <span className={`codicon codicon-${statusIcon(factor.status)}`} style={{ color: statusColor(factor.status) }} aria-hidden="true" />
                        <span className="text-xs font-medium text-[var(--sf-text-primary)]">{factor.name}</span>
                      </div>
                      <Badge variant={factor.status === 'healthy' ? 'success' : factor.status === 'warning' ? 'warning' : 'error'}>
                        {factor.score}/100
                      </Badge>
                    </div>
                    <p className="text-[10px] text-[var(--sf-text-secondary)] mt-[var(--sf-space-1)]">{factor.detail}</p>
                    <p className="text-[10px] text-[var(--sf-info,#3B82F6)] mt-[var(--sf-space-1)]">{factor.recommendation}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
