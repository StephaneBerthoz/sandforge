import React, { useMemo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { m } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../theme';
import { formatDuration } from '../../../utils/formatters';

/** Data payload for the ObjectNode custom ReactFlow node. */
export interface ObjectNodeData {
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
}

/** Map of node statuses to their corresponding Tailwind color classes. */
const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-500',
  queued: 'bg-gray-400',
  extracting: 'bg-blue-500',
  anonymizing: 'bg-purple-500',
  loading: 'bg-green-500',
  completed: 'bg-green-600',
  failed: 'bg-red-500',
  skipped: 'bg-gray-300',
};

/** Map of node statuses to border color classes. */
const STATUS_BORDER_COLORS: Record<string, string> = {
  pending: 'border-gray-500/40',
  queued: 'border-gray-400/40',
  extracting: 'border-blue-500/60',
  anonymizing: 'border-purple-500/60',
  loading: 'border-green-500/60',
  completed: 'border-green-600/60',
  failed: 'border-red-500/60',
  skipped: 'border-gray-300/40',
};

/** Statuses that trigger a pulse animation on the node. */
const ACTIVE_STATUSES = new Set(['extracting', 'anonymizing', 'loading']);

/** Framer-motion variants for the pulse animation on active nodes. */
const pulseVariants = {
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
export const ObjectNode: React.FC<NodeProps<ObjectNodeData>> = ({ data }) => {
  const { t } = useTranslation();
  const isActive = ACTIVE_STATUSES.has(data.status);

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
        'rounded-lg border-2 bg-[var(--sf-bg-primary)] shadow-md',
        'min-w-[180px] px-3 py-2',
        borderColor,
        data.isSelected && 'ring-2 ring-blue-400',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />

      {/* Header row: object name + PII lock */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <span
          className="truncate text-sm font-semibold text-[var(--sf-text-primary)]"
          title={data.objectApiName}
        >
          {data.objectApiName}
        </span>
        {data.hasPii && (
          <span
            data-testid="pii-indicator"
            className="text-xs text-amber-400"
            title={t('autopilot.graph.piiDetected')}
            aria-label={t('autopilot.graph.piiDetected')}
          >
            &#x1F512;
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
        <div
          data-testid="progress-bar"
          className={cn('h-full rounded-full transition-all duration-300', barColor)}
          style={{ width: `${Math.min(data.progress, 100)}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-[10px] text-gray-400">
        <span data-testid="record-count">
          {data.successCount} / {data.recordCount}
        </span>
        <span data-testid="elapsed-time">{formatDuration(data.elapsedMs)}</span>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-gray-400" />
    </m.div>
  );
};
