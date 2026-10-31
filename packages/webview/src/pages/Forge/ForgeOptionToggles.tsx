import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
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
 * The box drawn at the head of a chip: empty when off, checked when on. The
 * chips said their state by a border colour alone, and off they all looked
 * alike. The input is a checkbox, so its state is announced already; the box
 * is for the eye and hidden from screen readers.
 */
const ChipBox: React.FC<{ checked: boolean; testId: string }> = ({ checked, testId }) => (
  <span
    aria-hidden="true"
    data-testid={testId}
    data-checked={checked ? 'true' : 'false'}
    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-current"
  >
    {checked && <Check size={11} strokeWidth={3} />}
  </span>
);

/**
 * Option toggle chips: anonymize PII, skip empty objects, auto-fetch parents,
 * and keep emails and phone numbers as they are — off by default, every
 * address then written under `.invalid` and every number as a fictional one.
 * On, a warning says who the target's automation may then reach. Under the
 * chips, what each privacy choice does, said where it is made: the PII
 * banner told the user to anonymize to protect sensitive data, as if emails
 * went out raw, when they are neutralized unless Keep is ticked.
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
  const anonymizeHintId = useId();
  const contactPointsHintId = useId();

  return (
    <div className="flex flex-col gap-2">
      {/* Each chip is `relative`, the box its sr-only input is placed in. It
          was placed by a far ancestor instead, some 250 pixels below the chip,
          where the focus scrolled to and where a click under a module's
          how-to bar fell outside the window. */}
      <div className="flex flex-wrap gap-3">
        <label
          className={cn(
            'relative flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
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
            aria-describedby={anonymizeHintId}
            className="sr-only"
          />
          <ChipBox checked={anonymize} testId="forge-anonymize-box" />
          {t('forge.anonymizePII')}
        </label>
        <label
          className={cn(
            'relative flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
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
          <ChipBox checked={skipEmpty} testId="forge-skip-empty-box" />
          {t('forge.skipEmpty')}
        </label>
        <label
          className={cn(
            'relative flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
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
          <ChipBox checked={expandOrphanParents} testId="forge-expand-orphan-parents-box" />
          {t('forge.expandOrphanParents', 'Auto-fetch parents')}
        </label>
        <label
          className={cn(
            'relative flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
            keepContactPoints
              ? 'border-status-warning/60 bg-status-warning/10 text-text-primary'
              : 'border-subtle bg-surface-1 text-text-secondary hover:border-forge/30',
          )}
          title={t('runResults.contactPoints.keepHint')}
        >
          <input
            type="checkbox"
            checked={keepContactPoints}
            onChange={(e) => onKeepContactPointsChange(e.target.checked)}
            data-testid="forge-keep-contact-points-toggle"
            aria-describedby={
              keepContactPoints ? `${contactPointsHintId} ${warningId}` : contactPointsHintId
            }
            className="sr-only"
          />
          <ChipBox checked={keepContactPoints} testId="forge-keep-contact-points-box" />
          {t('runResults.contactPoints.keep')}
        </label>
      </div>
      <div className="flex flex-col gap-0.5 text-[10px] text-text-secondary">
        <p id={anonymizeHintId} data-testid="forge-anonymize-hint">
          {t('forge.anonymizeHint')}
        </p>
        <p id={contactPointsHintId} data-testid="forge-contact-points-default">
          {t('runResults.contactPoints.neutralizedUnlessKept')}
        </p>
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
          {t('runResults.contactPoints.keepWarning')}
        </p>
      )}
    </div>
  );
};
