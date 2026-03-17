import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldRuleType, VRCheckResult, FieldGenerationConfig } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
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
  /** Smart field generation suggestions from SmartFieldGenerator. */
  smartSuggestions?: Map<string, FieldGenerationConfig[]>;
  /** Callback to apply smart suggestions for an object. */
  onApplySmartSuggestions?: (objectApiName: string) => void;
  /** Validation rule check results. */
  vrCheckResults?: VRCheckResult[];
}

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

/** Step 3 — Configure field generation rules per object with smart suggestions and VR warnings. */
export const Step3ConfigureFields: React.FC<Step3ConfigureFieldsProps> = ({
  objectConfigs,
  onChangeRule,
  onChangeConfig,
  smartSuggestions,
  onApplySmartSuggestions,
  vrCheckResults = [],
}) => {
  const { t } = useTranslation();
  const [expandedObject, setExpandedObject] = React.useState<string>(
    objectConfigs[0]?.objectApiName ?? '',
  );

  const ruleOptions = RULE_TYPE_OPTIONS.map((r) => ({
    value: r.value,
    label: t(r.labelKey),
  }));

  /** Get VR warnings for a specific object. */
  const getObjectVRWarnings = (objectApiName: string): VRCheckResult[] => {
    return vrCheckResults.filter((r) => r.objectName === objectApiName);
  };

  /** Get smart suggestion for a specific field. */
  const getFieldSuggestion = (
    objectApiName: string,
    fieldApiName: string,
  ): FieldGenerationConfig | undefined => {
    const objSuggestions = smartSuggestions?.get(objectApiName);
    return objSuggestions?.find((s) => s.fieldName === fieldApiName);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="step-configure-fields">
      <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
        {t('seed.configureFieldsDesc')}
      </p>

      {objectConfigs.map((obj) => {
        const vrWarnings = getObjectVRWarnings(obj.objectApiName);
        const hasSuggestions = smartSuggestions?.has(obj.objectApiName);

        return (
          <div
            key={obj.objectApiName}
            className="border border-[var(--vscode-panel-border,#3c3c3c)] rounded"
          >
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)] hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]"
              onClick={() => setExpandedObject(expandedObject === obj.objectApiName ? '' : obj.objectApiName)}
              data-testid={`obj-header-${obj.objectApiName}`}
            >
              <span className="flex items-center gap-2">
                {obj.objectLabel} ({obj.objectApiName})
                {vrWarnings.length > 0 && (
                  <span data-testid={`vr-badge-${obj.objectApiName}`}>
                    <Badge variant="warning">{vrWarnings.length} VR</Badge>
                  </span>
                )}
              </span>
              <Badge variant="default">{obj.fields.length} {t('seed.configureFields').toLowerCase()}</Badge>
            </button>

            {expandedObject === obj.objectApiName && (
              <div className="flex flex-col gap-2 px-3 pb-3">
                {/* Smart suggest button */}
                {hasSuggestions && onApplySmartSuggestions && (
                  <div className="flex items-center">
                    <button
                      className="text-[10px] text-[var(--vscode-focusBorder,#007fd4)] hover:underline"
                      onClick={() => onApplySmartSuggestions(obj.objectApiName)}
                      data-testid={`smart-suggest-${obj.objectApiName}`}
                    >
                      {t('seed.smartSuggest')}
                    </button>
                  </div>
                )}

                {/* VR Warnings */}
                {vrWarnings.length > 0 && (
                  <div className="flex flex-col gap-1" data-testid={`vr-warnings-${obj.objectApiName}`}>
                    {vrWarnings.map((vr, i) => (
                      <ErrorBanner
                        key={i}
                        message={`${vr.ruleName}: ${vr.errorMessage}`}
                        data-testid={`vr-warning-${obj.objectApiName}-${i}`}
                      />
                    ))}
                  </div>
                )}

                {/* Field rows */}
                {obj.fields.map((field) => {
                  const suggestion = getFieldSuggestion(obj.objectApiName, field.fieldApiName);
                  return (
                    <div
                      key={field.fieldApiName}
                      className={cn(
                        'flex items-center gap-2 p-2 rounded text-xs',
                        'bg-[var(--vscode-input-background,#3c3c3c)]',
                      )}
                      data-testid={`field-${obj.objectApiName}-${field.fieldApiName}`}
                    >
                      <div className="w-32 truncate">
                        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{field.label}</span>
                        {field.required && <span className="text-red-400 ml-0.5">*</span>}
                      </div>
                      <span className="w-16 text-[var(--vscode-descriptionForeground,#868686)] truncate">
                        {field.type}
                      </span>
                      <Select
                        options={ruleOptions}
                        value={field.ruleType}
                        onChange={(e) => onChangeRule(obj.objectApiName, field.fieldApiName, e.target.value as FieldRuleType)}
                        className="flex-1"
                      />

                      {/* Contextual config inputs */}
                      {field.ruleType === 'static' && (
                        <Input
                          placeholder={t('seed.fieldRules.static')}
                          value={String(field.config['staticValue'] ?? '')}
                          onChange={(e) => onChangeConfig(obj.objectApiName, field.fieldApiName, 'staticValue', e.target.value)}
                          className="w-32"
                        />
                      )}
                      {field.ruleType === 'faker' && (
                        <Input
                          placeholder="faker.method"
                          value={String(field.config['fakerMethod'] ?? '')}
                          onChange={(e) => onChangeConfig(obj.objectApiName, field.fieldApiName, 'fakerMethod', e.target.value)}
                          className="w-32"
                        />
                      )}
                      {field.ruleType === 'sequence' && (
                        <Input
                          placeholder={t('seed.sequencePattern', 'PREFIX-{n}')}
                          value={String(field.config['sequencePrefix'] ?? '')}
                          onChange={(e) => onChangeConfig(obj.objectApiName, field.fieldApiName, 'sequencePrefix', e.target.value)}
                          className="w-32"
                        />
                      )}
                      {field.ruleType === 'regex' && (
                        <Input
                          placeholder={t('seed.regexPlaceholder', '[A-Z]{3}-\\d{4}')}
                          value={String(field.config['regexPattern'] ?? '')}
                          onChange={(e) => onChangeConfig(obj.objectApiName, field.fieldApiName, 'regexPattern', e.target.value)}
                          className="w-32"
                        />
                      )}
                      {field.ruleType === 'ai_generate' && (
                        <Input
                          placeholder={t('seed.aiPromptPlaceholder', 'Generate...')}
                          value={String(field.config['aiPrompt'] ?? '')}
                          onChange={(e) => onChangeConfig(obj.objectApiName, field.fieldApiName, 'aiPrompt', e.target.value)}
                          className="w-32"
                        />
                      )}
                      {field.ruleType === 'from_csv' && (
                        <Input
                          placeholder={t('seed.csvColumnPlaceholder', 'column_name')}
                          value={String(field.config['csvColumn'] ?? '')}
                          onChange={(e) => onChangeConfig(obj.objectApiName, field.fieldApiName, 'csvColumn', e.target.value)}
                          className="w-32"
                        />
                      )}

                      {/* Smart suggestion indicator */}
                      {suggestion && suggestion.generationMode !== 'null' && (
                        <span
                          className="text-[9px] text-[var(--sf-info,#3B82F6)] whitespace-nowrap"
                          title={`${t('seed.suggested', 'Suggested')}: ${suggestion.generationMode}${suggestion.fakerMethod ? ` (${suggestion.fakerMethod})` : ''}`}
                          data-testid={`suggestion-${obj.objectApiName}-${field.fieldApiName}`}
                        >
                          {suggestion.fakerMethod ?? suggestion.generationMode}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
