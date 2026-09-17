import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { formatDuration } from '../../../utils/formatters';
import { ProgressBar } from '../../../components/ui/ProgressBar';

/** Live statistics dashboard cards during execution. */
export const LiveStats: React.FC = () => {
  const { t } = useTranslation();
  const liveStats = useAutopilotStore((s) => s.liveStats);

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="live-stats">
      {/* Records Processed */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--sf-bg-primary)]">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.recordsProcessed')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {liveStats.recordsProcessed.toLocaleString()} / {liveStats.recordsTotal.toLocaleString()}
        </span>
        <ProgressBar
          value={liveStats.recordsProcessed}
          max={Math.max(liveStats.recordsTotal, 1)}
          ariaLabel={t('autopilot.control.recordsProcessed')}
        />
      </div>

      {/* API Calls */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--sf-bg-primary)]">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.apiCalls')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {liveStats.apiCallsUsed.toLocaleString()} / {liveStats.apiCallsEstimated.toLocaleString()}
        </span>
        <ProgressBar
          value={liveStats.apiCallsUsed}
          max={Math.max(liveStats.apiCallsEstimated, 1)}
          ariaLabel={t('autopilot.control.apiCalls')}
        />
      </div>

      {/* Elapsed Time */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--sf-bg-primary)]">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.elapsed')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {formatDuration(liveStats.elapsedMs)}
        </span>
      </div>

      {/* Current Wave */}
      <div className="flex flex-col gap-1 p-3 rounded bg-[var(--sf-bg-primary)]">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.currentWave')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {liveStats.currentWave} / {liveStats.totalWaves}
        </span>
      </div>
    </div>
  );
};
