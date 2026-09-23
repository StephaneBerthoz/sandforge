import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Activity, Pause, X, Clock, Zap, AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { cn } from '../../theme';
import type { LiveOperationSnapshot } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';

/**
 * Props for the LiveOperationsPanel component.
 *
 * There is no pause or resume: the operations tracked here are the runs that
 * write to an org — Seed, Sync, a Forge clone and the removal of what one
 * created, a record clone, a CSV import, a Frozen dataset load — which can be
 * cancelled but not paused. The buttons this panel used to
 * offer reached a handler that only knows pipeline runs, and every click
 * answered "No active operation found to pause."
 */
export interface LiveOperationsPanelProps {
  /** Array of live operation snapshots. */
  operations: LiveOperationSnapshot[];
  /** Callback to cancel an operation. */
  onCancel?: (operationId: string) => void;
}

/**
 * The name a run's module is read by, where the product has one: the
 * navigation's for a module, the audit trail's for a Seed mode. Anything else
 * shows as the extension sent it.
 */
const MODULE_LABEL_KEYS: Readonly<Record<string, string>> = {
  seed: 'nav.seed',
  sync: 'nav.sync',
  forge: 'nav.forge',
  frozen: 'nav.frozen',
  dataops: 'nav.dataops',
  clone: 'reports.auditActions.seed_clone',
  csv: 'reports.auditActions.seed_csv_import',
};

/**
 * The word each status is read by: the one Home and the side panel print, so
 * a run reads the same wherever it is listed.
 */
const STATUS_NAME_KEYS: Record<LiveOperationSnapshot['status'], string> = {
  running: 'home.opStatus.running',
  paused: 'sync.realtime.status.paused',
  completed: 'home.opStatus.success',
  failed: 'home.opStatus.failed',
  cancelled: 'home.opStatus.cancelled',
};

/** Formats elapsed milliseconds as human-readable string. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

/** Returns progress bar variant based on operation status. */
function statusVariant(status: LiveOperationSnapshot['status']): 'default' | 'warning' | 'error' {
  switch (status) {
    case 'failed':
      return 'error';
    case 'paused':
      return 'warning';
    default:
      return 'default';
  }
}

/** Returns a badge variant based on module name. */
function moduleBadgeVariant(module: string): 'default' | 'info' | 'warning' | 'success' | 'error' {
  switch (module) {
    case 'seed':
      return 'info';
    case 'sync':
      return 'success';
    case 'dataops':
      return 'warning';
    default:
      return 'default';
  }
}

/**
 * Status icon for an operation: an image named by its status. The icons said
 * how a run ended by shape and colour alone.
 */
const StatusIcon: React.FC<{ status: LiveOperationSnapshot['status']; t: TFunction }> = ({
  status,
  t,
}) => {
  const name = { role: 'img', 'aria-label': t(STATUS_NAME_KEYS[status]) };
  switch (status) {
    case 'running':
      return <Activity {...name} className="w-3.5 h-3.5 text-status-info animate-pulse" />;
    case 'paused':
      return <Pause {...name} className="w-3.5 h-3.5 text-status-warning" />;
    case 'completed':
      return <CheckCircle {...name} className="w-3.5 h-3.5 text-status-success" />;
    case 'failed':
      return <AlertTriangle {...name} className="w-3.5 h-3.5 text-status-error" />;
    case 'cancelled':
    default:
      return <X {...name} className="w-3.5 h-3.5 text-text-secondary" />;
  }
};

/** A single live operation row. */
const OperationRow: React.FC<{
  operation: LiveOperationSnapshot;
  onCancel?: (id: string) => void;
  t: TFunction;
}> = ({ operation, onCancel, t }) => {
  const isActive = operation.status === 'running' || operation.status === 'paused';
  const moduleKey = MODULE_LABEL_KEYS[operation.module];
  // A run that counts no record — a Frozen load goes by phases — has none to
  // show: its bar and its step say how far it is.
  const counted = operation.processedRecords > 0 || operation.totalRecords > 0;

  return (
    <div
      className={cn(
        'rounded-lg border bg-surface-1 p-3 flex flex-col gap-2 transition-all',
        operation.status === 'failed'
          ? 'border-status-error/30'
          : operation.status === 'running'
            ? 'border-status-info/30'
            : 'border-subtle',
      )}
      data-testid={`live-op-${operation.operationId}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <StatusIcon status={operation.status} t={t} />
        <span className="text-xs font-medium text-text-primary flex-1 truncate">
          {operation.description}
        </span>
        <Badge variant={moduleBadgeVariant(operation.module)}>
          {moduleKey ? t(moduleKey) : operation.module}
        </Badge>
      </div>

      {/* Progress bar */}
      <ProgressBar
        value={operation.percentage}
        variant={statusVariant(operation.status)}
        size="sm"
        ariaLabel={operation.description}
      />

      {/* Stats row */}
      <div className="flex items-center gap-4 text-[10px] text-text-secondary">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <span>{formatElapsed(operation.elapsedMs)}</span>
        </div>
        {counted && (
          <>
            <div className="flex items-center gap-1">
              <Zap className="w-3 h-3" />
              <span>
                {operation.recordsPerSecond} {t('monitor.liveOps.recsPerSec', 'rec/s')}
              </span>
            </div>
            <span className="tabular-nums">
              {operation.processedRecords.toLocaleString(uiLocale())}
              {operation.totalRecords > 0
                ? ` / ${operation.totalRecords.toLocaleString(uiLocale())}`
                : ''}
            </span>
          </>
        )}
        <span className="font-medium">{Math.round(operation.percentage)}%</span>
      </div>

      {/* Current step */}
      <div className="text-[10px] text-text-secondary truncate">{operation.currentStep}</div>

      {/* Error message */}
      {operation.error && (
        <div className="text-[10px] text-status-error truncate">{operation.error}</div>
      )}

      {/* Action buttons */}
      {isActive && (
        <div className="flex items-center gap-1.5 mt-1">
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCancel(operation.operationId)}
              data-testid={`cancel-${operation.operationId}`}
            >
              <X className="w-3 h-3 mr-1" />
              {t('monitor.liveOps.cancel', 'Cancel')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Panel displaying real-time operation progress with live progress bars,
 * elapsed time, throughput (records/sec), and controls.
 */
export const LiveOperationsPanel: React.FC<LiveOperationsPanelProps> = ({
  operations,
  onCancel,
}) => {
  const { t } = useTranslation();

  const activeCount = useMemo(
    () => operations.filter((op) => op.status === 'running' || op.status === 'paused').length,
    [operations],
  );

  if (operations.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-6 text-text-secondary"
        data-testid="live-ops-empty"
      >
        <Activity className="w-6 h-6 mb-2" />
        <span className="text-xs">
          {t('monitor.liveOps.noOperations', 'No operations running')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="live-ops-panel">
      <div className="flex items-center gap-2 mb-1">
        <Activity className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">
          {t('monitor.liveOps.title', 'Live Operations')}
        </h3>
        {activeCount > 0 && (
          <Badge variant="info">{t('monitor.liveOps.activeCount', { count: activeCount })}</Badge>
        )}
      </div>
      {operations.map((op) => (
        <OperationRow key={op.operationId} operation={op} onCancel={onCancel} t={t} />
      ))}
    </div>
  );
};
