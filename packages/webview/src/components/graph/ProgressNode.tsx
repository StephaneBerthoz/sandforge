import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Check, Loader2, Clock, X, AlertTriangle, Minus, Shield } from 'lucide-react';
import type { ForgeNodeStatus } from '@sandforge/shared';
import { cn } from '../../theme';

/** Data payload carried by a ProgressNode in the React Flow graph. */
export interface ProgressNodeData {
  /** Salesforce object API name displayed as the node title. */
  objectApiName: string;
  /** Number of records to process. */
  recordCount: number;
  /** Number of fields included in the operation. */
  fieldCount: number;
  /** Number of createable fields. */
  createableFieldCount: number;
  /** Estimated data size in MB. */
  estimatedSizeMB: number;
  /** Current processing status. */
  status: ForgeNodeStatus;
  /** Progress percentage 0-100. */
  progress: number;
  /** Whether this node is included in the current operation. */
  included: boolean;
  /** Whether this node has PII fields detected. */
  hasPII: boolean;
  /** Number of PII fields detected. */
  piiCount: number;
  /** Number of errors accumulated. */
  errorCount: number;
  /** Edge type from parent relationship. */
  edgeType: 'master-detail' | 'lookup' | null;
  /** Callback when the node is clicked. */
  onSelect?: (objectName: string) => void;
  /** Callback when the include checkbox is toggled. */
  onIncludeToggle?: (objectName: string) => void;
}

const borderByStatus: Record<ForgeNodeStatus, string> = {
  idle: 'border-subtle',
  scanning: 'border-forge',
  running: 'border-forge animate-pulse',
  done: 'border-green-500',
  error: 'border-red-500',
  skipped: 'border-text-muted',
};

/** Render the appropriate status icon for a given ForgeNodeStatus. */
function StatusIcon({ status }: { status: ForgeNodeStatus }): React.ReactElement | null {
  switch (status) {
    case 'done':
      return <Check className="h-3 w-3 text-status-success" />;
    case 'running':
      return <Loader2 className="h-3 w-3 animate-spin text-hue-forge" />;
    case 'scanning':
      return <Loader2 className="h-3 w-3 animate-spin text-hue-forge" />;
    case 'error':
      return <X className="h-3 w-3 text-status-error" />;
    case 'skipped':
      return <Minus className="h-3 w-3 text-text-secondary" />;
    case 'idle':
    default:
      return <Clock className="h-3 w-3 text-text-secondary" />;
  }
}

/**
 * Custom React Flow node displaying a Salesforce object's processing status.
 *
 * Shows the object name, record/field counts, size estimate, createable fields,
 * a progress bar during scanning/running, PII and error badges, edge type
 * indicator, and an include/exclude checkbox.
 */
export const ProgressNode: React.FC<NodeProps<ProgressNodeData>> = ({ data }) => {
  const { t } = useTranslation();
  const {
    objectApiName,
    recordCount,
    fieldCount,
    createableFieldCount,
    estimatedSizeMB,
    status,
    progress,
    included,
    hasPII,
    piiCount,
    errorCount,
    edgeType,
    onSelect,
    onIncludeToggle,
  } = data;

  const handleClick = useCallback(() => {
    onSelect?.(objectApiName);
  }, [onSelect, objectApiName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        onSelect?.(objectApiName);
      }
    },
    [onSelect, objectApiName],
  );

  const handleCheckboxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      onIncludeToggle?.(objectApiName);
    },
    [onIncludeToggle, objectApiName],
  );

  const showProgress = status === 'scanning' || status === 'running';

  return (
    <div
      data-testid="progress-node"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'bg-surface-2 rounded-lg border p-3 min-w-[200px] cursor-pointer transition-colors',
        borderByStatus[status],
        // Left out of the run: a dashed outline, not faded text.
        !included && 'border-dashed',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-text-muted" />

      {/* Header: checkbox + object name + edge type badge */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          {onIncludeToggle && (
            <input
              type="checkbox"
              data-testid="include-checkbox"
              checked={included}
              onChange={handleCheckboxChange}
              className="h-3 w-3 accent-forge cursor-pointer"
              aria-label={`Include ${objectApiName}`}
            />
          )}
          <span className="text-xs font-semibold text-text-primary truncate">{objectApiName}</span>
        </div>
        <div className="flex items-center gap-1">
          {edgeType && (
            <span
              data-testid="edge-type-badge"
              className={cn(
                'text-[9px] font-bold px-1 rounded',
                edgeType === 'master-detail'
                  ? 'bg-forge/20 text-hue-forge'
                  : 'bg-gray-500/10 text-text-primary',
              )}
            >
              {edgeType === 'master-detail' ? 'MD' : 'LK'}
            </span>
          )}
          <StatusIcon status={status} />
        </div>
      </div>

      {/*
        Counts, or the fact that there are none yet.
        A described object always reports fields, so `fieldCount === 0` means
        this node has not been described — which is every node of a run started
        from a template, whose graph is built locally with zeroes and which no
        progress event ever fills in. The card used to state those zeroes as
        fact: "0 records ~0.0 MB / 0 fields (0 cloneable)" on objects that were
        being cloned at that moment.
      */}
      {fieldCount > 0 ? (
        <>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-text-secondary">
            <span>{t('forge.node.records', { records: recordCount.toLocaleString() })}</span>
            <span>~{estimatedSizeMB.toFixed(1)} MB</span>
          </div>
          <div className="mt-0.5 text-[10px] text-text-secondary">
            <span>
              {t('forge.node.fieldsCloneable', {
                total: fieldCount,
                cloneable: createableFieldCount,
              })}
            </span>
          </div>
        </>
      ) : (
        <div className="mt-1 text-[10px] text-text-secondary" data-testid="node-counts-unknown">
          {t('forge.node.notMeasured')}
        </div>
      )}

      {/* Progress bar */}
      {showProgress && (
        <div className="mt-2 h-1 w-full rounded-full bg-surface-3 overflow-hidden">
          <div
            data-testid="progress-bar-fill"
            className="h-full rounded-full bg-forge transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}

      {/* Badges: PII count + error count */}
      <div className="mt-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {hasPII && (
            <span
              data-testid="pii-badge"
              className="flex items-center gap-0.5 text-[9px] text-status-warning"
            >
              <Shield className="h-2.5 w-2.5" />
              {piiCount} PII
            </span>
          )}
        </div>
        {errorCount > 0 && (
          <span
            data-testid="error-badge"
            className="flex items-center gap-0.5 text-[9px] text-status-error"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            {errorCount}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-text-muted" />
    </div>
  );
};
