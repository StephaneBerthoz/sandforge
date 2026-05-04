import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { formatDuration } from '../../../utils/formatters';

/** Progress bar component for stats. */
const ProgressBar: React.FC<{ current: number; total: number }> = ({ current, total }) => {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <div
      className="w-full h-2 rounded bg-[var(--vscode-input-background,#3c3c3c)]"
      data-testid="progress-bar"
    >
      <div
        className="h-full rounded bg-[var(--vscode-progressBar-background,#0e70c0)] transition-all duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

/** Live statistics dashboard cards during execution. */
export const LiveStats: React.FC = () => {
  const { t } = useTranslation();
  const liveStats = useAutopilotStore((s) => s.liveStats);

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="live-stats">
      {/* Records Processed */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
        <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
          {t('autopilot.control.recordsProcessed')}
        </span>
        <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {liveStats.recordsProcessed.toLocaleString()} / {liveStats.recordsTotal.toLocaleString()}
        </span>
        <ProgressBar current={liveStats.recordsProcessed} total={liveStats.recordsTotal} />
      </div>

      {/* API Calls */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
        <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
          {t('autopilot.control.apiCalls')}
        </span>
        <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {liveStats.apiCallsUsed.toLocaleString()} / {liveStats.apiCallsEstimated.toLocaleString()}
        </span>
        <ProgressBar current={liveStats.apiCallsUsed} total={liveStats.apiCallsEstimated} />
      </div>

      {/* Elapsed Time */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
        <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
          {t('autopilot.control.elapsed')}
        </span>
        <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {formatDuration(liveStats.elapsedMs)}
        </span>
      </div>

      {/* Current Wave */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--vscode-editor-background,#1e1e1e)]">
        <span className="text-[10px] uppercase tracking-wider text-[var(--vscode-descriptionForeground,#868686)]">
          {t('autopilot.control.currentWave')}
        </span>
        <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {liveStats.currentWave} / {liveStats.totalWaves}
        </span>
      </div>
    </div>
  );
};
