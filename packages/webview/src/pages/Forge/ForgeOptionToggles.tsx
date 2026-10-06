import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Ban, Sparkles, PhoneOff } from 'lucide-react';
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
  /** Whether email addresses and phone numbers are written as the source holds them. */
  keepContactPoints: boolean;
  /** Toggle keeping email addresses and phone numbers as they are. */
  onKeepContactPointsChange: (value: boolean) => void;
}

/**
 * Option toggle chips: anonymize PII, skip empty objects, auto-fetch parents,
 * and keep emails and phone numbers as they are — off by default, every
 * address then written under `.invalid` and every number as a fictional one.
 * On, a warning says who the target's automation may then reach.
 */
export const ForgeOptionToggles: React.FC<ForgeOptionTogglesProps> = ({
  anonymize,
  onAnonymizeChange,
  skipEmpty,
  onSkipEmptyChange,
  expandOrphanParents,
  onExpandOrphanParentsChange,
  keepContactPoints,
  onKeepContactPointsChange,
}) => {
  const { t } = useTranslation();
  const warningId = useId();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <label
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
            anonymize
              ? 'border-forge bg-forge/10 text-hue-forge'
              : 'border-subtle bg-surface-1 text-text-secondary hover:border-forge/30',
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
              ? 'border-forge bg-forge/10 text-hue-forge'
              : 'border-subtle bg-surface-1 text-text-secondary hover:border-forge/30',
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
              ? 'border-forge bg-forge/10 text-hue-forge'
              : 'border-subtle bg-surface-1 text-text-secondary hover:border-forge/30',
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
        <label
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
            keepContactPoints
              ? 'border-status-warning/60 bg-status-warning/10 text-text-primary'
              : 'border-subtle bg-surface-1 text-text-secondary hover:border-forge/30',
          )}
          title={t('forge.keepContactPointsHint')}
        >
          <input
            type="checkbox"
            checked={keepContactPoints}
            onChange={(e) => onKeepContactPointsChange(e.target.checked)}
            data-testid="forge-keep-contact-points-toggle"
            aria-describedby={keepContactPoints ? warningId : undefined}
            className="sr-only"
          />
          <PhoneOff size={14} />
          {t('forge.keepContactPoints')}
        </label>
      </div>
      {/* Said beside the choice, not only on hover: the records then reach the
          target's automation with the addresses and numbers of real people. */}
      {keepContactPoints && (
        <p
          id={warningId}
          role="alert"
          data-testid="forge-keep-contact-points-warning"
          className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
        >
          {t('forge.keepContactPointsWarning')}
        </p>
      )}
    </div>
  );
};
