import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CheckpointListEntry,
  MetadataComponentType,
  OrgCheckpoint,
  PipelineCondition,
  PipelineMaskingTemplateInfo,
  PipelineRewindGrantResponse,
  PipelineRewindStepInfo,
  PipelineSeedTemplateInfo,
  PipelineStep,
  PipelineStepType,
  PipelineSyncConfigInfo,
  SalesforceOrg,
} from '@sandforge/shared';
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  APPROVAL_MAX_TIMEOUT_MINUTES,
  CHECKPOINT_STEP_DEFAULT_KEEP_DAYS,
  CHECKPOINT_STEP_MAX_KEEP_DAYS,
} from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { dateTimeFormat, formatNumber, formatStoredDate } from '../../utils/formatters';
import { cn } from '../../theme';
import { useOrgStore } from '../../stores/useOrgStore';
import { orgOptionLabel } from '../../utils/orgFormatters';
import { CategorySelector } from '../Compare/CategorySelector';
import { MAX_NOTIFICATION_LENGTH, MAX_STEP_TIMEOUT_MS, PRECHECK_CHECKS } from './stepRunnability';
import type { StepBlocker } from './stepRunnability';
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
  /** The Seed templates a Seed step can run, as the extension describes them; absent until it has. */
  seedTemplates?: readonly PipelineSeedTemplateInfo[];
  /** The masking templates an Anonymize step can run; absent until described. */
  maskingTemplates?: readonly PipelineMaskingTemplateInfo[];
  /** What a Rewind step's confirmation reads and does (see {@link RewindConfirmation}). */
  rewind?: RewindConfirmation;
  className?: string;
}

/**
 * What a Rewind step's panel says of its confirmation, and what it asks for:
 * the Rewind steps as the extension sees them, the step's blocker, the
 * preview that a confirmation is typed below, and taking one back.
 */
export interface RewindConfirmation {
  /** The Rewind steps of the pipeline as saved; absent until described, or for one never saved. */
  steps?: readonly PipelineRewindStepInfo[];
  /** The steps of the pipeline as last saved; absent for one never saved. */
  savedSteps?: readonly PipelineStep[];
  /** Why the selected step cannot run, as the Run button reads it. */
  blocker?: StepBlocker;
  /** Open the step's preview, below which its confirmation is typed. */
  onPreview?: (stepId: string, checkpoint: OrgCheckpoint) => void;
  /** Take back the step's confirmation. */
  onRevoke?: (stepId: string) => void;
  /** The extension's answer to the last confirmation sent. */
  answer?: PipelineRewindGrantResponse['payload'] | null;
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
  // The org, then the template the Seed page saved or SandForge ships, chosen below.
  seed: [{ key: 'orgId', labelKey: 'automation.stepConfigOrg', type: 'org' }],
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
  // The org, then the masking template, its object and condition, chosen below.
  anonymize: [{ key: 'orgId', labelKey: 'automation.stepConfigOrg', type: 'org' }],
  // A take as the Take page asks one: the org, every object or those picked.
  checkpoint: [{ key: 'orgId', labelKey: 'automation.stepConfigOrg', type: 'org' }],
  // The org, then the checkpoint, its bounds and its confirmation, below.
  rewind: [{ key: 'orgId', labelKey: 'automation.stepConfigOrg', type: 'org' }],
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

/** Props of {@link TemplateField}. */
interface TemplateFieldProps {
  label: string;
  placeholder: string;
  testId: string;
  value: unknown;
  /** The templates as the extension describes them; absent until it has. */
  templates: ReadonlyArray<{ id: string; name: string; builtIn: boolean }> | undefined;
  onChange: (templateId: string) => void;
}

/**
 * A template a step runs with, chosen among those the extension describes:
 * those its page saved, and those SandForge ships, whose names are the
 * page's own words. One the step names that is no longer there stays
 * chosen, and the step is marked until another is picked.
 */
const TemplateField: React.FC<TemplateFieldProps> = ({
  label,
  placeholder,
  testId,
  value,
  templates,
  onChange,
}) => {
  const { t } = useTranslation();
  const chosen = typeof value === 'string' ? value : '';
  const options = (templates ?? []).map((template) => ({
    value: template.id,
    label: template.builtIn ? t(template.name, { defaultValue: template.name }) : template.name,
  }));
  if (chosen !== '' && !options.some((option) => option.value === chosen)) {
    options.unshift({ value: chosen, label: t('automation.templateGone') });
  }
  return (
    <Select
      label={label}
      placeholder={placeholder}
      options={options}
      value={chosen}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs"
      data-testid={testId}
    />
  );
};

/** A note under a field, in the panel's small type. */
const Note: React.FC<{ testId: string; children: React.ReactNode }> = ({ testId, children }) => (
  <p className="text-[10px] text-text-secondary" data-testid={testId}>
    {children}
  </p>
);

/** Props of {@link NumberField}. */
interface NumberFieldProps {
  label: string;
  testId: string;
  value: unknown;
  min: number;
  max?: number;
  placeholder?: string;
  /** Cleared, the key is removed rather than set to 0. */
  onChange: (value: number | undefined) => void;
}

/** A whole number a step reads, which the step may leave unset. */
const NumberField: React.FC<NumberFieldProps> = ({
  label,
  testId,
  value,
  min,
  max,
  placeholder,
  onChange,
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-[10px] text-text-secondary">{label}</span>
    <input
      type="number"
      value={typeof value === 'number' ? value : ''}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className={INPUT_CLASS}
      data-testid={testId}
    />
  </label>
);

/** Props of {@link CheckField}. */
interface CheckFieldProps {
  label: string;
  testId: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A setting a step reads as on or off, its caption in its own label. */
const CheckField: React.FC<CheckFieldProps> = ({ label, testId, checked, onChange }) => (
  <label className="flex items-center gap-2 text-xs text-(--sf-text-primary,#d4d4d4)">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      data-testid={testId}
    />
    {label}
  </label>
);

/** The acceptances a Rewind step gives, each off unless the step says yes, as the command line's flags. */
const REWIND_ACCEPTANCES = [
  'acceptAutomation',
  'acceptNoUndo',
  'acceptRecreate',
  'acceptOutside',
  'acceptUnseen',
] as const;

/** Props of {@link AnonymizeFields}. */
interface AnonymizeFieldsProps {
  stepId: string;
  config: Record<string, unknown>;
  templates: readonly PipelineMaskingTemplateInfo[] | undefined;
  onConfig: (key: string, value: unknown) => void;
}

/**
 * An Anonymize step's fields: the masking template, then one of the objects
 * its rules name — every one of them when none is chosen — and, with an
 * object, a SOQL condition its rows are held to, as on the DataOps page.
 */
const AnonymizeFields: React.FC<AnonymizeFieldsProps> = ({
  stepId,
  config,
  templates,
  onConfig,
}) => {
  const { t } = useTranslation();
  const templateId = typeof config['templateId'] === 'string' ? config['templateId'] : '';
  const object = typeof config['object'] === 'string' ? config['object'] : '';
  const objects = templates?.find((template) => template.id === templateId)?.objects ?? [];
  const objectOptions = [
    { value: '', label: t('automation.maskingEveryObject') },
    ...objects.map((name) => ({ value: name, label: name })),
  ];
  if (object !== '' && !objects.includes(object)) {
    objectOptions.push({ value: object, label: object });
  }
  return (
    <>
      <TemplateField
        label={t('automation.stepConfigMaskingTemplate')}
        placeholder={t('automation.maskingTemplateSelect')}
        testId="config-masking-templateId"
        value={config['templateId']}
        templates={templates}
        onChange={(id) => onConfig('templateId', id)}
      />
      <Select
        label={t('automation.stepConfigMaskingObject')}
        options={objectOptions}
        value={object}
        onChange={(e) => {
          onConfig('object', e.target.value === '' ? undefined : e.target.value);
          // A condition holds the rows of the object it was written for.
          if (e.target.value === '') onConfig('where', undefined);
        }}
        className="text-xs"
        data-testid="config-masking-object"
      />
      {object !== '' && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-text-secondary">
            {t('automation.stepConfigMaskingWhere')}
          </span>
          <input
            key={`${stepId}-where`}
            type="text"
            value={typeof config['where'] === 'string' ? config['where'] : ''}
            placeholder={t('automation.maskingWherePlaceholder')}
            onChange={(e) => onConfig('where', e.target.value === '' ? undefined : e.target.value)}
            className={INPUT_CLASS}
            data-testid="config-masking-where"
          />
        </label>
      )}
      <Note testId="config-masking-note">{t('automation.maskingStepNote')}</Note>
    </>
  );
};

/** Props of {@link CheckpointFields}. */
interface CheckpointFieldsProps {
  stepId: string;
  config: Record<string, unknown>;
  onConfig: (key: string, value: unknown) => void;
}

/**
 * A Checkpoint step's fields, as the Take page asks a take: every object
 * people work in or those picked, those left out, the name, how long it is
 * kept, and the most records it holds.
 */
const CheckpointFields: React.FC<CheckpointFieldsProps> = ({ stepId, config, onConfig }) => {
  const { t } = useTranslation();
  const mode = config['mode'] === 'picked' ? 'picked' : 'everything';
  return (
    <>
      <Select
        label={t('automation.stepConfigCheckpointMode')}
        options={[
          { value: 'everything', label: t('automation.checkpointModeEverything') },
          { value: 'picked', label: t('automation.checkpointModePicked') },
        ]}
        value={mode}
        onChange={(e) => {
          onConfig('mode', e.target.value);
          if (e.target.value !== 'picked') onConfig('objects', undefined);
        }}
        className="text-xs"
        data-testid="config-checkpoint-mode"
      />
      {mode === 'picked' && (
        <ListField
          key={`${stepId}-objects`}
          label={t('automation.stepConfigCheckpointObjects')}
          testId="config-checkpoint-objects"
          initial={strings(config['objects'])}
          onChange={(items) => onConfig('objects', items.length > 0 ? items : undefined)}
        />
      )}
      <ListField
        key={`${stepId}-excluded`}
        label={t('automation.stepConfigCheckpointExcluded')}
        testId="config-checkpoint-excluded"
        initial={strings(config['excluded'])}
        onChange={(items) => onConfig('excluded', items.length > 0 ? items : undefined)}
      />
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-text-secondary">
          {t('automation.stepConfigCheckpointName')}
        </span>
        <input
          key={`${stepId}-name`}
          type="text"
          value={typeof config['name'] === 'string' ? config['name'] : ''}
          placeholder={t('automation.checkpointNamePlaceholder')}
          onChange={(e) => onConfig('name', e.target.value === '' ? undefined : e.target.value)}
          className={INPUT_CLASS}
          data-testid="config-checkpoint-name"
        />
      </label>
      <NumberField
        label={t('automation.stepConfigCheckpointKeepDays')}
        testId="config-checkpoint-keepDays"
        value={config['keepDays']}
        min={0}
        max={CHECKPOINT_STEP_MAX_KEEP_DAYS}
        placeholder={String(CHECKPOINT_STEP_DEFAULT_KEEP_DAYS)}
        onChange={(value) => onConfig('keepDays', value)}
      />
      <Note testId="config-checkpoint-note">{t('automation.checkpointStepNote')}</Note>
      <NumberField
        label={t('automation.stepConfigCheckpointMaxTotal')}
        testId="config-checkpoint-maxTotal"
        value={config['maxTotal']}
        min={1}
        placeholder="500000"
        onChange={(value) => onConfig('maxTotal', value)}
      />
    </>
  );
};

/** Props of {@link RewindFields}. */
interface RewindFieldsProps {
  step: PipelineStep;
  config: Record<string, unknown>;
  orgs: SalesforceOrg[];
  rewind: RewindConfirmation | undefined;
  onConfig: (key: string, value: unknown) => void;
}

/**
 * A Rewind step's fields: the checkpoint of its org kept on this machine,
 * the objects it is limited to, its bound on records, its refusal while
 * people are at work, each acceptance — and its confirmation, typed once
 * below its preview, which a save that changes any of them takes back.
 */
const RewindFields: React.FC<RewindFieldsProps> = ({ step, config, orgs, rewind, onConfig }) => {
  const { t } = useTranslation();
  const orgId = typeof config['orgId'] === 'string' ? config['orgId'] : '';
  const org = orgs.find((candidate) => candidate.id === orgId);
  const list = useBridgeQuery<{ checkpoints: CheckpointListEntry[] }>(
    'checkpoint:list',
    orgId !== '' ? { orgId } : undefined,
    { skip: orgId === '' },
  );
  const entries = (list.data?.checkpoints ?? []).filter(
    (entry): entry is CheckpointListEntry & { checkpoint: OrgCheckpoint } =>
      entry.valid && entry.checkpoint !== undefined,
  );
  const chosen = typeof config['checkpointId'] === 'string' ? config['checkpointId'] : '';
  const options = entries.map((entry) => ({
    value: entry.checkpointId,
    label: t('automation.rewindCheckpointOption', {
      name: entry.checkpoint.name,
      date:
        formatStoredDate(entry.checkpoint.takenAt, (d) =>
          dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(d),
        ) ?? t('common.dateUnknown'),
    }),
  }));
  if (chosen !== '' && !options.some((option) => option.value === chosen)) {
    options.unshift({ value: chosen, label: t('automation.rewindCheckpointGone') });
  }
  const checkpoint = entries.find((entry) => entry.checkpointId === chosen)?.checkpoint;
  const info = rewind?.steps?.find((candidate) => candidate.stepId === step.id);
  const confirmed = info?.granted?.digestMatches === true;
  const maxRecords = typeof config['maxRecords'] === 'number' ? config['maxRecords'] : undefined;
  // Confirmed for what is saved, and only what is saved: an edit here, or a
  // step not saved yet, is saved first.
  const canConfirm =
    rewind?.onPreview !== undefined &&
    checkpoint !== undefined &&
    org !== undefined &&
    rewind.blocker !== 'rewindNotSaved' &&
    rewind.blocker !== 'rewindNeedsCheckpoint' &&
    rewind.blocker !== 'rewindNeedsMaxRecords' &&
    rewind.blocker !== 'rewindConfigInvalid' &&
    rewind.blocker !== 'writeNoRetries';
  const refused =
    rewind?.answer && !rewind.answer.granted && rewind.answer.stepId === step.id
      ? rewind.answer
      : undefined;
  let status: string;
  if (confirmed && info?.granted) {
    status = t('automation.rewindConfirmedOn', {
      date:
        formatStoredDate(info.granted.at, (d) =>
          dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(d),
        ) ?? t('common.dateUnknown'),
      org: org ? org.alias || org.username : orgId,
      name: checkpoint?.name ?? chosen,
      max: formatNumber(maxRecords ?? 0),
    });
  } else if (rewind?.blocker === 'rewindNotSaved') {
    status = t('automation.rewindSaveFirst');
  } else if (info?.granted && !info.granted.digestMatches) {
    status = t('automation.runnability.rewindChangedSinceConfirmed');
  } else {
    status = t('automation.rewindNotConfirmedNote');
  }
  return (
    <>
      <Select
        label={t('automation.stepConfigRewindCheckpoint')}
        placeholder={t('automation.rewindCheckpointSelect')}
        options={options}
        value={chosen}
        onChange={(e) => onConfig('checkpointId', e.target.value)}
        className="text-xs"
        data-testid="config-checkpointId"
      />
      {orgId !== '' && list.data !== null && entries.length === 0 && (
        <Note testId="config-rewind-no-checkpoint">{t('automation.rewindNoCheckpoint')}</Note>
      )}
      <ListField
        key={`${step.id}-objects`}
        label={t('automation.stepConfigRewindObjects')}
        testId="config-rewind-objects"
        initial={strings(config['objects'])}
        onChange={(items) => onConfig('objects', items.length > 0 ? items : undefined)}
      />
      <NumberField
        label={t('automation.stepConfigRewindMaxRecords')}
        testId="config-maxRecords"
        value={config['maxRecords']}
        min={1}
        onChange={(value) => onConfig('maxRecords', value)}
      />
      <CheckField
        label={t('automation.stepConfigRewindRefuseWhenActive')}
        testId="config-refuseWhenActive"
        checked={config['refuseWhenActive'] !== false}
        onChange={(checked) => onConfig('refuseWhenActive', checked)}
      />
      <Note testId="config-refuseWhenActive-note">
        {t('automation.rewindRefuseWhenActiveNote')}
      </Note>
      {REWIND_ACCEPTANCES.map((key) => (
        <CheckField
          key={key}
          label={t(`automation.rewindAccept.${key}`)}
          testId={`config-${key}`}
          checked={config[key] === true}
          onChange={(checked) => onConfig(key, checked)}
        />
      ))}
      <div
        className="flex flex-col gap-2 mt-1 pt-2 border-t border-(--sf-border,#3c3c3c)"
        data-testid="rewind-confirmation"
      >
        <p
          className={cn('text-xs', confirmed ? 'text-status-success' : 'text-status-warning')}
          data-testid="rewind-confirmation-status"
        >
          {status}
        </p>
        {refused && (
          <p role="alert" className="text-xs text-status-error" data-testid="rewind-grant-refused">
            {t(`automation.rewindGrantRefused.${refused.code}`)}
          </p>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={!canConfirm}
          onClick={() => {
            if (canConfirm && checkpoint) rewind?.onPreview?.(step.id, checkpoint);
          }}
          data-testid="rewind-confirm"
        >
          {t('automation.rewindConfirm')}
        </Button>
        {info?.granted && rewind?.onRevoke && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => rewind.onRevoke?.(step.id)}
            data-testid="rewind-revoke"
          >
            {t('automation.rewindRevoke')}
          </Button>
        )}
      </div>
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
  seedTemplates,
  maskingTemplates,
  rewind,
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
          {step.type === 'seed' && (
            <>
              <TemplateField
                label={t('automation.stepConfigSeedTemplate')}
                placeholder={t('automation.seedTemplateSelect')}
                testId="config-seed-templateId"
                value={config['templateId']}
                templates={seedTemplates}
                onChange={(templateId) => handleConfigUpdate('templateId', templateId)}
              />
              <Note testId="config-seed-note">{t('automation.seedStepNote')}</Note>
            </>
          )}
          {step.type === 'anonymize' && (
            <AnonymizeFields
              stepId={step.id}
              config={config}
              templates={maskingTemplates}
              onConfig={handleConfigUpdate}
            />
          )}
          {step.type === 'checkpoint' && (
            <CheckpointFields stepId={step.id} config={config} onConfig={handleConfigUpdate} />
          )}
          {step.type === 'rewind' && (
            <RewindFields
              step={step}
              config={config}
              orgs={orgs}
              rewind={rewind}
              onConfig={handleConfigUpdate}
            />
          )}
          {/* What the Compare page's Run takes: two orgs and the metadata
              types to diff, chosen with the page's own controls. */}
          {step.type === 'compare' && (
            <>
              <OrgField
                label={t('compareParts.source')}
                placeholder={t('compareParts.selectSource')}
                testId="config-sourceOrgId"
                orgs={orgs}
                value={config['sourceOrgId']}
                onChange={(orgId) => handleConfigUpdate('sourceOrgId', orgId)}
              />
              <OrgField
                label={t('compareParts.target')}
                placeholder={t('compareParts.selectTarget')}
                testId="config-targetOrgId"
                orgs={orgs}
                value={config['targetOrgId']}
                onChange={(orgId) => handleConfigUpdate('targetOrgId', orgId)}
              />
              {typeof config['sourceOrgId'] === 'string' &&
                config['sourceOrgId'] !== '' &&
                config['sourceOrgId'] === config['targetOrgId'] && (
                  <p className="text-xs text-status-warning" data-testid="config-same-org">
                    {t('compareParts.sameOrgWarning')}
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
