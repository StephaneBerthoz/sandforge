import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../utils/formatters';

/**
 * The most records of one object a run holds, which no setting raises: the
 * maximum of `sandforge.sync.maxRecordsPerObject`. A read cut at it offers
 * slices and a sample, not a higher bound.
 */
const READ_CAP_MOST = 50_000;

/** Props for {@link SyncReadCutLine}. */
export interface SyncReadCutLineProps {
  /** The bound the read of the source stopped at; no line when the read was whole. */
  cap: number | undefined;
  /** Test id of the line. */
  testId: string;
}

/**
 * What a run's result says of an object whose read of the source the bound
 * cut: the run copied part of it, and how to copy the rest or a sample of the
 * source that fits the target. Said on the object as the results step, the
 * Quick Sync results and the history detail show it.
 *
 * The run said success on each of them, and a toast that closed itself was
 * the only word of the cut.
 */
export const SyncReadCutLine: React.FC<SyncReadCutLineProps> = ({ cap, testId }) => {
  const { t } = useTranslation();
  if (cap === undefined) return null;
  return (
    <p className="text-xs text-status-warning" data-testid={testId}>
      {t(cap < READ_CAP_MOST ? 'syncParts.readCut' : 'syncParts.readCutAtMost', {
        cap: formatNumber(cap),
      })}
    </p>
  );
};

/**
 * Whether a run's result says the bound cut the read of an object, and the
 * bound it stopped at when it did.
 *
 * @param result - The run's result: its bound and the objects it cut.
 * @param objectApiName - The object of the line.
 */
export function readCutOf(
  result: { readCap?: number; cutAtReadCap?: readonly string[] },
  objectApiName: string,
): number | undefined {
  return result.readCap !== undefined && result.cutAtReadCap?.includes(objectApiName) === true
    ? result.readCap
    : undefined;
}
