import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CompareContentCoverage } from '@sandforge/shared';

/** Props for the ContentCoverage component. */
export interface ContentCoverageProps {
  /** What the comparison read; nothing is shown for a result that does not say. */
  coverage: CompareContentCoverage | undefined;
}

/**
 * How much of what both orgs hold was compared by content, and why the rest
 * was not.
 *
 * A comparison reads a bounded number of components, and a type of
 * twenty-four thousand custom fields does not fit. Without this line, a
 * result that compared five hundred components reads like one that compared
 * them all.
 */
export const ContentCoverage: React.FC<ContentCoverageProps> = ({ coverage }) => {
  const { t } = useTranslation();
  if (!coverage) return null;

  const { over_budget: overBudget, unreadable, read_failed: readFailed } = coverage.notCompared;
  const notCompared = overBudget + unreadable + readFailed;
  const managedLeftOut = coverage.managedLeftOut ?? 0;

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-1)] text-xs text-[var(--sf-text-secondary)]"
      data-testid="compare-coverage"
    >
      <p className="m-0" data-testid="compare-coverage-compared">
        {t('compare.coverage.compared', {
          compared: coverage.compared,
          inBoth: coverage.compared + notCompared,
        })}
      </p>
      {managedLeftOut > 0 && (
        <p className="m-0" data-testid="compare-coverage-managed-left-out">
          {t('compare.coverage.managedLeftOut', { count: managedLeftOut })}
        </p>
      )}
      {notCompared > 0 && (
        <>
          <ul className="m-0 pl-[var(--sf-space-4)] list-disc">
            {overBudget > 0 && (
              <li data-testid="compare-coverage-over-budget">
                {t('compare.coverage.overBudget', {
                  count: overBudget,
                  components: coverage.budget.components,
                  seconds: coverage.budget.seconds,
                })}
              </li>
            )}
            {unreadable > 0 && (
              <li data-testid="compare-coverage-unreadable">
                {t('compare.coverage.unreadable', { count: unreadable })}
              </li>
            )}
            {readFailed > 0 && (
              <li data-testid="compare-coverage-read-failed">
                {t('compare.coverage.readFailed', { count: readFailed })}
              </li>
            )}
          </ul>
          <p className="m-0" data-testid="compare-coverage-left-out">
            {t('compare.coverage.leftOut')}
          </p>
        </>
      )}
    </div>
  );
};
