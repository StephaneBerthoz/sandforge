import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineStep, PipelineStepType } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../theme';

/** StepConfigPanel props. */
export interface StepConfigPanelProps {
  step?: PipelineStep;
  onUpdate?: (stepId: string, updates: Partial<PipelineStep>) => void;
  className?: string;
}

/** Step-type specific config fields (labels are i18n keys). */
const STEP_CONFIG_FIELDS: Partial<
  Record<
    PipelineStepType,
    Array<{ key: string; labelKey: string; type: 'text' | 'number' | 'boolean' }>
  >
> = {
  seed: [
    { key: 'objectName', labelKey: 'common.object', type: 'text' },
    { key: 'recordCount', labelKey: 'seed.recordCount', type: 'number' },
  ],
  sync: [
    { key: 'sourceOrg', labelKey: 'sync.source', type: 'text' },
    { key: 'targetOrg', labelKey: 'sync.target', type: 'text' },
  ],
  backup: [
    { key: 'backupName', labelKey: 'dataops.backupName', type: 'text' },
    { key: 'includeAttachments', labelKey: 'dataops.includeAttachments', type: 'boolean' },
  ],
  notification: [
    { key: 'channel', labelKey: 'automation.stepConfigChannel', type: 'text' },
    { key: 'message', labelKey: 'automation.stepConfigMessage', type: 'text' },
  ],
  delay: [{ key: 'seconds', labelKey: 'automation.stepConfigDelay', type: 'number' }],
  script: [{ key: 'script', labelKey: 'automation.stepConfigScript', type: 'text' }],
  delete: [
    { key: 'objectName', labelKey: 'common.object', type: 'text' },
    { key: 'query', labelKey: 'automation.stepConfigWhere', type: 'text' },
    { key: 'hardDelete', labelKey: 'dataops.hardDelete', type: 'boolean' },
  ],
  anonymize: [{ key: 'templateId', labelKey: 'automation.stepConfigTemplate', type: 'text' }],
};

/**
 * Step configuration panel for editing step properties
 * including name, timeout, retries, continueOnError,
 * and step-type-specific configuration fields.
 */
export const StepConfigPanel: React.FC<StepConfigPanelProps> = ({ step, onUpdate, className }) => {
  const { t } = useTranslation();

  if (!step) {
    return (
      <div
        className={cn('text-xs text-center py-6 text-[var(--sf-text-muted,#868686)]', className)}
        data-testid="step-config-empty"
      >
        {t('automation.selectStep', 'Select a step to configure')}
      </div>
    );
  }

  const configFields = STEP_CONFIG_FIELDS[step.type] ?? [];

  const handleUpdate = (updates: Partial<PipelineStep>) => {
    onUpdate?.(step.id, updates);
  };

  const handleConfigUpdate = (key: string, value: unknown) => {
    onUpdate?.(step.id, {
      config: { ...step.config, [key]: value },
    });
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-3 p-3 border border-[var(--sf-border,#3c3c3c)] rounded',
        className,
      )}
      data-testid="step-config-panel"
    >
      {/* Step header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
          {t('automation.stepConfig', 'Step Configuration')}
        </span>
        <Badge variant="default">{step.type}</Badge>
      </div>

      {/* Step name */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
          {t('automation.stepName', 'Step Name')}
        </span>
        <input
          type="text"
          value={step.name}
          onChange={(e) => handleUpdate({ name: e.target.value })}
          className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)]"
          data-testid="step-name-input"
        />
      </label>

      {/* Timeout */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
          {t('automation.timeout', 'Timeout (seconds)')}
        </span>
        <input
          type="number"
          value={step.timeout ?? ''}
          onChange={(e) =>
            handleUpdate({ timeout: e.target.value ? Number(e.target.value) : undefined })
          }
          placeholder="300"
          className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)]"
          data-testid="step-timeout-input"
        />
      </label>

      {/* Retries */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
          {t('automation.retries', 'Retries')}
        </span>
        <input
          type="number"
          value={step.retries ?? ''}
          onChange={(e) =>
            handleUpdate({ retries: e.target.value ? Number(e.target.value) : undefined })
          }
          placeholder="0"
          min={0}
          max={5}
          className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)]"
          data-testid="step-retries-input"
        />
      </label>

      {/* Continue on error */}
      <label className="flex items-center gap-2 text-xs text-[var(--sf-text-primary,#d4d4d4)]">
        <input
          type="checkbox"
          checked={step.continueOnError}
          onChange={(e) => handleUpdate({ continueOnError: e.target.checked })}
          data-testid="step-continue-error"
        />
        {t('automation.continueOnError', 'Continue on error')}
      </label>

      {/* Step-type-specific config fields */}
      {configFields.length > 0 && (
        <div
          className="flex flex-col gap-2 mt-1 pt-2 border-t border-[var(--sf-border,#3c3c3c)]"
          data-testid="step-type-config"
        >
          <span className="text-[10px] font-semibold text-[var(--sf-text-muted,#868686)] uppercase">
            {t('automation.typeConfig', 'Type-specific config')}
          </span>
          {/* A checkbox already carries its caption inside its own wrapping
              label, so only the other field types need a caption of their own. */}
          {configFields.map((field) =>
            field.type === 'boolean' ? (
              <label
                key={field.key}
                className="flex items-center gap-2 text-xs text-[var(--sf-text-primary,#d4d4d4)]"
              >
                <input
                  type="checkbox"
                  checked={Boolean(step.config[field.key])}
                  onChange={(e) => handleConfigUpdate(field.key, e.target.checked)}
                  data-testid={`config-${field.key}`}
                />
                {t(field.labelKey)}
              </label>
            ) : (
              <label key={field.key} className="flex flex-col gap-1">
                <span className="text-[10px] text-[var(--sf-text-muted,#868686)]">
                  {t(field.labelKey)}
                </span>
                <input
                  type={field.type}
                  value={String(step.config[field.key] ?? '')}
                  onChange={(e) =>
                    handleConfigUpdate(
                      field.key,
                      field.type === 'number' ? Number(e.target.value) : e.target.value,
                    )
                  }
                  className="text-xs p-1.5 rounded border border-[var(--sf-border,#3c3c3c)] bg-[var(--sf-bg-input,#1e1e1e)] text-[var(--sf-text-primary,#d4d4d4)]"
                  data-testid={`config-${field.key}`}
                />
              </label>
            ),
          )}
        </div>
      )}
    </div>
  );
};
