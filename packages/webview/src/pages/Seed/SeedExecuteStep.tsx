import React from 'react';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { Step7Execute } from './Step7_Execute';
import type { ObjectProgress } from './Step7_Execute';
import { SeedRelationsEditor } from './SeedRelationsEditor';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { SeedVolumes } from './seedRelationDrafts';

/** Props for the SeedExecuteStep section. */
export interface SeedExecuteStepProps {
  /** Whether the seed execution mutation is in flight. */
  isRunning: boolean;
  /** Per-object progress entries. */
  objectProgress: ObjectProgress[];
  /** Overall completion 0-100, from the live operation:progress stream. */
  overallPercent: number;
  /** Wall-clock since the run started. */
  elapsedMs: number;
  /** Whether the configure step was auto-skipped (shows the defaults banner). */
  configSkipped: boolean;
  /** Jump back to the configure step and clear the skipped flag. */
  onCustomize: () => void;
  /** Whether every selected object has been described; the run waits for it. */
  fieldsReady: boolean;
  /** Why the last describe failed, while an object still waits for one; null otherwise. */
  fieldsError: string | null;
  /** Ask again for the objects not described yet. */
  onRetryFields: () => void;
  /** Per-object field configurations: where the relations find their lookups. */
  fieldConfigs: ObjectFieldConfig[];
  /** Volume configuration per object: how many parents a relation counts on. */
  volumes: SeedVolumes;
}

/**
 * Step 3 (Execute) of the Seed wizard: execution progress, plus the adaptive
 * banner when Configure was auto-skipped.
 *
 * The banner says what the run's rules are: the default rule of each field,
 * read from the org, and the persona's patterns when one was picked. It used
 * to name a persona whether or not one was picked, above a run that carried
 * no rule at all. Until every object is described it says the run waits for
 * that instead, and the wizard does not move on. With Configure skipped, the
 * relations are set here: they were only reachable through Customize.
 */
export const SeedExecuteStep: React.FC<SeedExecuteStepProps> = ({
  isRunning,
  objectProgress,
  overallPercent,
  elapsedMs,
  configSkipped,
  onCustomize,
  fieldsReady,
  fieldsError,
  onRetryFields,
  fieldConfigs,
  volumes,
}) => {
  const { t } = useTranslation();
  const persona = useSeedWizardStore((s) => s.selectedPersona);

  let fieldsLine: string;
  if (!fieldsReady) {
    fieldsLine = fieldsError
      ? t('seed.adaptive.fieldsFailed', { error: fieldsError })
      : t('seed.adaptive.readingFields');
  } else {
    fieldsLine = persona
      ? t('seed.adaptive.usingPersona', { persona: persona.name })
      : t('seed.adaptive.usingDefaults');
  }

  return (
    <div data-testid="seed-step-execute-content">
      <div className="flex items-center gap-1.5">
        <InfoTooltip id="help.seed.execute" content={t('help.seed.execute')} />
      </div>

      {/* Adaptive: what the run's rules are when configure was skipped, and
          what it waits for while an object is not described yet */}
      {(configSkipped || !fieldsReady) && (
        <div
          className="flex items-center gap-2 p-2 rounded-sm text-xs bg-surface-2 text-(--sf-text-secondary) mb-2"
          data-testid="adaptive-defaults-banner"
        >
          <span role="status" data-testid="seed-fields-status">
            {fieldsLine}
          </span>
          {!fieldsReady && fieldsError && (
            <button
              type="button"
              className="text-(--sf-text-link) hover:underline"
              onClick={onRetryFields}
              data-testid="seed-fields-retry"
            >
              {t('common.retry')}
            </button>
          )}
          {configSkipped && (
            <button
              className="text-(--sf-text-link) hover:underline"
              onClick={onCustomize}
              data-testid="adaptive-customize-link"
            >
              {t('seed.adaptive.customizeLink')}
            </button>
          )}
        </div>
      )}

      {configSkipped && !isRunning && (
        <div className="flex flex-col gap-1 mb-2" data-testid="seed-execute-relations">
          <span className="text-xs font-medium text-(--sf-text-primary)">
            {t('seed.configureRelations')}
          </span>
          <SeedRelationsEditor fieldConfigs={fieldConfigs} volumes={volumes} />
        </div>
      )}

      <Step7Execute
        isRunning={isRunning}
        objectProgress={objectProgress}
        overallPercent={overallPercent}
        elapsedMs={elapsedMs}
      />
    </div>
  );
};
