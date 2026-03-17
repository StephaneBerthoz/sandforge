import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TransformRule, TransformRuleType } from '@sandforge/shared';
import { cn } from '../../theme';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

/** TransformBuilder component props. */
export interface TransformBuilderProps {
  rules: TransformRule[];
  onAddRule: (type: TransformRuleType) => void;
  onRemoveRule: (index: number) => void;
  onChangeConfig: (index: number, key: string, value: string) => void;
  className?: string;
}

const TRANSFORM_TYPES: TransformRuleType[] = [
  'uppercase', 'lowercase', 'trim', 'truncate', 'prefix', 'suffix',
  'replace', 'regex_replace', 'map_value', 'default_value',
  'format_date', 'format_number', 'custom_formula',
];

const CONFIG_FIELDS: Record<string, string[]> = {
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

/** Transform rule builder UI. */
export const TransformBuilder: React.FC<TransformBuilderProps> = ({
  rules,
  onAddRule,
  onRemoveRule,
  onChangeConfig,
  className,
}) => {
  const { t } = useTranslation();
  const [selectedType, setSelectedType] = React.useState<TransformRuleType>('uppercase');

  const typeOptions = TRANSFORM_TYPES.map((tt) => ({
    value: tt,
    label: t(`sync.transformTypes.${tt}`),
  }));

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="transform-builder">
      <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('sync.transforms')} ({rules.length})
      </span>

      {/* Existing rules */}
      <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
        {rules.map((rule, i) => {
          const configKeys = CONFIG_FIELDS[rule.type] ?? [];
          return (
            <div
              key={i}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs',
                'border border-[var(--vscode-panel-border,#3c3c3c)]',
              )}
              data-testid={`transform-${i}`}
            >
              <Badge variant="default">{t(`sync.transformTypes.${rule.type}`)}</Badge>
              {configKeys.map((key) => (
                <Input
                  key={key}
                  placeholder={key}
                  value={String((rule.config as Record<string, unknown>)[key] ?? '')}
                  onChange={(e) => onChangeConfig(i, key, e.target.value)}
                  className="w-24"
                />
              ))}
              <button
                className="text-[var(--vscode-errorForeground,#f48771)] hover:opacity-70 px-1 ml-auto"
                onClick={() => onRemoveRule(i)}
                data-testid={`remove-transform-${i}`}
              >
                x
              </button>
            </div>
          );
        })}
      </div>

      {rules.length === 0 && (
        <p className="text-xs text-center text-[var(--vscode-descriptionForeground,#868686)] py-2">
          {t('common.noData')}
        </p>
      )}

      {/* Add new rule */}
      <div className="flex items-center gap-2" data-testid="add-transform-row">
        <Select
          options={typeOptions}
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value as TransformRuleType)}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => onAddRule(selectedType)}
          data-testid="add-transform-btn"
        >
          {t('sync.addTransform')}
        </Button>
      </div>
    </div>
  );
};
