import React from 'react';
import { useTranslation } from 'react-i18next';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { GrappeProgressPanel } from '../../components/GrappeProgressPanel';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { cn } from '../../theme';

/** Per-object execution progress. */
export interface ObjectProgress {
  objectApiName: string;
  total: number;
  completed: number;
  failed: number;
  status: 'pending' | 'running' | 'done' | 'error';
}

/** Step7 props. */
export interface Step7ExecuteProps {
  isRunning: boolean;
  objectProgress: ObjectProgress[];
  overallPercent: number;
  elapsedMs: number;
}

const statusVariant: Record<string, BadgeVariant> = {
  pending: 'default',
  running: 'warning',
  done: 'success',
  error: 'error',
};

/** Wrapper that only mounts GrappeProgressPanel when grappe is active or completed. */
const GrappeProgressPanelWrapper: React.FC = () => {
  const { active, operationId } = useGrappeStore();
  if (!active && !operationId) return null;
  return <GrappeProgressPanel />;
};

/** Step 7 — Execute seed operation with progress. */
export const Step7Execute: React.FC<Step7ExecuteProps> = ({
  isRunning,
  objectProgress,
  overallPercent,
  elapsedMs,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4" data-testid="step-execute">
      <p className="text-xs text-[var(--sf-text-secondary)]">{t('seed.executeDesc')}</p>

      {/* Overall progress */}
      <ProgressBar
        value={overallPercent}
        max={100}
        label={isRunning ? t('seed.running') : `${Math.round(overallPercent)}%`}
        showPercent
        variant={overallPercent >= 100 ? 'success' : 'default'}
      />

      <div className="text-[10px] text-[var(--sf-text-secondary)]" data-testid="elapsed-time">
        {t('seed.executionTime')}: {(elapsedMs / 1000).toFixed(1)}s
      </div>

      {/* Per-object progress */}
      <div className="flex flex-col gap-2">
        {objectProgress.map((obj) => {
          const percent = obj.total > 0 ? Math.round((obj.completed / obj.total) * 100) : 0;
          return (
            <div
              key={obj.objectApiName}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded text-xs',
                'border border-[var(--sf-border)]',
              )}
              data-testid={`progress-${obj.objectApiName}`}
            >
              <Badge variant={statusVariant[obj.status]}>{obj.status}</Badge>
              <span className="text-[var(--sf-text-primary)] w-40 truncate">
                {obj.objectApiName}
              </span>
              <ProgressBar
                value={percent}
                variant={
                  obj.status === 'error' ? 'error' : obj.status === 'done' ? 'success' : 'default'
                }
                size="sm"
                className="flex-1"
              />
              <span className="text-[var(--sf-text-secondary)] w-20 text-right">
                {obj.completed}/{obj.total}
              </span>
              {obj.failed > 0 && (
                <span className="text-[var(--sf-error)]">
                  {obj.failed} {t('seed.failed').toLowerCase()}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Grappe (cluster) progress panel — shown when grappe mode is active */}
      <GrappeProgressPanelWrapper />
    </div>
  );
};
