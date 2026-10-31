import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TransformRule, TransformRuleType } from '@sandforge/shared';
import { cn } from '../../theme';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Icon } from '../../components/ui/Icon';
import type { FieldInfo } from './FieldMappingCanvas';

/**
 * A rule of the Sync wizard: the rule a run carries, and the object it was
 * made for, which the page keeps to send it with that object alone. A rule of
 * a draft saved before rules named a field has neither field nor object: it
 * runs on every field of every object of the run, as it did then.
 */
export interface SyncTransformRule extends TransformRule {
  objectApiName?: string;
}

/** TransformBuilder component props. */
export interface TransformBuilderProps {
  /** Every rule of the wizard; the object's own are shown, and those that name no field. */
  rules: SyncTransformRule[];
  /** The objects of the run, to choose whose rules to show. */
  objects: string[];
  /** The object whose rules are shown, and whose fields a new rule may name. */
  objectApiName: string;
  onObjectChange: (objectApiName: string) => void;
  /** The object's fields in the target, as its describe gives them. */
  fields: FieldInfo[];
  fieldsLoading?: boolean;
  /**
   * The External ID the object's write matches on. The run never changes it,
   * nor Id, so neither is offered.
   */
  matchField?: string;
  onAddRule: (type: TransformRuleType, field: string) => void;
  onRemoveRule: (index: number) => void;
  onChangeConfig: (index: number, key: string, value: string) => void;
  className?: string;
}

/**
 * The rules a new one may be. Map Value is not among them: it takes a table
 * of replacements this page has no box for, and a rule of it changed nothing.
 * A configuration imported from SFDMU carries its value mappings as rules of
 * that type, each naming its field.
 */
const TRANSFORM_TYPES: TransformRuleType[] = [
  'uppercase',
  'lowercase',
  'trim',
  'truncate',
  'prefix',
  'suffix',
  'replace',
  'regex_replace',
  'default_value',
  'format_date',
  'format_number',
  'custom_formula',
];

const CONFIG_FIELDS: Partial<Record<TransformRuleType, string[]>> = {
  truncate: ['length'],
  prefix: ['prefix'],
  suffix: ['suffix'],
  replace: ['search', 'replace'],
  regex_replace: ['regex', 'replace'],
  default_value: ['defaultValue'],
  format_date: ['dateFormat'],
  format_number: ['numberFormat'],
  custom_formula: ['formula'],
};

/**
 * What a formula looks like, in the token the run reads: code, the same in
 * every language, so it is no part of the translated label.
 */
const FORMULA_EXAMPLE = 'VALUE * 2';

/** Field types, as a describe names them, that hold text. */
const TEXT_TYPES = new Set([
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'picklist',
  'multipicklist',
  'combobox',
  'encryptedstring',
]);
const DATE_TYPES = new Set(['date', 'datetime']);
const NUMBER_TYPES = new Set(['double', 'int', 'long', 'currency', 'percent']);

/**
 * Whether a rule of `type` can change `field`. A text rule leaves any other
 * value as read, so a number or a lookup offered for it would change nothing;
 * a checkbox is never empty, so it takes no default.
 */
function ruleTakes(type: TransformRuleType, field: FieldInfo): boolean {
  switch (type) {
    case 'format_date':
      return DATE_TYPES.has(field.type);
    case 'format_number':
    case 'custom_formula':
      return NUMBER_TYPES.has(field.type);
    case 'default_value':
      return field.type !== 'boolean';
    default:
      return TEXT_TYPES.has(field.type);
  }
}

/** Transform rule builder UI: the rules of one object, each on the field it names. */
export const TransformBuilder: React.FC<TransformBuilderProps> = ({
  rules,
  objects,
  objectApiName,
  onObjectChange,
  fields,
  fieldsLoading = false,
  matchField,
  onAddRule,
  onRemoveRule,
  onChangeConfig,
  className,
}) => {
  const { t } = useTranslation();
  const [selectedType, setSelectedType] = React.useState<TransformRuleType>('uppercase');
  const [selectedField, setSelectedField] = React.useState('');

  const shown = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.objectApiName === undefined || rule.objectApiName === objectApiName);
  const everyField = shown.some(({ rule }) => rule.field === undefined);

  const unchangeable = new Set(['id', (matchField ?? '').toLowerCase()]);
  const offered = fields.filter(
    (f) => !unchangeable.has(f.apiName.toLowerCase()) && ruleTakes(selectedType, f),
  );
  // A field the rule picked next cannot change is not kept as the choice.
  const field = offered.some((f) => f.apiName === selectedField) ? selectedField : '';

  const typeOptions = TRANSFORM_TYPES.map((tt) => ({
    value: tt,
    label: t(`sync.transformTypes.${tt}`),
  }));
  const fieldOptions = offered.map((f) => ({
    value: f.apiName,
    label: f.label && f.label !== f.apiName ? `${f.label} (${f.apiName})` : f.apiName,
  }));

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="transform-builder">
      {objects.length > 1 && (
        <div className="max-w-xs">
          <Select
            label={t('sync.transformForObject')}
            options={objects.map((name) => ({ value: name, label: name }))}
            value={objectApiName}
            onChange={(e) => onObjectChange(e.target.value)}
            data-testid="transform-object"
          />
        </div>
      )}

      <p className="text-xs text-text-secondary" data-testid="transform-intro">
        {t('sync.transformIntro', { object: objectApiName })}
      </p>

      <span className="text-xs font-medium text-text-primary">
        {t('sync.transforms')} ({shown.length})
      </span>

      {everyField && (
        <p className="text-xs text-text-primary" data-testid="transform-every-field-note">
          {t('sync.transformEveryFieldNote')}
        </p>
      )}

      {/* Existing rules */}
      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {shown.map(({ rule, index }) => {
          const configKeys = CONFIG_FIELDS[rule.type] ?? [];
          const ruleName = t(`sync.transformTypes.${rule.type}`);
          const removeLabel =
            rule.field === undefined
              ? t('sync.transformRemoveEveryField', { rule: ruleName })
              : t('sync.transformRemove', { rule: ruleName, field: rule.field });
          return (
            <div
              key={index}
              className={cn(
                'flex flex-wrap items-end gap-2 px-2 py-1.5 rounded-sm text-xs',
                'border border-(--sf-border)',
              )}
              data-testid={`transform-${index}`}
            >
              <div className="flex items-center gap-2 self-center">
                {rule.field === undefined ? (
                  <Badge variant="warning" data-testid={`transform-${index}-every-field`}>
                    {t('sync.transformEveryField')}
                  </Badge>
                ) : (
                  <span
                    className="font-mono text-text-primary"
                    data-testid={`transform-${index}-field`}
                  >
                    {rule.field}
                  </span>
                )}
                <Badge variant="default">{ruleName}</Badge>
              </div>
              {configKeys.map((key) => (
                <div key={key} className="w-36">
                  <Input
                    id={`transform-${index}-${key}`}
                    label={t(`sync.transformConfig.${key}`, { example: FORMULA_EXAMPLE })}
                    value={String((rule.config as Record<string, unknown>)[key] ?? '')}
                    onChange={(e) => onChangeConfig(index, key, e.target.value)}
                  />
                </div>
              ))}
              <button
                type="button"
                className="ml-auto self-center flex items-center justify-center rounded-sm p-1 text-status-error hover:bg-(--sf-bg-hover)"
                onClick={() => onRemoveRule(index)}
                data-testid={`remove-transform-${index}`}
                aria-label={removeLabel}
                title={removeLabel}
              >
                <Icon name="trash" className="text-sm" />
              </button>
            </div>
          );
        })}
      </div>

      {shown.length === 0 && (
        <p className="text-xs text-center text-text-secondary py-2" data-testid="transform-none">
          {t('sync.transformNone', { object: objectApiName })}
        </p>
      )}

      {/* Add new rule: on a field of the object, never on every field. */}
      <div className="flex flex-wrap items-end gap-2" data-testid="add-transform-row">
        <div className="min-w-48 flex-1">
          <Select
            label={t('sync.transformField')}
            options={fieldOptions}
            placeholder={
              fieldsLoading ? t('sync.transformFieldsLoading') : t('sync.transformChooseField')
            }
            value={field}
            onChange={(e) => setSelectedField(e.target.value)}
            disabled={fieldsLoading || fieldOptions.length === 0}
            data-testid="add-transform-field"
          />
        </div>
        <div className="min-w-40 flex-1">
          <Select
            label={t('sync.transformRule')}
            options={typeOptions}
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as TransformRuleType)}
            data-testid="add-transform-type"
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            onAddRule(selectedType, field);
            setSelectedField('');
          }}
          disabled={field === '' || fieldsLoading}
          data-testid="add-transform-btn"
        >
          {t('sync.transformAdd')}
        </Button>
      </div>
      {!fieldsLoading && fieldOptions.length === 0 && (
        <p className="text-xs text-text-secondary" data-testid="transform-no-field">
          {t('sync.transformNoField', {
            object: objectApiName,
            rule: t(`sync.transformTypes.${selectedType}`),
          })}
        </p>
      )}
    </div>
  );
};
