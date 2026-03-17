import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';

/** A single field masking rule for display. */
export interface MaskingRule {
  fieldApiName: string;
  ruleType: string;
  description: string;
  recommended: boolean;
}

/** A masking template for a Salesforce object. */
export interface ObjectTemplate {
  objectApiName: string;
  label: string;
  rules: MaskingRule[];
}

/** Props for the MaskingTemplatePanel component. */
export interface MaskingTemplatePanelProps {
  /** Pre-built templates for standard objects. */
  templates: ObjectTemplate[];
  /** Callback when user applies selected rules. */
  onApply?: (objectName: string, rules: MaskingRule[]) => void;
  /** Whether an apply operation is in progress. */
  isApplying?: boolean;
}

/** Rule type display labels. */
const RULE_TYPE_ICONS: Record<string, string> = {
  fake: 'F',
  mask: 'M',
  hash: 'H',
  nullify: 'N',
  preserve_format: 'P',
  constant: 'C',
  truncate: 'T',
  shuffle: 'S',
};

/** Badge variant for rule types. */
function ruleTypeBadgeVariant(ruleType: string): 'default' | 'info' | 'warning' | 'success' | 'error' {
  switch (ruleType) {
    case 'fake':
      return 'info';
    case 'mask':
      return 'warning';
    case 'nullify':
      return 'error';
    case 'hash':
      return 'default';
    default:
      return 'default';
  }
}

/**
 * Panel for browsing and applying pre-built data masking templates.
 * Allows users to select objects, view per-field rules, toggle individual rules,
 * and apply the selection.
 */
export const MaskingTemplatePanel: React.FC<MaskingTemplatePanelProps> = ({
  templates,
  onApply,
  isApplying = false,
}) => {
  const { t } = useTranslation();
  const [expandedObject, setExpandedObject] = useState<string | null>(null);
  const [selectedRules, setSelectedRules] = useState<Map<string, Set<string>>>(new Map());
  const [search, setSearch] = useState('');

  /** Filter templates by search. */
  const filteredTemplates = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter(
      (t) =>
        t.objectApiName.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q),
    );
  }, [templates, search]);

  /** Toggle expansion of an object's rules. */
  const toggleExpand = useCallback((objectApiName: string) => {
    setExpandedObject((prev) => (prev === objectApiName ? null : objectApiName));
  }, []);

  /** Toggle a specific rule for an object. */
  const toggleRule = useCallback((objectApiName: string, fieldApiName: string) => {
    setSelectedRules((prev) => {
      const next = new Map(prev);
      const objectRules = new Set(next.get(objectApiName) ?? []);
      if (objectRules.has(fieldApiName)) {
        objectRules.delete(fieldApiName);
      } else {
        objectRules.add(fieldApiName);
      }
      next.set(objectApiName, objectRules);
      return next;
    });
  }, []);

  /** Select all recommended rules for an object. */
  const selectRecommended = useCallback(
    (objectApiName: string) => {
      const template = templates.find((t) => t.objectApiName === objectApiName);
      if (!template) return;
      const recommended = new Set(
        template.rules.filter((r) => r.recommended).map((r) => r.fieldApiName),
      );
      setSelectedRules((prev) => {
        const next = new Map(prev);
        next.set(objectApiName, recommended);
        return next;
      });
    },
    [templates],
  );

  /** Select all rules for an object. */
  const selectAll = useCallback(
    (objectApiName: string) => {
      const template = templates.find((t) => t.objectApiName === objectApiName);
      if (!template) return;
      setSelectedRules((prev) => {
        const next = new Map(prev);
        next.set(objectApiName, new Set(template.rules.map((r) => r.fieldApiName)));
        return next;
      });
    },
    [templates],
  );

  /** Clear all rules for an object. */
  const clearAll = useCallback((objectApiName: string) => {
    setSelectedRules((prev) => {
      const next = new Map(prev);
      next.set(objectApiName, new Set());
      return next;
    });
  }, []);

  /** Get selected rules for an object to pass to onApply. */
  const getSelectedRulesForObject = useCallback(
    (objectApiName: string): MaskingRule[] => {
      const template = templates.find((t) => t.objectApiName === objectApiName);
      if (!template) return [];
      const selected = selectedRules.get(objectApiName) ?? new Set();
      return template.rules.filter((r) => selected.has(r.fieldApiName));
    },
    [templates, selectedRules],
  );

  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-text-muted" data-testid="masking-empty">
        <Shield className="w-8 h-8 mb-2 opacity-50" />
        <span className="text-xs">{t('dataops.masking.noTemplates', 'No masking templates available')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="masking-template-panel">
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">
          {t('dataops.masking.title', 'Data Masking Templates')}
        </h3>
      </div>

      <p className="text-xs text-text-secondary">
        {t('dataops.masking.description', 'Pre-built anonymization rules for common Salesforce objects. Select fields to mask and apply.')}
      </p>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
        <input
          type="text"
          className={cn(
            'w-full rounded-md border border-subtle bg-surface-2 pl-8 pr-3 py-1.5',
            'text-xs text-text-primary placeholder:text-text-muted',
            'focus:outline-none focus:border-active',
          )}
          placeholder={t('dataops.masking.search', 'Search objects...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="masking-search"
        />
      </div>

      {/* Object list */}
      <div className="flex flex-col gap-2">
        {filteredTemplates.map((template) => {
          const isExpanded = expandedObject === template.objectApiName;
          const objSelected = selectedRules.get(template.objectApiName) ?? new Set();
          const selectedCount = objSelected.size;
          const recommendedCount = template.rules.filter((r) => r.recommended).length;

          return (
            <div
              key={template.objectApiName}
              className="rounded-lg border border-subtle bg-surface-1 overflow-hidden"
              data-testid={`masking-obj-${template.objectApiName}`}
            >
              {/* Object header */}
              <button
                className="flex items-center gap-2 w-full px-3 py-2.5 hover:bg-surface-2 transition-colors text-left"
                onClick={() => toggleExpand(template.objectApiName)}
                data-testid={`masking-toggle-${template.objectApiName}`}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-text-muted shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                )}
                <span className="text-xs font-medium text-text-primary flex-1">
                  {template.label}
                </span>
                <span className="text-[10px] text-text-muted">
                  {template.rules.length} {t('dataops.masking.fields', 'fields')}
                </span>
                {selectedCount > 0 && (
                  <Badge variant="info">{selectedCount}</Badge>
                )}
              </button>

              {/* Expanded rules */}
              {isExpanded && (
                <div className="border-t border-subtle px-3 py-2 flex flex-col gap-1.5">
                  {/* Quick actions */}
                  <div className="flex items-center gap-2 mb-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => selectRecommended(template.objectApiName)}
                      data-testid={`select-recommended-${template.objectApiName}`}
                    >
                      {t('dataops.masking.selectRecommended', 'Recommended')} ({recommendedCount})
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => selectAll(template.objectApiName)}
                      data-testid={`select-all-${template.objectApiName}`}
                    >
                      {t('dataops.masking.selectAll', 'All')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => clearAll(template.objectApiName)}
                      data-testid={`clear-all-${template.objectApiName}`}
                    >
                      {t('dataops.masking.clearAll', 'Clear')}
                    </Button>
                  </div>

                  {/* Rule list */}
                  {template.rules.map((rule) => {
                    const isChecked = objSelected.has(rule.fieldApiName);
                    return (
                      <label
                        key={rule.fieldApiName}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors',
                          isChecked ? 'bg-blue-500/5' : 'hover:bg-surface-2',
                        )}
                        data-testid={`rule-${template.objectApiName}-${rule.fieldApiName}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleRule(template.objectApiName, rule.fieldApiName)}
                          className="rounded"
                        />
                        <span className="text-xs font-mono text-text-primary w-36 truncate shrink-0">
                          {rule.fieldApiName}
                        </span>
                        <Badge variant={ruleTypeBadgeVariant(rule.ruleType)}>
                          {RULE_TYPE_ICONS[rule.ruleType] ?? rule.ruleType}
                        </Badge>
                        <span className="text-[10px] text-text-secondary flex-1 truncate">
                          {rule.description}
                        </span>
                        {rule.recommended && (
                          <Check className="w-3 h-3 text-green-400 shrink-0" />
                        )}
                      </label>
                    );
                  })}

                  {/* Apply button */}
                  {selectedCount > 0 && onApply && (
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-2"
                      onClick={() =>
                        onApply(template.objectApiName, getSelectedRulesForObject(template.objectApiName))
                      }
                      loading={isApplying}
                      data-testid={`apply-${template.objectApiName}`}
                    >
                      {t('dataops.masking.apply', 'Apply {{count}} rules')
                        .replace('{{count}}', String(selectedCount))}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
