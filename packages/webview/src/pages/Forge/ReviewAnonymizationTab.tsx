import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';
import { FORGE_ANONYMIZATION_PRESETS, findForgeAnonymizationPreset } from '@sandforge/shared';

/** All anonymization categories in display order. */
const CATEGORIES: ForgeAnonymizationCategory[] = [
  'email',
  'phone',
  'name',
  'address',
  'ssn_id',
  'financial',
  'other',
];

/** All available anonymization methods. */
const METHODS: AnonymizationMethod[] = [
  'fake',
  'mask',
  'hash',
  'nullify',
  'redact',
  'shuffle',
  'truncate',
  'preserve_format',
  'age_band',
  'generalize',
];

/** Human-readable labels for each PII category. */
const CATEGORY_LABELS: Record<ForgeAnonymizationCategory, string> = {
  email: 'Email',
  phone: 'Phone',
  name: 'Name (First/Last)',
  address: 'Address',
  ssn_id: 'SSN / National ID',
  financial: 'Financial',
  other: 'Other',
};

/**
 * Anonymization tab within the Forge Review phase.
 *
 * Displays a table with one row per PII category and a dropdown
 * to select the anonymization method for each category.
 */
export const ReviewAnonymizationTab: React.FC = () => {
  const { t } = useTranslation();
  const rules = useForgeStore((s) => s.anonymizationRules);
  const setRule = useForgeStore((s) => s.setAnonymizationRule);
  const graph = useForgeStore((s) => s.graph);
  const applyPreset = useForgeStore((s) => s.applyAnonymizationPreset);
  const piiFieldCount = graph?.nodes.reduce((sum, n) => sum + n.piiFields.length, 0) ?? 0;

  const [presetId, setPresetId] = useState<string>('');
  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setPresetId(id);
      const preset = findForgeAnonymizationPreset(id);
      if (preset) applyPreset(preset.rules);
    },
    [applyPreset],
  );

  return (
    <div data-testid="review-anonymization-tab" className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">
        {t('forge.review.anonymizationDesc', {
          defaultValue:
            '{{count}} PII fields detected. Configure anonymization method per category.',
          count: piiFieldCount,
        })}
      </p>

      <div
        data-testid="anonymization-preset-selector"
        className="rounded-lg border border-subtle bg-surface-1 p-3 flex items-center gap-2"
      >
        <label
          htmlFor="anonymization-preset"
          className="text-xs font-medium text-text-primary shrink-0"
        >
          {t('forge.review.preset', 'Preset')}
        </label>
        <select
          id="anonymization-preset"
          data-testid="anonymization-preset-select"
          value={presetId}
          onChange={handlePresetChange}
          className="flex-1 bg-surface-3 text-text-primary text-xs rounded px-2 py-1 border border-subtle"
        >
          <option value="">{t('forge.review.presetCustom', 'Custom (no preset)')}</option>
          {FORGE_ANONYMIZATION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {presetId && (
          <span
            data-testid="anonymization-preset-description"
            className="text-[10px] text-text-muted max-w-[40%] truncate"
            title={findForgeAnonymizationPreset(presetId)?.description ?? ''}
          >
            {findForgeAnonymizationPreset(presetId)?.description}
          </span>
        )}
      </div>

      <div className="rounded-lg border border-subtle overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-subtle bg-surface-2">
              <th className="text-left px-3 py-2 text-text-muted font-medium">
                {t('forge.review.category', 'Category')}
              </th>
              <th className="text-left px-3 py-2 text-text-muted font-medium">
                {t('forge.review.method', 'Method')}
              </th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((cat) => (
              <tr
                key={cat}
                data-testid={`anon-row-${cat}`}
                className="border-b border-subtle last:border-b-0"
              >
                <td className="px-3 py-2 text-text-primary">{CATEGORY_LABELS[cat]}</td>
                <td className="px-3 py-2">
                  <select
                    data-testid={`anon-select-${cat}`}
                    value={rules[cat]}
                    onChange={(e) => setRule(cat, e.target.value as AnonymizationMethod)}
                    className="bg-surface-3 text-text-primary text-xs rounded px-2 py-1 border border-subtle"
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
