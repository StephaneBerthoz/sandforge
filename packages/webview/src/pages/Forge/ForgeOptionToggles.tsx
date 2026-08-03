import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Ban, Sparkles } from 'lucide-react';
import { cn } from '../../theme';

/** Props for the ForgeOptionToggles component. */
export interface ForgeOptionTogglesProps {
  /** Whether PII anonymization is enabled. */
  anonymize: boolean;
  /** Toggle PII anonymization. */
  onAnonymizeChange: (value: boolean) => void;
  /** Whether empty objects are skipped. */
  skipEmpty: boolean;
  /** Toggle skipping empty objects. */
  onSkipEmptyChange: (value: boolean) => void;
  /** Whether missing required parents are auto-fetched. */
  expandOrphanParents: boolean;
  /** Toggle auto-fetching missing parents. */
  onExpandOrphanParentsChange: (value: boolean) => void;
}

/** Option toggle chips: anonymize PII, skip empty objects, auto-fetch parents. */
export const ForgeOptionToggles: React.FC<ForgeOptionTogglesProps> = ({
  anonymize,
  onAnonymizeChange,
  skipEmpty,
  onSkipEmptyChange,
  expandOrphanParents,
  onExpandOrphanParentsChange,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex gap-3">
      <label
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
          anonymize
            ? 'border-forge bg-forge/10 text-forge'
            : 'border-subtle bg-surface-1 text-text-muted hover:border-forge/30',
        )}
      >
        <input
          type="checkbox"
          checked={anonymize}
          onChange={(e) => onAnonymizeChange(e.target.checked)}
          data-testid="forge-anonymize-toggle"
          className="sr-only"
        />
        <Lock size={14} />
        {t('forge.anonymizePII')}
      </label>
      <label
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
          skipEmpty
            ? 'border-forge bg-forge/10 text-forge'
            : 'border-subtle bg-surface-1 text-text-muted hover:border-forge/30',
        )}
      >
        <input
          type="checkbox"
          checked={skipEmpty}
          onChange={(e) => onSkipEmptyChange(e.target.checked)}
          data-testid="forge-skip-empty-toggle"
          className="sr-only"
        />
        <Ban size={14} />
        {t('forge.skipEmpty')}
      </label>
      <label
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
          expandOrphanParents
            ? 'border-forge bg-forge/10 text-forge'
            : 'border-subtle bg-surface-1 text-text-muted hover:border-forge/30',
        )}
        title={t(
          'forge.expandOrphanParentsHint',
          'Auto-fetch missing required parents (single-hop) so Asset/InsurancePolicy etc. land with their FKs intact.',
        )}
      >
        <input
          type="checkbox"
          checked={expandOrphanParents}
          onChange={(e) => onExpandOrphanParentsChange(e.target.checked)}
          data-testid="forge-expand-orphan-parents-toggle"
          className="sr-only"
        />
        <Sparkles size={14} />
        {t('forge.expandOrphanParents', 'Auto-fetch parents')}
      </label>
    </div>
  );
};
