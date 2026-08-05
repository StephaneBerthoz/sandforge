import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MetadataComponentType } from '@sandforge/shared';
import { cn } from '../../theme';

/** Grouped metadata component types for visual organization. */
export const CATEGORY_GROUPS: Array<{
  label: string;
  labelKey: string;
  types: MetadataComponentType[];
}> = [
  {
    label: 'Data Model',
    labelKey: 'compare.catDataModel',
    types: ['CustomObject', 'CustomField', 'RecordType'],
  },
  { label: 'Apex Code', labelKey: 'compare.catApexCode', types: ['ApexClass', 'ApexTrigger'] },
  { label: 'Lightning', labelKey: 'compare.catLightning', types: ['LightningComponentBundle'] },
  {
    label: 'Automation',
    labelKey: 'compare.catAutomation',
    types: ['Flow', 'WorkflowRule', 'ValidationRule'],
  },
  { label: 'Security', labelKey: 'compare.catSecurity', types: ['Profile', 'PermissionSet'] },
  {
    label: 'Configuration',
    labelKey: 'compare.catConfiguration',
    types: ['Layout', 'CustomLabel', 'CustomMetadata', 'CustomSetting'],
  },
  {
    label: 'Content',
    labelKey: 'compare.catContent',
    types: ['StaticResource', 'EmailTemplate', 'Report', 'Dashboard'],
  },
  { label: 'Other', labelKey: 'compare.catOther', types: ['Other'] },
];

/** All available metadata component types for comparison (derived from groups). */
export const ALL_COMPONENT_TYPES: MetadataComponentType[] = CATEGORY_GROUPS.flatMap((g) => g.types);

/** CategorySelector component props. */
export interface CategorySelectorProps {
  selected: MetadataComponentType[];
  onChange: (types: MetadataComponentType[]) => void;
  className?: string;
}

/** Multi-select category picker organized by metadata type groups. */
export const CategorySelector: React.FC<CategorySelectorProps> = ({
  selected,
  onChange,
  className,
}) => {
  const { t } = useTranslation();

  const toggle = (type: MetadataComponentType) => {
    if (selected.includes(type)) {
      onChange(selected.filter((s) => s !== type));
    } else {
      onChange([...selected, type]);
    }
  };

  const selectAll = () => {
    onChange([...ALL_COMPONENT_TYPES]);
  };

  const clearAll = () => {
    onChange([]);
  };

  const toggleGroup = (types: MetadataComponentType[]) => {
    const allGroupSelected = types.every((tp) => selected.includes(tp));
    if (allGroupSelected) {
      onChange(selected.filter((s) => !types.includes(s)));
    } else {
      const merged = new Set([...selected, ...types]);
      onChange([...merged]);
    }
  };

  return (
    <div className={className} data-testid="category-selector">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-primary">
          {t('compare.categories', 'Categories')} ({selected.length}/{ALL_COMPONENT_TYPES.length})
        </span>
        <div className="flex gap-2">
          <button
            className="text-[10px] text-[var(--sf-text-link)] hover:underline"
            onClick={selectAll}
            data-testid="select-all-btn"
          >
            {t('compare.selectAll', 'Select All')}
          </button>
          <button
            className="text-[10px] text-[var(--sf-text-link)] hover:underline"
            onClick={clearAll}
            data-testid="clear-all-btn"
          >
            {t('compare.clear', 'Clear')}
          </button>
        </div>
      </div>

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-2)' }}
        role="group"
        aria-label={t('compare.categories', 'Categories')}
      >
        {CATEGORY_GROUPS.map((group) => {
          const groupSelectedCount = group.types.filter((tp) => selected.includes(tp)).length;
          const allGroupSelected = groupSelectedCount === group.types.length;

          return (
            <div key={group.label} data-testid={`cat-group-${group.label}`}>
              <button
                type="button"
                onClick={() => toggleGroup(group.types)}
                data-testid={`cat-group-toggle-${group.label}`}
                className={cn(
                  'text-[10px] font-semibold mb-1 cursor-pointer',
                  allGroupSelected ? 'text-[var(--sf-text-link)]' : 'text-text-secondary',
                )}
                style={{ background: 'none', border: 'none', padding: 0 }}
              >
                {t(group.labelKey)} ({groupSelectedCount}/{group.types.length})
              </button>

              <div className="flex flex-wrap gap-1.5">
                {group.types.map((type) => {
                  const isSelected = selected.includes(type);
                  return (
                    <button
                      key={type}
                      onClick={() => toggle(type)}
                      className={cn(
                        'px-2 py-1 text-[10px] rounded border transition-colors',
                        isSelected
                          ? 'bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] border-[var(--sf-button-bg)]'
                          : 'bg-[var(--sf-bg-input)] text-[var(--sf-text-input)] border-[var(--sf-border)] hover:border-[var(--sf-accent)]',
                      )}
                      role="checkbox"
                      aria-checked={isSelected}
                      data-testid={`cat-${type}`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
