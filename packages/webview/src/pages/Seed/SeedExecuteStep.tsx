import React from 'react';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
import { Step7Execute } from './Step7_Execute';
import type { ObjectProgress } from './Step7_Execute';

/** Props for the SeedExecuteStep section. */
export interface SeedExecuteStepProps {
  /** Whether the seed execution mutation is in flight. */
  isRunning: boolean;
  /** Per-object progress entries. */
  objectProgress: ObjectProgress[];
  /** Whether the configure step was auto-skipped (shows the defaults banner). */
  configSkipped: boolean;
  /** Jump back to the configure step and clear the skipped flag. */
  onCustomize: () => void;
}

/**
 * Step 3 (Execute) of the Seed wizard: execution progress, plus the
 * adaptive "using defaults" banner when Configure was auto-skipped.
 */
export const SeedExecuteStep: React.FC<SeedExecuteStepProps> = ({
  isRunning,
  objectProgress,
  configSkipped,
  onCustomize,
}) => {
  const { t } = useTranslation();

  return (
    <div data-testid="seed-step-execute-content">
      <div className="flex items-center gap-1.5">
        <InfoTooltip id="help.seed.execute" content={t('help.seed.execute')} />
      </div>

      {/* Adaptive: show "using defaults" banner when configure was skipped */}
      {configSkipped && (
        <div
          className="flex items-center gap-2 p-2 rounded text-xs bg-[var(--sf-bg-input)] text-[var(--sf-text-secondary)] mb-2"
          data-testid="adaptive-defaults-banner"
        >
          <span>{t('seed.adaptive.usingDefaults')}</span>
          <button
            className="text-[var(--sf-text-link)] hover:underline"
            onClick={onCustomize}
            data-testid="adaptive-customize-link"
          >
            {t('seed.adaptive.customizeLink')}
          </button>
        </div>
      )}

      <Step7Execute
        isRunning={isRunning}
        objectProgress={objectProgress}
        overallPercent={isRunning ? 50 : 0}
        elapsedMs={0}
      />
    </div>
  );
};
