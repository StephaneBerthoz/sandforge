import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeContactPointsReport } from '@sandforge/shared';
import { cn } from '../../theme';

/** Props for {@link ForgeContactPointsResult}. */
export interface ForgeContactPointsResultProps {
  /** What the run did with the email addresses and phone numbers it wrote. */
  report: ForgeContactPointsReport;
}

/**
 * What a run did with the email addresses and phone numbers of the records it
 * wrote: neutralized them — every address under `.invalid`, every number a
 * fictional one — with how many values in how many fields, field by field; or
 * wrote them as the source holds them, as it was asked, which the target's
 * automation may have used to reach real people.
 */
export const ForgeContactPointsResult: React.FC<ForgeContactPointsResultProps> = ({ report }) => {
  const { t } = useTranslation();
  const headingId = useId();
  // Each count is a phrase of its own, in the form its language gives it.
  const values = t('forge.contactPoints.values', { count: report.values });
  const fields = t('common.fieldCount', { count: report.fields.length });
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-results-contact-points"
      className={cn(
        'rounded-sm border px-4 py-2 text-xs',
        report.neutralized
          ? 'border-subtle text-text-secondary'
          : 'border-status-warning/40 bg-status-warning/10 text-text-primary',
      )}
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t('forge.contactPoints.title')}
      </h3>
      {!report.neutralized ? (
        <p className="mt-0.5" data-testid="forge-results-contact-points-kept">
          {t('forge.contactPoints.kept')}
        </p>
      ) : report.values === 0 ? (
        <p className="mt-0.5" data-testid="forge-results-contact-points-summary">
          {t('forge.contactPoints.none')}
        </p>
      ) : (
        <>
          <p className="mt-0.5" data-testid="forge-results-contact-points-summary">
            {t('forge.contactPoints.neutralized', { values, fields })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.fields.map(({ objectApiName, field, values }) => (
              <li key={`${objectApiName}.${field}`} data-testid="forge-results-contact-points-row">
                <span className="font-mono text-text-primary">{`${objectApiName}.${field}`}</span>
                {` — ${t('forge.contactPoints.values', { count: values })}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
