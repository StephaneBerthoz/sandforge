import React, { useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { m, useReducedMotion, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../theme';
import { formatDuration } from '../../../utils/formatters';

/** Data payload for the ObjectNode custom ReactFlow node. */
export type ObjectNodeData = {
  /** Salesforce object API name */
  objectApiName: string;
  /** Total record count to transfer */
  recordCount: number;
  /** Current execution status */
  status: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Number of successfully inserted records */
  successCount: number;
  /** Number of failed records */
  failureCount: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** API calls consumed */
  apiCallsUsed: number;
  /** Whether this object has PII fields */
  hasPii: boolean;
  /** Whether this node is currently selected */
  isSelected: boolean;
};

/**
 * Map of node statuses to their corresponding Tailwind color classes. A phase
 * of the run has an identity hue, an outcome its severity, and a node that is
 * waiting or skipped the neutral foregrounds.
 */
const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-text-secondary',
  queued: 'bg-text-secondary',
  extracting: 'bg-hue-blue',
  anonymizing: 'bg-hue-purple',
  loading: 'bg-hue-green',
  completed: 'bg-status-success',
  failed: 'bg-status-error',
  skipped: 'bg-text-muted',
};

/** Map of node statuses to border color classes. */
const STATUS_BORDER_COLORS: Record<string, string> = {
  pending: 'border-subtle',
  queued: 'border-subtle',
  extracting: 'border-hue-blue/60',
  anonymizing: 'border-hue-purple/60',
  loading: 'border-hue-green/60',
  completed: 'border-status-success/60',
  failed: 'border-status-error/60',
  skipped: 'border-text-muted',
};

/** Statuses that trigger a pulse animation on the node. */
const ACTIVE_STATUSES = new Set(['extracting', 'anonymizing', 'loading']);

/** Framer-motion variants for the pulse animation on active nodes. */
const pulseVariants: Variants = {
  idle: { scale: 1, opacity: 1 },
  active: {
    scale: [1, 1.02, 1],
    opacity: [1, 0.9, 1],
    transition: { duration: 1.5, repeat: Infinity, ease: 'easeInOut' },
  },
};

/**
 * ObjectNode — Custom ReactFlow node representing a Salesforce object
 * in the autopilot dependency graph.
 *
 * Displays object name, progress bar, record counts, elapsed time,
 * and a PII indicator. Active nodes pulse with framer-motion.
 */
/** The node the Autopilot graph draws for one object of the plan. */
export type ObjectFlowNode = Node<ObjectNodeData, 'objectNode'>;

export const ObjectNode: React.FC<NodeProps<ObjectFlowNode>> = ({ data }) => {
  const { t } = useTranslation();
  // MotionConfig's reducedMotion="user" stops transforms, not opacity: under
  // the system setting the scale stopped and the node went on fading between
  // 1 and 0.9. The pulse says nothing the status colour does not.
  const reduceMotion = useReducedMotion();
  const isActive = ACTIVE_STATUSES.has(data.status) && !reduceMotion;

  const barColor = useMemo(
    () => STATUS_COLORS[data.status] ?? STATUS_COLORS['pending'],
    [data.status],
  );

  const borderColor = useMemo(
    () => STATUS_BORDER_COLORS[data.status] ?? STATUS_BORDER_COLORS['pending'],
    [data.status],
  );

  return (
    <m.div
      data-testid="object-node"
      variants={pulseVariants}
      animate={isActive ? 'active' : 'idle'}
      className={cn(
        'rounded-lg border-2 bg-(--sf-bg-primary) shadow-md',
        'min-w-[180px] px-3 py-2',
        borderColor,
        data.isSelected && 'ring-2 ring-(--sf-accent)',
      )}
    >
      <Handle type="target" position={Position.Top} className="bg-text-muted!" />

      {/* Header row: object name + PII lock */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <span
          className="truncate text-sm font-semibold text-(--sf-text-primary)"
          title={data.objectApiName}
        >
          {data.objectApiName}
        </span>
        {data.hasPii && (
          <span
            data-testid="pii-indicator"
            className="text-xs text-status-warning"
            title={t('autopilot.graph.piiDetected')}
            aria-label={t('autopilot.graph.piiDetected')}
          >
            &#x1F512;
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          data-testid="progress-bar"
          className={cn('h-full rounded-full transition-all duration-300', barColor)}
          style={{ width: `${Math.min(data.progress, 100)}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-[10px] text-text-secondary">
        <span data-testid="record-count">
          {data.successCount} / {data.recordCount}
        </span>
        <span data-testid="elapsed-time">{formatDuration(data.elapsedMs)}</span>
      </div>

      <Handle type="source" position={Position.Bottom} className="bg-text-muted!" />
    </m.div>
  );
};
