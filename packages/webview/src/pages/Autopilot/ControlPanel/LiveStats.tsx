import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { formatDuration, uiLocale } from '../../../utils/formatters';
import { ProgressBar, ProgressAnnouncer } from '../../../components/ui/ProgressBar';

/** Live statistics dashboard cards during execution. */
export const LiveStats: React.FC = () => {
  const { t } = useTranslation();
  const liveStats = useAutopilotStore((s) => s.liveStats);
  const executionStatus = useAutopilotStore((s) => s.executionStatus);
  const finished = executionStatus === 'completed';
  const percent = Math.round(
    (liveStats.recordsProcessed / Math.max(liveStats.recordsTotal, 1)) * 100,
  );

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="live-stats">
      {/* Records Processed */}
      <div className="flex flex-col gap-1 p-3 rounded-sm bg-(--sf-bg-primary)">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.recordsProcessed')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {liveStats.recordsProcessed.toLocaleString(uiLocale())} /{' '}
          {liveStats.recordsTotal.toLocaleString(uiLocale())}
        </span>
        <ProgressBar
          value={liveStats.recordsProcessed}
          max={Math.max(liveStats.recordsTotal, 1)}
          ariaLabel={t('autopilot.control.recordsProcessed')}
        />
      </div>

      {/* API Calls: those the run made, and the plan's, which are a guess —
          a call for each batch of the rows the scan counted — and are said
          to be one. Written "10 / 50", the guess read as the calls the run
          would make, where the review had called it an estimate. */}
      <div
        className="flex flex-col gap-1 p-3 rounded-sm bg-(--sf-bg-primary)"
        data-testid="live-stats-api-calls"
      >
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.apiCalls')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {liveStats.apiCallsUsed.toLocaleString(uiLocale())}
        </span>
        <ProgressBar
          value={liveStats.apiCallsUsed}
          max={Math.max(liveStats.apiCallsEstimated, 1)}
          ariaLabel={t('autopilot.control.apiCalls')}
        />
        <span className="text-[10px] text-text-secondary">
          {t('common.estimatedApiCallCount', { count: liveStats.apiCallsEstimated })}
        </span>
      </div>

      {/* Elapsed Time */}
      <div className="flex flex-col gap-1 p-3 rounded-sm bg-(--sf-bg-primary)">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.elapsed')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {formatDuration(liveStats.elapsedMs)}
        </span>
      </div>

      {/* Current Wave */}
      <div className="flex flex-col gap-1 p-3 rounded-sm bg-(--sf-bg-primary)">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">
          {t('autopilot.control.currentWave')}
        </span>
        <span className="text-lg font-bold text-text-primary">
          {liveStats.currentWave} / {liveStats.totalWaves}
        </span>
      </div>

      {/* A run of several minutes, spoken: the bars above only redraw. This
          panel stays mounted from the first wave to the finished run. */}
      <ProgressAnnouncer
        message={
          finished
            ? t('a11y.runFinished', {
                name: t('nav.autopilot'),
                written: liveStats.recordsProcessed,
                total: liveStats.recordsTotal,
              })
            : t('a11y.progressAnnouncement', { name: t('nav.autopilot'), percent })
        }
        immediate={finished}
        testId="autopilot-progress-status"
      />
    </div>
  );
};
