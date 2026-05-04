import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../theme';

/** Props for the HealthGauge component. */
export interface HealthGaugeProps {
  /** Health value from 0 to 100. */
  value: number;
  /** SVG size in pixels. Defaults to 120. */
  size?: number;
  /** Additional CSS classes. */
  className?: string;
}

/** Arc start angle in degrees (bottom-left). */
const ARC_START = 135;
/** Total arc sweep in degrees. */
const ARC_SWEEP = 270;
/** Stroke width for the gauge arcs. */
const STROKE_WIDTH = 10;

/** Returns the gauge color based on value thresholds. */
function gaugeColor(value: number): string {
  if (value > 80) return 'var(--sf-success, #10B981)';
  if (value >= 40) return 'var(--sf-warning, #F59E0B)';
  return 'var(--sf-error, #EF4444)';
}

/** Returns the status label based on value thresholds. */
function gaugeLabel(value: number): string {
  if (value > 80) return 'Healthy';
  if (value >= 40) return 'Degraded';
  return 'Critical';
}

/** Converts polar coordinates to cartesian. */
function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Builds an SVG arc path descriptor. */
function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/**
 * SVG arc gauge displaying a health value from 0 to 100.
 * Color zones: green (>80), amber (40-80), red (<40).
 * Animated fill via framer-motion.
 */
export const HealthGauge: React.FC<HealthGaugeProps> = ({ value, size = 120, className }) => {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - STROKE_WIDTH * 2) / 2;
  const color = gaugeColor(clamped);
  const label = gaugeLabel(clamped);

  const circumference = (ARC_SWEEP / 360) * 2 * Math.PI * radius;
  const filled = (clamped / 100) * circumference;
  const bgArcPath = describeArc(cx, cy, radius, ARC_START, ARC_START + ARC_SWEEP);

  return (
    <div
      className={cn('inline-flex flex-col items-center justify-center relative', className)}
      data-testid="health-gauge"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background arc */}
        <path
          d={bgArcPath}
          fill="none"
          stroke="var(--vscode-input-background, #3c3c3c)"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
        />
        {/* Animated filled arc */}
        <motion.path
          d={bgArcPath}
          fill="none"
          stroke={color}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${circumference}`}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - filled }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          data-testid="health-gauge-arc"
        />
        {/* Score text */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={size * 0.2}
          fontWeight="bold"
          fill="var(--sf-text-primary, #d4d4d4)"
        >
          {clamped}
        </text>
        {/* Status label */}
        <text
          x={cx}
          y={cy + size * 0.12}
          textAnchor="middle"
          fontSize={size * 0.085}
          fontWeight="500"
          fill={color}
        >
          {label}
        </text>
      </svg>
    </div>
  );
};
