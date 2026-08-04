import React from 'react';
import { cn } from '../../theme';

/** HealthScoreGauge component props. */
export interface HealthScoreGaugeProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Returns color based on health score. */
function scoreColor(score: number): string {
  if (score >= 80) return 'var(--sf-success, #10B981)';
  if (score >= 50) return 'var(--sf-warning, #F59E0B)';
  return 'var(--sf-error, #EF4444)';
}

/** Returns status label based on health score. */
function scoreLabel(score: number): string {
  if (score >= 80) return 'Healthy';
  if (score >= 50) return 'Degraded';
  return 'Critical';
}

const sizeConfig = {
  sm: { size: 80, stroke: 6, textSize: 'text-lg', labelSize: 'text-[9px]' },
  md: { size: 120, stroke: 8, textSize: 'text-2xl', labelSize: 'text-xs' },
  lg: { size: 160, stroke: 10, textSize: 'text-3xl', labelSize: 'text-sm' },
};

/** Circular gauge showing org health score 0-100. */
export const HealthScoreGauge: React.FC<HealthScoreGaugeProps> = ({
  score,
  size = 'md',
  className,
}) => {
  const clamped = Math.min(100, Math.max(0, Math.round(score)));
  const config = sizeConfig[size];
  const radius = (config.size - config.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);
  const color = scoreColor(clamped);
  const label = scoreLabel(clamped);

  return (
    <div className={cn('inline-flex flex-col items-center', className)} data-testid="health-gauge">
      <svg
        width={config.size}
        height={config.size}
        viewBox={`0 0 ${config.size} ${config.size}`}
        className="-rotate-90"
      >
        <circle
          cx={config.size / 2}
          cy={config.size / 2}
          r={radius}
          fill="none"
          stroke="var(--sf-bg-input)"
          strokeWidth={config.stroke}
        />
        <circle
          cx={config.size / 2}
          cy={config.size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={config.stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          className="transition-all duration-700"
          data-testid="health-gauge-arc"
        />
      </svg>
      <div
        className="absolute flex flex-col items-center justify-center"
        style={{ width: config.size, height: config.size }}
      >
        <span className={cn('font-bold text-text-primary', config.textSize)}>{clamped}</span>
        <span className={cn('font-medium', config.labelSize)} style={{ color }}>
          {label}
        </span>
      </div>
    </div>
  );
};
