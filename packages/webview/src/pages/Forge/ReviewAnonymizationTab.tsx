import React, { useCallback } from 'react';
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

/** i18n keys for each PII category label. */
const CATEGORY_LABEL_KEYS: Record<ForgeAnonymizationCategory, string> = {
  email: 'forgeRun.anonCategory.email',
  phone: 'forgeRun.anonCategory.phone',
  name: 'forgeRun.anonCategory.name',
  address: 'forgeRun.anonCategory.address',
  ssn_id: 'forgeRun.anonCategory.ssn_id',
  financial: 'forgeRun.anonCategory.financial',
  other: 'forgeRun.anonCategory.other',
};

/**
 * Anonymization tab within the Forge Review phase.
 *
 * Opens on the switch that anonymizes the fields discovery found personal,
 * for the run Review shows; on, a table with one row per PII category and a
 * dropdown to select the anonymization method for each category.
 */
export const ReviewAnonymizationTab: React.FC = () => {
  const { t } = useTranslation();
  const rules = useForgeStore((s) => s.anonymizationRules);
  const setRule = useForgeStore((s) => s.setAnonymizationRule);
  const graph = useForgeStore((s) => s.graph);
  const applyPreset = useForgeStore((s) => s.applyAnonymizationPreset);
  const anonymizePII = useForgeStore((s) => s.config?.anonymizePII ?? false);
  const setAnonymizePII = useForgeStore((s) => s.setAnonymizePII);
  const piiFieldCount = graph?.nodes.reduce((sum, n) => sum + n.piiFields.length, 0) ?? 0;

  return (
    <div data-testid="review-anonymization-tab" className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
        <input
          type="checkbox"
          data-testid="anonymization-switch"
          checked={anonymizePII}
          onChange={(e) => setAnonymizePII(e.target.checked)}
        />
        <span>{t('forgeRun.review.anonymizeTheseFields', { count: piiFieldCount })}</span>
      </label>
      {!anonymizePII && (
        <p className="text-xs text-text-secondary" data-testid="anonymization-off">
          {t('forgeRun.review.anonymizationOff')}
        </p>
      )}
      {anonymizePII && (
        <ReviewAnonymizationMethods
          piiFieldCount={piiFieldCount}
          rules={rules}
          setRule={setRule}
          applyPreset={applyPreset}
        />
      )}
    </div>
  );
};

/** Props of {@link ReviewAnonymizationMethods}. */
interface ReviewAnonymizationMethodsProps {
  piiFieldCount: number;
  rules: Record<ForgeAnonymizationCategory, AnonymizationMethod>;
  setRule: (category: ForgeAnonymizationCategory, method: AnonymizationMethod) => void;
  applyPreset: (
    rules: ReadonlyArray<{ objectApiName: string; fieldNames: readonly string[] }>,
  ) => void;
}

/** The methods a run that anonymizes applies, per category, and the preset that sets them. */
const ReviewAnonymizationMethods: React.FC<ReviewAnonymizationMethodsProps> = ({
  piiFieldCount,
  rules,
  setRule,
  applyPreset,
}) => {
  const { t } = useTranslation();
  // In the store, not in this tab: a run's results save it with the run as a
  // template, and applying the template brings it back.
  const presetId = useForgeStore((s) => s.anonymizationPresetId);
  const setPresetId = useForgeStore((s) => s.setAnonymizationPresetId);
  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setPresetId(id);
      const preset = findForgeAnonymizationPreset(id);
      if (preset) applyPreset(preset.rules);
    },
    [applyPreset, setPresetId],
  );

  return (
    <>
      <p className="text-xs text-text-secondary">
        {t('forgeRun.review.anonymizationDesc', {
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
          {t('forgeRun.review.preset', 'Preset')}
        </label>
        <select
          id="anonymization-preset"
          data-testid="anonymization-preset-select"
          value={presetId}
          onChange={handlePresetChange}
          className="flex-1 bg-surface-3 text-text-primary text-xs rounded-sm px-2 py-1 border border-subtle"
        >
          <option value="">{t('forgeRun.review.presetCustom', 'Custom (no preset)')}</option>
          {FORGE_ANONYMIZATION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {presetId && (
          <span
            data-testid="anonymization-preset-description"
            className="text-[10px] text-text-secondary max-w-[40%] truncate"
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
              <th className="text-left px-3 py-2 text-text-secondary font-medium">
                {t('forgeRun.review.category', 'Category')}
              </th>
              <th className="text-left px-3 py-2 text-text-secondary font-medium">
                {t('forgeRun.review.method', 'Method')}
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
                <td className="px-3 py-2 text-text-primary">{t(CATEGORY_LABEL_KEYS[cat])}</td>
                <td className="px-3 py-2">
                  <select
                    data-testid={`anon-select-${cat}`}
                    // One select per row, and the only visible label is the
                    // category in the cell beside it.
                    aria-label={t('a11y.anonymizationMethodFor', {
                      category: t(CATEGORY_LABEL_KEYS[cat]),
                    })}
                    value={rules[cat]}
                    onChange={(e) => setRule(cat, e.target.value as AnonymizationMethod)}
                    className="bg-surface-3 text-text-primary text-xs rounded-sm px-2 py-1 border border-subtle"
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`forgeRun.anonMethod.${m}`)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
