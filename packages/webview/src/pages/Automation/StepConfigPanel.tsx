import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  MetadataComponentType,
  PipelineCondition,
  PipelineStep,
  PipelineStepType,
  PipelineSyncConfigInfo,
  SalesforceOrg,
} from '@sandforge/shared';
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  APPROVAL_MAX_TIMEOUT_MINUTES,
} from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Select } from '../../components/ui/Select';
import { cn } from '../../theme';
import { useOrgStore } from '../../stores/useOrgStore';
import { orgOptionLabel } from '../../utils/orgFormatters';
import { CategorySelector } from '../Compare/CategorySelector';
import { MAX_NOTIFICATION_LENGTH, MAX_STEP_TIMEOUT_MS, PRECHECK_CHECKS } from './stepRunnability';
import {
  CONDITION_KINDS,
  conditionFor,
  kindOf,
  takesThreshold,
  thresholdMax,
} from './conditionPresets';

/** StepConfigPanel props. */
export interface StepConfigPanelProps {
  step?: PipelineStep;
  onUpdate?: (stepId: string, updates: Partial<PipelineStep>) => void;
  /**
   * The saved Sync configurations a Sync step can run, as the extension
   * describes them; absent until it has.
   */
  syncConfigs?: readonly PipelineSyncConfigInfo[];
  className?: string;
}

/**
 * A step-type specific config field (labels are i18n keys): a plain input, a
 * choice among the connected orgs, a comma-separated list of API names, or the
 * checks a Pre-check can run.
 */
interface ConfigField {
  key: string;
  labelKey: string;
  type: 'text' | 'number' | 'boolean' | 'org' | 'list' | 'checks';
  /** For a number the step may leave unset: cleared, the key is removed rather than set to 0. */
  optional?: boolean;
  /** The bounds of a number, and the length of a text, the step accepts. */
  min?: number;
  max?: number;
  maxLength?: number;
  /** What an unset field stands for, shown in it. */
  placeholder?: string;
}

/**
 * Step-type specific config fields. Compare, Condition and Sync have sections
 * of their own (see below).
 */
const STEP_CONFIG_FIELDS: Partial<Record<PipelineStepType, ConfigField[]>> = {
  seed: [
    { key: 'objectName', labelKey: 'common.object', type: 'text' },
    { key: 'recordCount', labelKey: 'common.recordCountLabel', type: 'number' },
  ],
  // Who answers is whoever is at the VS Code window: the step asks for what
  // it says with its question, and how long it waits.
  approval: [
    {
      key: 'message',
      labelKey: 'automation.stepConfigApprovalMessage',
      type: 'text',
      maxLength: APPROVAL_MAX_MESSAGE_LENGTH,
    },
    {
      key: 'timeoutMinutes',
      labelKey: 'automation.stepConfigApprovalTimeout',
      type: 'number',
      optional: true,
      min: 1,
      max: APPROVAL_MAX_TIMEOUT_MINUTES,
      placeholder: String(APPROVAL_DEFAULT_TIMEOUT_MINUTES),
    },
  ],
  // What DataOps's Backup request takes: the org, and the objects it reads.
  backup: [
    { key: 'orgId', labelKey: 'automation.stepConfigOrg', type: 'org' },
    { key: 'objects', labelKey: 'automation.stepConfigObjects', type: 'list' },
  ],
  // The org, and which of the Monitor's health signals the step reads.
  precheck: [
    { key: 'orgId', labelKey: 'automation.stepConfigOrg', type: 'org' },
    { key: 'checks', labelKey: 'automation.stepConfigChecks', type: 'checks' },
  ],
  // A notification is shown in VS Code, to whoever runs the pipeline, so the
  // step asks for the text it shows and for no address to send it to.
  notification: [{ key: 'message', labelKey: 'automation.stepConfigMessage', type: 'text' }],
  delay: [{ key: 'seconds', labelKey: 'automation.stepConfigDelay', type: 'number' }],
  delete: [
    { key: 'objectName', labelKey: 'common.object', type: 'text' },
    { key: 'query', labelKey: 'common.whereClause', type: 'text' },
    { key: 'hardDelete', labelKey: 'automation.hardDelete', type: 'boolean' },
  ],
  anonymize: [{ key: 'templateId', labelKey: 'automation.stepConfigTemplate', type: 'text' }],
};

const INPUT_CLASS =
  'text-xs p-1.5 rounded-sm border border-(--sf-border,#3c3c3c) bg-(--sf-bg-input,#1e1e1e) text-(--sf-text-primary,#d4d4d4)';

/** The strings of `value` when it is a list, else none. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Props of {@link ListField}. */
interface ListFieldProps {
  label: string;
  testId: string;
  initial: string[];
  onChange: (items: string[]) => void;
}

/**
 * A comma-separated list of names. The text is kept as typed — a list read
 * back from the step on every keystroke would drop the comma just typed —
 * and each change writes the names it holds.
 */
const ListField: React.FC<ListFieldProps> = ({ label, testId, initial, onChange }) => {
  const [text, setText] = useState(initial.join(', '));
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-text-secondary">{label}</span>
      <input
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split(',')
              .map((name) => name.trim())
              .filter((name) => name !== ''),
          );
        }}
        className={INPUT_CLASS}
        data-testid={testId}
      />
    </label>
  );
};

/** Props of {@link OrgField}. */
interface OrgFieldProps {
  label: string;
  placeholder: string;
  testId: string;
  orgs: SalesforceOrg[];
  value: unknown;
  onChange: (orgId: string) => void;
}

/** A choice among the connected orgs, labelled as every other org picker labels them. */
const OrgField: React.FC<OrgFieldProps> = ({
  label,
  placeholder,
  testId,
  orgs,
  value,
  onChange,
}) => {
  const { t } = useTranslation();
  return (
    <Select
      label={label}
      placeholder={placeholder}
      options={orgs.map((org) => ({ value: org.id, label: orgOptionLabel(org, t) }))}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs"
      data-testid={testId}
    />
  );
};

/** Props of {@link ConditionEditor}. */
interface ConditionEditorProps {
  stepId: string;
  condition: PipelineCondition | undefined;
  onChange: (condition: PipelineCondition) => void;
}

/**
 * The test a Condition step makes, chosen among the values a run hands on:
 * how the previous step went, the differences a Compare found, a Pre-check's
 * readings. A condition a Marketplace template set that none of these writes
 * is shown as it stands, until another is chosen.
 */
const ConditionEditor: React.FC<ConditionEditorProps> = ({ stepId, condition, onChange }) => {
  const { t } = useTranslation();
  const read = kindOf(condition);
  const custom = condition !== undefined && read === undefined;
  const options = [
    ...(custom
      ? [
          {
            value: 'custom',
            label: t('automation.conditionKinds.custom', {
              field: condition.field,
              operator: condition.operator,
              value: String(condition.value),
            }),
          },
        ]
      : []),
    ...CONDITION_KINDS.map((kind) => ({
      value: kind,
      label: t(`automation.conditionKinds.${kind}`),
    })),
  ];
  const threshold = read?.threshold ?? 0;
  return (
    <>
      <Select
        label={t('automation.stepConfigCondition')}
        placeholder={t('automation.conditionChoose')}
        options={options}
        value={custom ? 'custom' : (read?.kind ?? '')}
        onChange={(e) => {
          const kind = CONDITION_KINDS.find((candidate) => candidate === e.target.value);
          if (kind) onChange(conditionFor(kind, threshold));
        }}
        className="text-xs"
        data-testid="config-condition-kind"
      />
      {read && takesThreshold(read.kind) && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-text-secondary">
            {t(`automation.conditionThreshold.${read.kind}`)}
          </span>
          <input
            // Remounted for another step, so the number is that step's.
            key={stepId}
            type="number"
            value={threshold}
            min={0}
            max={thresholdMax(read.kind)}
            onChange={(e) => onChange(conditionFor(read.kind, Number(e.target.value)))}
            className={INPUT_CLASS}
            data-testid="config-condition-threshold"
          />
        </label>
      )}
    </>
  );
};

/** Props of {@link SyncConfigField}. */
interface SyncConfigFieldProps {
  value: unknown;
  syncConfigs: readonly PipelineSyncConfigInfo[] | undefined;
  onChange: (configId: string) => void;
}

/**
 * The saved Sync configuration a Sync step runs, chosen among those the Sync
 * page saved. One the step names that is no longer saved stays chosen, and the
 * step is marked until another is picked.
 */
const SyncConfigField: React.FC<SyncConfigFieldProps> = ({ value, syncConfigs, onChange }) => {
  const { t } = useTranslation();
  const configs = syncConfigs ?? [];
  const chosen = typeof value === 'string' ? value : '';
  const options = configs.map((config) => ({ value: config.id, label: config.name }));
  if (chosen !== '' && !configs.some((config) => config.id === chosen)) {
    options.unshift({ value: chosen, label: t('automation.syncConfigGone') });
  }
  return (
    <>
      <Select
        label={t('automation.stepConfigSyncConfig')}
        placeholder={t('automation.syncConfigSelect')}
        options={options}
        value={chosen}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs"
        data-testid="config-configId"
      />
      {syncConfigs !== undefined && configs.length === 0 && (
        <p className="text-[10px] text-text-secondary" data-testid="config-sync-none">
          {t('automation.syncConfigNone')}
        </p>
      )}
    </>
  );
};

/**
 * Step configuration panel for editing step properties
 * including name, timeout, retries, continueOnError,
 * and step-type-specific configuration fields.
 */
export const StepConfigPanel: React.FC<StepConfigPanelProps> = ({
  step,
  onUpdate,
  syncConfigs,
  className,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const checksLabelId = useId();

  if (!step) {
    return (
      <div
        className={cn('text-xs text-center py-6 text-text-secondary', className)}
        data-testid="step-config-empty"
      >
        {t('automation.selectStep', 'Select a step to configure')}
      </div>
    );
  }

  const configFields = STEP_CONFIG_FIELDS[step.type] ?? [];
  // A step read back from storage may carry no config at all.
  const config: Record<string, unknown> = step.config ?? {};

  const handleUpdate = (updates: Partial<PipelineStep>) => {
    onUpdate?.(step.id, updates);
  };

  /** Set one key of the step's config; `undefined` removes it. */
  const handleConfigUpdate = (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...config, [key]: value };
    if (value === undefined) delete next[key];
    onUpdate?.(step.id, { config: next });
  };

  /** The checks a Pre-check holds that it can run; any other name is dropped on the next change. */
  const heldChecks = strings(config['checks']).filter((check) =>
    (PRECHECK_CHECKS as readonly string[]).includes(check),
  );

  const renderField = (field: ConfigField): React.ReactNode => {
    switch (field.type) {
      // A checkbox already carries its caption inside its own wrapping label,
      // so only the other field types need a caption of their own.
      case 'boolean':
        return (
          <label
            key={field.key}
            className="flex items-center gap-2 text-xs text-(--sf-text-primary,#d4d4d4)"
          >
            <input
              type="checkbox"
              checked={Boolean(config[field.key])}
              onChange={(e) => handleConfigUpdate(field.key, e.target.checked)}
              data-testid={`config-${field.key}`}
            />
            {t(field.labelKey)}
          </label>
        );
      case 'org':
        return (
          <OrgField
            key={field.key}
            label={t(field.labelKey)}
            placeholder={t('automation.selectOrg')}
            testId={`config-${field.key}`}
            orgs={orgs}
            value={config[field.key]}
            onChange={(orgId) => handleConfigUpdate(field.key, orgId)}
          />
        );
      case 'list':
        return (
          <ListField
            // Remounted for another step, so the text is that step's.
            key={`${step.id}-${field.key}`}
            label={t(field.labelKey)}
            testId={`config-${field.key}`}
            initial={strings(config[field.key])}
            onChange={(items) => handleConfigUpdate(field.key, items)}
          />
        );
      case 'checks':
        return (
          <div key={field.key} className="flex flex-col gap-1">
            <span id={checksLabelId} className="text-[10px] text-text-secondary">
              {t(field.labelKey)}
            </span>
            <div role="group" aria-labelledby={checksLabelId} className="flex flex-col gap-1">
              {PRECHECK_CHECKS.map((check) => (
                <label
                  key={check}
                  className="flex items-center gap-2 text-xs text-(--sf-text-primary,#d4d4d4)"
                >
                  <input
                    type="checkbox"
                    checked={heldChecks.includes(check)}
                    onChange={(e) =>
                      handleConfigUpdate(
                        field.key,
                        e.target.checked
                          ? [...heldChecks, check]
                          : heldChecks.filter((held) => held !== check),
                      )
                    }
                    data-testid={`config-check-${check}`}
                  />
                  {t(`automation.precheckChecks.${check}`)}
                </label>
              ))}
            </div>
          </div>
        );
      default:
        return (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-[10px] text-text-secondary">{t(field.labelKey)}</span>
            <input
              type={field.type}
              value={String(config[field.key] ?? '')}
              maxLength={
                field.maxLength ??
                (step.type === 'notification' && field.key === 'message'
                  ? MAX_NOTIFICATION_LENGTH
                  : undefined)
              }
              min={field.min}
              max={field.max}
              placeholder={field.placeholder}
              onChange={(e) =>
                handleConfigUpdate(
                  field.key,
                  field.type !== 'number'
                    ? e.target.value
                    : field.optional && e.target.value === ''
                      ? undefined
                      : Number(e.target.value),
                )
              }
              className={INPUT_CLASS}
              data-testid={`config-${field.key}`}
            />
          </label>
        );
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-3 p-3 border border-(--sf-border,#3c3c3c) rounded-sm',
        className,
      )}
      data-testid="step-config-panel"
    >
      {/* Step header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-(--sf-text-primary,#d4d4d4)">
          {t('automation.stepConfig', 'Step Configuration')}
        </span>
        <Badge variant="default">{step.type}</Badge>
      </div>

      {/* Step name */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-text-secondary">
          {t('automation.stepName', 'Step Name')}
        </span>
        <input
          type="text"
          value={step.name}
          onChange={(e) => handleUpdate({ name: e.target.value })}
          className={INPUT_CLASS}
          data-testid="step-name-input"
        />
      </label>

      {/* Timeout */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-text-secondary">
          {t('automation.timeout', 'Timeout (ms)')}
        </span>
        <input
          type="number"
          value={step.timeout ?? ''}
          onChange={(e) =>
            handleUpdate({ timeout: e.target.value ? Number(e.target.value) : undefined })
          }
          placeholder="300"
          min={0}
          max={MAX_STEP_TIMEOUT_MS}
          className={INPUT_CLASS}
          data-testid="step-timeout-input"
        />
      </label>

      {/* Retries */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-text-secondary">
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
          className={INPUT_CLASS}
          data-testid="step-retries-input"
        />
      </label>

      {/* Continue on error */}
      <label className="flex items-center gap-2 text-xs text-(--sf-text-primary,#d4d4d4)">
        <input
          type="checkbox"
          checked={step.continueOnError}
          onChange={(e) => handleUpdate({ continueOnError: e.target.checked })}
          data-testid="step-continue-error"
        />
        {t('automation.continueOnError', 'Continue on error')}
      </label>

      {/* Step-type-specific config fields */}
      {(configFields.length > 0 ||
        step.type === 'compare' ||
        step.type === 'condition' ||
        step.type === 'sync') && (
        <div
          className="flex flex-col gap-2 mt-1 pt-2 border-t border-(--sf-border,#3c3c3c)"
          data-testid="step-type-config"
        >
          <span className="text-[10px] font-semibold text-text-secondary uppercase">
            {t('automation.typeConfig', 'Type-specific config')}
          </span>
          {configFields.map(renderField)}
          {step.type === 'condition' && (
            <ConditionEditor
              stepId={step.id}
              condition={step.condition}
              onChange={(condition) => handleUpdate({ condition })}
            />
          )}
          {step.type === 'sync' && (
            <SyncConfigField
              value={config['configId']}
              syncConfigs={syncConfigs}
              onChange={(configId) => handleConfigUpdate('configId', configId)}
            />
          )}
          {/* What the Compare page's Run takes: two orgs and the metadata
              types to diff, chosen with the page's own controls. */}
          {step.type === 'compare' && (
            <>
              <OrgField
                label={t('compare.source')}
                placeholder={t('compare.selectSource')}
                testId="config-sourceOrgId"
                orgs={orgs}
                value={config['sourceOrgId']}
                onChange={(orgId) => handleConfigUpdate('sourceOrgId', orgId)}
              />
              <OrgField
                label={t('compare.target')}
                placeholder={t('compare.selectTarget')}
                testId="config-targetOrgId"
                orgs={orgs}
                value={config['targetOrgId']}
                onChange={(orgId) => handleConfigUpdate('targetOrgId', orgId)}
              />
              {typeof config['sourceOrgId'] === 'string' &&
                config['sourceOrgId'] !== '' &&
                config['sourceOrgId'] === config['targetOrgId'] && (
                  <p className="text-xs text-status-warning" data-testid="config-same-org">
                    {t('compare.sameOrgWarning')}
                  </p>
                )}
              <CategorySelector
                selected={strings(config['types']) as MetadataComponentType[]}
                onChange={(types) => handleConfigUpdate('types', types)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};
