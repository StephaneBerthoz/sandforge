import React, { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldRuleType, SeedRecordTypeOption } from '@sandforge/shared';
import {
  SUPPORTED_FAKER_METHODS,
  acceptsGeneratedSentence,
  resolveFakerMethod,
} from '@sandforge/shared';
import { Select } from '../../components/ui/Select';
import type { SelectOption } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Accordion } from '../../components/ui/Accordion';
import { VirtualList } from '../../components/ui/VirtualList';
import { cn } from '../../theme';

/** Field configuration for the UI. */
export interface FieldConfig {
  fieldApiName: string;
  label: string;
  type: string;
  required: boolean;
  ruleType: FieldRuleType;
  config: Record<string, unknown>;
  /**
   * The values the org declares for a picklist field, kept beside the rule so
   * that coming back to a random pick after another rule type restores them:
   * a random pick with no values is refused before the first insert.
   */
  picklistValues?: string[];
  /**
   * The objects a lookup points at, as the org describes them, kept beside the
   * rule for the same reason: a relation can fill the lookup whatever rule the
   * field carries by then.
   */
  referenceTo?: string[];
  /**
   * Whether the user changed the field's rule or its value on this step, which
   * "Set by me" lists. The describe's default and a persona's pattern set
   * none: they are what the step opened on.
   */
  setByUser?: true;
}

/** Per-object field configuration. */
export interface ObjectFieldConfig {
  objectApiName: string;
  objectLabel: string;
  fields: FieldConfig[];
  /** The record types the target offers the user on the object, a person account's marked. */
  recordTypes?: SeedRecordTypeOption[];
}

/** Step3 props. */
export interface Step3ConfigureFieldsProps {
  objectConfigs: ObjectFieldConfig[];
  onChangeRule: (objectApiName: string, fieldApiName: string, ruleType: FieldRuleType) => void;
  onChangeConfig: (objectApiName: string, fieldApiName: string, key: string, value: string) => void;
}

/** Threshold above which objects are grouped by category with search. */
const GROUPING_THRESHOLD = 20;

const RULE_TYPE_OPTIONS: { value: FieldRuleType; labelKey: string }[] = [
  { value: 'static', labelKey: 'seed.fieldRules.static' },
  { value: 'random', labelKey: 'seed.fieldRules.random' },
  { value: 'sequence', labelKey: 'seed.fieldRules.sequence' },
  { value: 'formula', labelKey: 'seed.fieldRules.formula' },
  { value: 'reference', labelKey: 'seed.fieldRules.reference' },
  { value: 'picklist_random', labelKey: 'seed.fieldRules.picklist_random' },
  { value: 'ai_generate', labelKey: 'seed.fieldRules.ai_generate' },
  { value: 'faker', labelKey: 'seed.fieldRules.faker' },
  { value: 'regex', labelKey: 'seed.fieldRules.regex' },
  { value: 'from_csv', labelKey: 'seed.fieldRules.from_csv' },
];

/** The methods SandForge generates, listed under the identifiers a rule stores. */
const FAKER_METHOD_OPTIONS: SelectOption[] = SUPPORTED_FAKER_METHODS.map((method) => ({
  value: method,
  label: method,
}));

/**
 * Options and value of a faker method picker. The method was free text, so a
 * typo or a faker.js name nothing generates reached the run. A stored
 * faker.js spelling shows the method it resolves to; a method nothing
 * generates stays listed, disabled, so the field the run refuses is visible.
 */
function fakerMethodSelection(stored: unknown): { options: SelectOption[]; value: string } {
  const method = typeof stored === 'string' ? stored : '';
  if (method === '') return { options: FAKER_METHOD_OPTIONS, value: '' };
  const resolved = resolveFakerMethod(method);
  if (resolved) return { options: FAKER_METHOD_OPTIONS, value: resolved };
  return {
    options: [{ value: method, label: method, disabled: true }, ...FAKER_METHOD_OPTIONS],
    value: method,
  };
}

/**
 * Rule types a field row offers. AI generation writes text, so it is offered
 * only on fields that hold text; the run refuses it on any other. A field that
 * already carries it keeps it listed, disabled, like an unknown faker method.
 */
function ruleOptionsFor(field: FieldConfig, ruleOptions: SelectOption[]): SelectOption[] {
  if (acceptsGeneratedSentence(field.type)) return ruleOptions;
  if (field.ruleType === 'ai_generate') {
    return ruleOptions.map((o) => (o.value === 'ai_generate' ? { ...o, disabled: true } : o));
  }
  return ruleOptions.filter((o) => o.value !== 'ai_generate');
}

/**
 * Categorize an object API name into Standard, Custom, or Managed Package.
 *
 * @param apiName - The Salesforce object API name
 * @returns 'standard' | 'custom' | 'managed'
 */
export function categorizeObject(apiName: string): 'standard' | 'custom' | 'managed' {
  if (!apiName.includes('__')) return 'standard';
  // Managed package: has namespace prefix like ns__Object__c (contains __ before the __c suffix)
  const parts = apiName.split('__');
  if (parts.length >= 3) return 'managed';
  return 'custom';
}

/** Props of one field's row. */
interface FieldRowProps {
  objectApiName: string;
  /** The field's configuration: the same object until it changes. */
  field: FieldConfig;
  onChangeRule: Step3ConfigureFieldsProps['onChangeRule'];
  onChangeConfig: Step3ConfigureFieldsProps['onChangeConfig'];
  ruleOptions: SelectOption[];
}

/**
 * One field's rule and what the rule takes. Drawn again only when its own
 * configuration changes: a character typed in one field's value drew every
 * row of the object again, about 16 000 elements for an 800-field Account.
 */
const FieldRow = React.memo(function FieldRow({
  objectApiName,
  field,
  onChangeRule,
  onChangeConfig,
  ruleOptions,
}: FieldRowProps) {
  const { t } = useTranslation();
  // The field's name sits beside its controls, in no label: each is
  // named after it, or every row read "combo box" and nothing more.
  const rule = ruleOptions.find((o) => o.value === field.ruleType)?.label ?? '';
  const valueLabel = t('a11y.fieldRuleValueFor', { rule, field: field.label });
  return (
    <div
      className={cn('flex items-center gap-2 p-2 rounded-sm text-xs', 'bg-surface-2')}
      data-testid={`field-${objectApiName}-${field.fieldApiName}`}
    >
      <div className="w-32 truncate">
        <span className="text-(--sf-text-primary)">{field.label}</span>
        {field.required && <span className="text-status-error ml-0.5">*</span>}
      </div>
      <span className="w-16 text-(--sf-text-secondary) truncate">{field.type}</span>
      <Select
        aria-label={t('a11y.fieldRuleFor', { field: field.label })}
        options={ruleOptionsFor(field, ruleOptions)}
        value={field.ruleType}
        onChange={(e) =>
          onChangeRule(objectApiName, field.fieldApiName, e.target.value as FieldRuleType)
        }
        className="flex-1"
      />

      {/* Contextual config inputs */}
      {field.ruleType === 'static' && (
        <Input
          aria-label={valueLabel}
          placeholder={t('seed.fieldRules.static')}
          value={String(field.config['staticValue'] ?? '')}
          onChange={(e) =>
            onChangeConfig(objectApiName, field.fieldApiName, 'staticValue', e.target.value)
          }
          className="w-32"
        />
      )}
      {field.ruleType === 'faker' && (
        <Select
          aria-label={valueLabel}
          {...fakerMethodSelection(field.config['fakerMethod'])}
          placeholder={t('seed.fieldRules.faker')}
          onChange={(e) =>
            onChangeConfig(objectApiName, field.fieldApiName, 'fakerMethod', e.target.value)
          }
          className="w-32"
        />
      )}
      {field.ruleType === 'sequence' && (
        <Input
          aria-label={valueLabel}
          placeholder={t('seed.sequencePattern', 'PREFIX-{n}')}
          value={String(field.config['sequencePrefix'] ?? '')}
          onChange={(e) =>
            onChangeConfig(objectApiName, field.fieldApiName, 'sequencePrefix', e.target.value)
          }
          className="w-32"
        />
      )}
      {field.ruleType === 'regex' && (
        <Input
          aria-label={valueLabel}
          placeholder={t('seed.regexPlaceholder', '[A-Z]{3}-\\d{4}')}
          value={String(field.config['regexPattern'] ?? '')}
          onChange={(e) =>
            onChangeConfig(objectApiName, field.fieldApiName, 'regexPattern', e.target.value)
          }
          className="w-32"
        />
      )}
      {field.ruleType === 'ai_generate' && (
        <Input
          aria-label={valueLabel}
          placeholder={t('seed.aiPromptPlaceholder', 'Generate...')}
          value={String(field.config['aiPrompt'] ?? '')}
          onChange={(e) =>
            onChangeConfig(objectApiName, field.fieldApiName, 'aiPrompt', e.target.value)
          }
          className="w-32"
        />
      )}
      {field.ruleType === 'from_csv' && (
        <Input
          aria-label={valueLabel}
          placeholder={t('seed.csvColumnPlaceholder', 'column_name')}
          value={String(field.config['csvColumn'] ?? '')}
          onChange={(e) =>
            onChangeConfig(objectApiName, field.fieldApiName, 'csvColumn', e.target.value)
          }
          className="w-32"
        />
      )}
    </div>
  );
});

/** An object with more fields than this offers a filter on them. */
const FIELD_FILTER_FROM = 10;

/** Past this many fields shown, the rows are drawn as they scroll into view. */
const VIRTUAL_ROWS_FROM = 100;

/** The height of a field's row, as the scrolled list lays it out. */
const FIELD_ROW_HEIGHT = 44;

/** Render a single object's expandable field config panel. */
const ObjectPanel = React.memo(function ObjectPanel({
  obj,
  expanded,
  onToggle,
  onChangeRule,
  onChangeConfig,
  ruleOptions,
}: {
  obj: ObjectFieldConfig;
  expanded: boolean;
  onToggle: (objectApiName: string) => void;
  onChangeRule: Step3ConfigureFieldsProps['onChangeRule'];
  onChangeConfig: Step3ConfigureFieldsProps['onChangeConfig'];
  ruleOptions: SelectOption[];
}) {
  const { t } = useTranslation();
  const filterId = useId();
  /*
   * The fields an admin wants among hundreds: an 800-field Account listed
   * them all, with a search for objects only, past twenty of them, and
   * finding the three to set meant scrolling past every other.
   */
  const [fieldFilter, setFieldFilter] = useState('');
  const [requiredOnly, setRequiredOnly] = useState(false);
  /* The fields set so far, to check them before the run: past a few, they
     sat among hundreds left as the describe gave them. */
  const [setByMeOnly, setSetByMeOnly] = useState(false);
  const offersFilter = obj.fields.length > FIELD_FILTER_FROM;
  const filtering = fieldFilter.trim() !== '' || requiredOnly || setByMeOnly;
  const shownFields = useMemo(() => {
    const needle = fieldFilter.trim().toLowerCase();
    return obj.fields.filter(
      (field) =>
        (!requiredOnly || field.required) &&
        (!setByMeOnly || field.setByUser === true) &&
        (needle === '' ||
          field.label.toLowerCase().includes(needle) ||
          field.fieldApiName.toLowerCase().includes(needle)),
    );
  }, [obj.fields, fieldFilter, requiredOnly, setByMeOnly]);

  const row = (field: FieldConfig): React.ReactNode => (
    <FieldRow
      objectApiName={obj.objectApiName}
      field={field}
      onChangeRule={onChangeRule}
      onChangeConfig={onChangeConfig}
      ruleOptions={ruleOptions}
    />
  );

  return (
    <div className="border border-(--sf-border) rounded-sm">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-(--sf-text-primary) hover:bg-(--sf-bg-hover)"
        onClick={() => onToggle(obj.objectApiName)}
        data-testid={`obj-header-${obj.objectApiName}`}
      >
        <span className="flex items-center gap-2">
          {obj.objectLabel} ({obj.objectApiName})
        </span>
        <Badge variant="default">{t('common.fieldCount', { count: obj.fields.length })}</Badge>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {offersFilter && (
            <div
              className="flex flex-wrap items-end gap-3 pt-1"
              data-testid={`field-filter-${obj.objectApiName}`}
            >
              <div className="min-w-48 flex-1">
                {/* Named by its label: a placeholder alone would name it, and
                    go as soon as a letter is typed. */}
                <Input
                  id={filterId}
                  label={t('seed.configure.filterFields', { object: obj.objectLabel })}
                  type="search"
                  value={fieldFilter}
                  onChange={(e) => setFieldFilter(e.target.value)}
                  placeholder={t('seed.configure.filterFieldsPlaceholder')}
                  data-testid={`field-filter-input-${obj.objectApiName}`}
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-text-primary">
                <input
                  type="checkbox"
                  checked={requiredOnly}
                  onChange={(e) => setRequiredOnly(e.target.checked)}
                  data-testid={`field-filter-required-${obj.objectApiName}`}
                />
                {t('seed.configure.requiredOnly')}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-text-primary">
                <input
                  type="checkbox"
                  checked={setByMeOnly}
                  onChange={(e) => setSetByMeOnly(e.target.checked)}
                  data-testid={`field-filter-set-by-me-${obj.objectApiName}`}
                />
                {t('seed.configure.setByMe')}
              </label>
              <span
                className="text-xs text-text-secondary"
                role="status"
                data-testid={`field-filter-count-${obj.objectApiName}`}
              >
                {filtering
                  ? t('seed.configure.fieldsShown', {
                      shown: shownFields.length,
                      total: obj.fields.length,
                    })
                  : ''}
              </span>
            </div>
          )}

          {/* Field rows: past a hundred, drawn as they scroll into view */}
          {shownFields.length === 0 ? (
            <p
              className="text-xs text-text-secondary"
              data-testid={`field-filter-none-${obj.objectApiName}`}
            >
              {t('seed.configure.noFieldMatches')}
            </p>
          ) : shownFields.length > VIRTUAL_ROWS_FROM ? (
            <VirtualList
              items={shownFields}
              keyExtractor={(field) => field.fieldApiName}
              renderItem={(field) => row(field)}
              estimatedItemHeight={FIELD_ROW_HEIGHT}
              maxHeight="480px"
              overscan={8}
            />
          ) : (
            shownFields.map((field) => (
              <React.Fragment key={field.fieldApiName}>{row(field)}</React.Fragment>
            ))
          )}
        </div>
      )}
    </div>
  );
});

/** Step 3 -- Configure field generation rules per object. */
export const Step3ConfigureFields: React.FC<Step3ConfigureFieldsProps> = ({
  objectConfigs,
  onChangeRule,
  onChangeConfig,
}) => {
  const { t } = useTranslation();
  const [expandedObject, setExpandedObject] = React.useState<string>(
    objectConfigs[0]?.objectApiName ?? '',
  );
  const [searchFilter, setSearchFilter] = React.useState('');

  const ruleOptions = useMemo(
    () => RULE_TYPE_OPTIONS.map((r) => ({ value: r.value, label: t(r.labelKey) })),
    [t],
  );
  /** Open an object's fields, or close them when they are the ones open. */
  const toggleObject = useCallback(
    (objectApiName: string) =>
      setExpandedObject((open) => (open === objectApiName ? '' : objectApiName)),
    [],
  );

  const useGroupedView = objectConfigs.length > GROUPING_THRESHOLD;

  /** Filter object configs by search term. */
  const filteredConfigs = useMemo(() => {
    if (!searchFilter.trim()) return objectConfigs;
    const lower = searchFilter.toLowerCase();
    return objectConfigs.filter(
      (c) =>
        c.objectApiName.toLowerCase().includes(lower) ||
        c.objectLabel.toLowerCase().includes(lower),
    );
  }, [objectConfigs, searchFilter]);

  /** Group filtered configs by category. */
  const groupedConfigs = useMemo(() => {
    if (!useGroupedView) return null;
    const groups: Record<'standard' | 'custom' | 'managed', ObjectFieldConfig[]> = {
      standard: [],
      custom: [],
      managed: [],
    };
    for (const config of filteredConfigs) {
      const category = categorizeObject(config.objectApiName);
      groups[category].push(config);
    }
    return groups;
  }, [filteredConfigs, useGroupedView]);

  /** Render a flat list of object panels. */
  const renderFlatList = (configs: ObjectFieldConfig[]) =>
    configs.map((obj) => (
      <ObjectPanel
        key={obj.objectApiName}
        obj={obj}
        expanded={expandedObject === obj.objectApiName}
        onToggle={toggleObject}
        onChangeRule={onChangeRule}
        onChangeConfig={onChangeConfig}
        ruleOptions={ruleOptions}
      />
    ));

  return (
    <div className="flex flex-col gap-3" data-testid="step-configure-fields">
      <p className="text-xs text-(--sf-text-secondary)">{t('seed.configureFieldsDesc')}</p>

      {/* Search filter for large configs */}
      {useGroupedView && (
        <Input
          placeholder={t('seed.adaptive.searchObjects')}
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          className="w-full"
          data-testid="configure-search-filter"
        />
      )}

      {/* Grouped view for >20 objects */}
      {useGroupedView && groupedConfigs ? (
        <div data-testid="configure-grouped-accordion">
          <Accordion
            items={[
              ...(groupedConfigs.standard.length > 0
                ? [
                    {
                      title: `${t('seed.adaptive.groupStandard')} (${groupedConfigs.standard.length})`,
                      content: (
                        <div className="flex flex-col gap-3">
                          {renderFlatList(groupedConfigs.standard)}
                        </div>
                      ),
                      defaultOpen: true,
                    },
                  ]
                : []),
              ...(groupedConfigs.custom.length > 0
                ? [
                    {
                      title: `${t('seed.adaptive.groupCustom')} (${groupedConfigs.custom.length})`,
                      content: (
                        <div className="flex flex-col gap-3">
                          {renderFlatList(groupedConfigs.custom)}
                        </div>
                      ),
                      defaultOpen: false,
                    },
                  ]
                : []),
              ...(groupedConfigs.managed.length > 0
                ? [
                    {
                      title: `${t('seed.adaptive.groupManaged')} (${groupedConfigs.managed.length})`,
                      content: (
                        <div className="flex flex-col gap-3">
                          {renderFlatList(groupedConfigs.managed)}
                        </div>
                      ),
                      defaultOpen: false,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      ) : (
        /* Flat list for <=20 objects */
        renderFlatList(filteredConfigs)
      )}
    </div>
  );
};
