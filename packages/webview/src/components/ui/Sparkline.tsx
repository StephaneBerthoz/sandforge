import React from 'react';
import { cn } from '../../theme';

/** Props for the Sparkline SVG component. */
export interface SparklineProps {
  /** Array of numeric values (typically usedPercent 0-100). */
  data: number[];
  /** SVG width. Default: 120. */
  width?: number;
  /** SVG height. Default: 32. */
  height?: number;
  /** Stroke color. Default: 'var(--sf-accent)'. */
  color?: string;
  /** Fill color below the line. Default: color with 0.1 opacity. */
  fillColor?: string;
  /** Stroke width. Default: 1.5. */
  strokeWidth?: number;
  /** Render dashed horizontal lines at 75% and 90% of y-axis. */
  showThresholds?: boolean;
  /** Animate the path drawing from left to right. Default: false. */
  animate?: boolean;
  /** Additional CSS classes. */
  className?: string;
}

/** Unique ID counter for SVG gradient definitions. */
let gradientIdCounter = 0;

/**
 * Convert data points to a smooth SVG path using catmull-rom to bezier conversion.
 * Points are scaled to fit within the given dimensions with padding.
 */
function buildSmoothPath(
  data: number[],
  width: number,
  height: number,
  padding: number,
): string {
  if (data.length < 2) return '';

  const minVal = 0;
  const maxVal = 100;
  const range = maxVal - minVal || 1;

  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  const points = data.map((val, i) => ({
    x: padding + (i / (data.length - 1)) * usableWidth,
    y: padding + usableHeight - ((val - minVal) / range) * usableHeight,
  }));

  if (points.length === 2) {
    return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
  }

  // Catmull-Rom to cubic bezier conversion
  let path = `M ${points[0].x},${points[0].y}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[Math.min(points.length - 1, i + 1)];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }

  return path;
}

/**
 * Build the fill path (closed area below the line).
 */
function buildFillPath(
  linePath: string,
  data: number[],
  width: number,
  height: number,
  padding: number,
): string {
  if (!linePath || data.length < 2) return '';

  const usableWidth = width - padding * 2;
  const lastX = padding + usableWidth;
  const bottomY = height - padding;
  const firstX = padding;

  return `${linePath} L ${lastX},${bottomY} L ${firstX},${bottomY} Z`;
}

/**
 * Pure SVG sparkline component.
 * Renders a smooth bezier curve through data points with optional
 * gradient fill, threshold lines, and animation.
 */
export const Sparkline: React.FC<SparklineProps> = ({
  data,
  width = 120,
  height = 32,
  color = 'var(--sf-accent)',
  fillColor,
  strokeWidth = 1.5,
  showThresholds = false,
  animate = false,
  className,
}) => {
  const gradientId = React.useMemo(() => `sparkline-grad-${++gradientIdCounter}`, []);
  const padding = 2;

  // Edge case: empty data
  if (data.length === 0) {
    return null;
  }

  // Edge case: single point — render a dot
  if (data.length === 1) {
    const minVal = 0;
    const maxVal = 100;
    const range = maxVal - minVal || 1;
    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;
    const cx = padding + usableWidth / 2;
    const cy = padding + usableHeight - ((data[0] - minVal) / range) * usableHeight;

    return (
      <svg
        data-testid="sparkline"
        className={className}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Sparkline chart"
      >
        <circle
          cx={cx}
          cy={cy}
          r={strokeWidth}
          fill={color}
        />
      </svg>
    );
  }

  const linePath = buildSmoothPath(data, width, height, padding);
  const fillPath = buildFillPath(linePath, data, width, height, padding);

  const usableHeight = height - padding * 2;

  // Threshold line positions (75% and 90% of the y-axis, where 0% is bottom and 100% is top)
  const threshold75Y = padding + usableHeight - (75 / 100) * usableHeight;
  const threshold90Y = padding + usableHeight - (90 / 100) * usableHeight;

  const resolvedFillColor = fillColor ?? color;

  return (
    <svg
      data-testid="sparkline"
      className={cn(animate ? 'sparkline-animate' : undefined, className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Sparkline chart"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={resolvedFillColor} stopOpacity="0.1" />
          <stop offset="100%" stopColor={resolvedFillColor} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Threshold lines */}
      {showThresholds && (
        <>
          <line
            data-testid="threshold-75"
            x1={padding}
            y1={threshold75Y}
            x2={width - padding}
            y2={threshold75Y}
            stroke="var(--sf-warning)"
            strokeWidth={0.5}
            strokeDasharray="3 3"
            opacity={0.5}
          />
          <line
            data-testid="threshold-90"
            x1={padding}
            y1={threshold90Y}
            x2={width - padding}
            y2={threshold90Y}
            stroke="var(--sf-error)"
            strokeWidth={0.5}
            strokeDasharray="3 3"
            opacity={0.5}
          />
        </>
      )}

      {/* Fill area */}
      <path
        d={fillPath}
        fill={`url(#${gradientId})`}
      />

      {/* Line */}
      <path
        data-testid="sparkline-path"
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? 'sparkline-line-animate' : undefined}
      />

      {animate && (
        <style>{`
          .sparkline-line-animate {
            stroke-dasharray: ${width * 3};
            stroke-dashoffset: ${width * 3};
            animation: sparkline-draw 1s ease-in-out forwards;
          }
          @keyframes sparkline-draw {
            to {
              stroke-dashoffset: 0;
            }
          }
        `}</style>
      )}
    </svg>
  );
};
