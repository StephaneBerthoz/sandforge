import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeDecisionApplied } from '@sandforge/shared';

/** Props for {@link ForgeDecisionsResult}. */
export interface ForgeDecisionsResultProps {
  /** The decisions of the run's config it applied, each with the rows it changed. */
  decisions: readonly ForgeDecisionApplied[];
  /** Whether the run was a simulation, which changed no record in the target. */
  simulated: boolean;
}

/**
 * The decisions taken on Review that the run applied, one row each: what it
 * did, on which object and field, from what to what, and to how many rows —
 * a value mapped or left empty, a default given, a text cut, a record type
 * mapped, rows held back.
 *
 * The run counted them and the results said nothing of them: a mapping that
 * changed three hundred rows read as one that changed none.
 */
export const ForgeDecisionsResult: React.FC<ForgeDecisionsResultProps> = ({
  decisions,
  simulated,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-results-decisions"
      className="rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary"
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t('forgeRun.decisionsApplied.title')}
      </h3>
      <p className="mt-0.5">
        {t(
          simulated ? 'forgeRun.decisionsApplied.hintSimulated' : 'forgeRun.decisionsApplied.hint',
        )}
      </p>
      <table className="mt-1 w-full text-left">
        <thead>
          <tr className="text-text-secondary">
            <th scope="col" className="py-0.5 pr-2 font-medium">
              {t('forgeRun.decisionsApplied.decision')}
            </th>
            <th scope="col" className="py-0.5 pr-2 font-medium">
              {t('forgeRun.decisionsApplied.object')}
            </th>
            <th scope="col" className="py-0.5 pr-2 font-medium">
              {t('forgeRun.decisionsApplied.field')}
            </th>
            <th scope="col" className="py-0.5 pr-2 font-medium">
              {t('forgeRun.decisionsApplied.values')}
            </th>
            <th scope="col" className="py-0.5 text-right font-medium">
              {t('forgeRun.decisionsApplied.rows')}
            </th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((decision) => {
            const values = [
              decision.from !== undefined ? `“${decision.from}”` : null,
              decision.to !== undefined ? `“${decision.to}”` : null,
            ]
              .filter((part): part is string => part !== null)
              .join(' → ');
            return (
              <tr
                key={[
                  decision.kind,
                  decision.objectApiName,
                  decision.field ?? '',
                  decision.recordType ?? '',
                  decision.from ?? '',
                  decision.to ?? '',
                ].join('|')}
                data-testid="forge-results-decision"
                className="text-text-primary"
              >
                <td className="py-0.5 pr-2">{t(`forgeRun.gaps.decision.${decision.kind}`)}</td>
                <td className="py-0.5 pr-2 font-mono">{decision.objectApiName}</td>
                <td className="py-0.5 pr-2 font-mono">
                  {decision.field ?? ''}
                  {decision.recordType !== undefined
                    ? t('forgeRun.gaps.kept.scope', { name: decision.recordType })
                    : ''}
                </td>
                <td className="py-0.5 pr-2 font-mono">{values}</td>
                <td className="py-0.5 text-right tabular-nums">{decision.rows}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
};
