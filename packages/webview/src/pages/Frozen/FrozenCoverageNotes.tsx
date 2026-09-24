import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FrozenGraphCoverage, FrozenLeftToThePlatform } from '@sandforge/shared';

/** Props for {@link FrozenCoverageNotes}. */
export interface FrozenCoverageNotesProps {
  /** How far discovery reached. */
  graph?: FrozenGraphCoverage;
  /** Objects read without the `CreatedDate <= asOf` bound. */
  unboundedObjects?: readonly string[];
  /** Objects left out because they carry files the rules do not keep. */
  filesLeftOut?: readonly string[];
  /** Records left out because the platform writes them, or what they depend on, itself. */
  leftToThePlatform?: readonly FrozenLeftToThePlatform[];
  /** Test id of the list. */
  testId: string;
}

/**
 * What a dataset does not hold, said where it is shown.
 *
 * A frozen dataset is used as a reference, so one that stopped short has to
 * say so: read at the default object cap, an Opportunity's dataset held nine
 * records where there were twenty-one, and nothing on the screen told.
 * Renders nothing when there is nothing to say.
 */
export const FrozenCoverageNotes: React.FC<FrozenCoverageNotesProps> = ({
  graph,
  unboundedObjects = [],
  filesLeftOut = [],
  leftToThePlatform = [],
  testId,
}) => {
  const { t } = useTranslation();
  const truncated = graph?.truncated === true;
  if (
    !truncated &&
    unboundedObjects.length === 0 &&
    filesLeftOut.length === 0 &&
    leftToThePlatform.length === 0
  ) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-0.5" data-testid={testId}>
      {truncated && graph && (
        <li className="text-[11px] text-status-warning">
          {t('frozen.coverage.truncated', { objects: graph.objects, maxNodes: graph.maxNodes })}
        </li>
      )}
      {unboundedObjects.length > 0 && (
        <li className="text-[11px] text-text-secondary">
          {t('frozen.coverage.unbounded', { objects: unboundedObjects.join(', ') })}
        </li>
      )}
      {filesLeftOut.length > 0 && (
        <li className="text-[11px] text-text-secondary">
          {t('frozen.coverage.filesLeftOut', { objects: filesLeftOut.join(', ') })}
        </li>
      )}
      {leftToThePlatform.length > 0 && (
        <li className="text-[11px] text-text-secondary">
          {t('frozen.coverage.leftToThePlatform', {
            objects: leftToThePlatform.map((l) => `${l.objectApiName} (${l.count})`).join(', '),
          })}
        </li>
      )}
    </ul>
  );
};
