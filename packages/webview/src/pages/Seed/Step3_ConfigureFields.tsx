import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldRuleType } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Accordion } from '../../components/ui/Accordion';
import { cn } from '../../theme';

/** Field configuration for the UI. */
export interface FieldConfig {
  fieldApiName: string;
  label: string;
  type: string;
  required: boolean;
  ruleType: FieldRuleType;
  config: Record<string, unknown>;
}

/** Per-object field configuration. */
export interface ObjectFieldConfig {
  objectApiName: string;
  objectLabel: string;
  fields: FieldConfig[];
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

/** Render a single object's expandable field config panel. */
const ObjectPanel: React.FC<{
  obj: ObjectFieldConfig;
  expandedObject: string;
  setExpandedObject: (name: string) => void;
  onChangeRule: Step3ConfigureFieldsProps['onChangeRule'];
  onChangeConfig: Step3ConfigureFieldsProps['onChangeConfig'];
  ruleOptions: { value: string; label: string }[];
  t: ReturnType<typeof useTranslation>['t'];
}> = ({ obj, expandedObject, setExpandedObject, onChangeRule, onChangeConfig, ruleOptions, t }) => {
  return (
    <div key={obj.objectApiName} className="border border-[var(--sf-border)] rounded">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--sf-text-primary)] hover:bg-[var(--sf-bg-hover)]"
        onClick={() =>
          setExpandedObject(expandedObject === obj.objectApiName ? '' : obj.objectApiName)
        }
        data-testid={`obj-header-${obj.objectApiName}`}
      >
        <span className="flex items-center gap-2">
          {obj.objectLabel} ({obj.objectApiName})
        </span>
        <Badge variant="default">
          {obj.fields.length} {t('seed.configureFields').toLowerCase()}
        </Badge>
      </button>

      {expandedObject === obj.objectApiName && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {/* Field rows */}
          {obj.fields.map((field) => {
            return (
              <div
                key={field.fieldApiName}
                className={cn(
                  'flex items-center gap-2 p-2 rounded text-xs',
                  'bg-[var(--sf-bg-input)]',
                )}
                data-testid={`field-${obj.objectApiName}-${field.fieldApiName}`}
              >
                <div className="w-32 truncate">
                  <span className="text-[var(--sf-text-primary)]">{field.label}</span>
                  {field.required && <span className="text-red-400 ml-0.5">*</span>}
                </div>
                <span className="w-16 text-[var(--sf-text-secondary)] truncate">{field.type}</span>
                <Select
                  options={ruleOptions}
                  value={field.ruleType}
                  onChange={(e) =>
                    onChangeRule(
                      obj.objectApiName,
                      field.fieldApiName,
                      e.target.value as FieldRuleType,
                    )
                  }
                  className="flex-1"
                />

                {/* Contextual config inputs */}
                {field.ruleType === 'static' && (
                  <Input
                    placeholder={t('seed.fieldRules.static')}
                    value={String(field.config['staticValue'] ?? '')}
                    onChange={(e) =>
                      onChangeConfig(
                        obj.objectApiName,
                        field.fieldApiName,
                        'staticValue',
                        e.target.value,
                      )
                    }
                    className="w-32"
                  />
                )}
                {field.ruleType === 'faker' && (
                  <Input
                    placeholder="faker.method"
                    value={String(field.config['fakerMethod'] ?? '')}
                    onChange={(e) =>
                      onChangeConfig(
                        obj.objectApiName,
                        field.fieldApiName,
                        'fakerMethod',
                        e.target.value,
                      )
                    }
                    className="w-32"
                  />
                )}
                {field.ruleType === 'sequence' && (
                  <Input
                    placeholder={t('seed.sequencePattern', 'PREFIX-{n}')}
                    value={String(field.config['sequencePrefix'] ?? '')}
                    onChange={(e) =>
                      onChangeConfig(
                        obj.objectApiName,
                        field.fieldApiName,
                        'sequencePrefix',
                        e.target.value,
                      )
                    }
                    className="w-32"
                  />
                )}
                {field.ruleType === 'regex' && (
                  <Input
                    placeholder={t('seed.regexPlaceholder', '[A-Z]{3}-\\d{4}')}
                    value={String(field.config['regexPattern'] ?? '')}
                    onChange={(e) =>
                      onChangeConfig(
                        obj.objectApiName,
                        field.fieldApiName,
                        'regexPattern',
                        e.target.value,
                      )
                    }
                    className="w-32"
                  />
                )}
                {field.ruleType === 'ai_generate' && (
                  <Input
                    placeholder={t('seed.aiPromptPlaceholder', 'Generate...')}
                    value={String(field.config['aiPrompt'] ?? '')}
                    onChange={(e) =>
                      onChangeConfig(
                        obj.objectApiName,
                        field.fieldApiName,
                        'aiPrompt',
                        e.target.value,
                      )
                    }
                    className="w-32"
                  />
                )}
                {field.ruleType === 'from_csv' && (
                  <Input
                    placeholder={t('seed.csvColumnPlaceholder', 'column_name')}
                    value={String(field.config['csvColumn'] ?? '')}
                    onChange={(e) =>
                      onChangeConfig(
                        obj.objectApiName,
                        field.fieldApiName,
                        'csvColumn',
                        e.target.value,
                      )
                    }
                    className="w-32"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

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

  const ruleOptions = RULE_TYPE_OPTIONS.map((r) => ({
    value: r.value,
    label: t(r.labelKey),
  }));

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

  /** Shared props for ObjectPanel. */
  const panelProps = {
    expandedObject,
    setExpandedObject,
    onChangeRule,
    onChangeConfig,
    ruleOptions,
    t,
  };

  /** Render a flat list of object panels. */
  const renderFlatList = (configs: ObjectFieldConfig[]) =>
    configs.map((obj) => <ObjectPanel key={obj.objectApiName} obj={obj} {...panelProps} />);

  return (
    <div className="flex flex-col gap-3" data-testid="step-configure-fields">
      <p className="text-xs text-[var(--sf-text-secondary)]">{t('seed.configureFieldsDesc')}</p>

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
