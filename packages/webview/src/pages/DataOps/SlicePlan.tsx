import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AnonymizeCoverageObject,
  SlicePlan as SlicePlanCost,
  SlicePlanObject,
} from '@sandforge/shared';
import { formatEstimateSec, formatFileSize, formatNumber } from '../../utils/formatters';

/** An object of a coverage with the slices a run would cut it into. */
export type SlicedObject = AnonymizeCoverageObject & { slicePlan: SlicePlanObject };

/**
 * The objects of a coverage a run masks in more than one slice: those
 * holding more rows than one snapshot does, which a run keeping the values
 * first masks in slices, each backed up just before it is masked, or not at
 * all.
 */
export function slicedObjects(
  objects: readonly AnonymizeCoverageObject[] | undefined,
): SlicedObject[] {
  return (objects ?? []).filter(
    (o): o is SlicedObject => o.slicePlan !== undefined && o.slicePlan.slices > 1,
  );
}

/** The words of how a plan's requests sit against what the org has left today. */
const VERDICT_KEYS = {
  fits: 'dataops.slices.plan.verdict.fits',
  near: 'dataops.slices.plan.verdict.near',
  exceeds: 'dataops.slices.plan.verdict.exceeds',
} as const;

/**
 * What a masking run in slices would cost, said before it is asked, as the
 * command line's dry run says it: per object the slices it makes, the
 * requests it sends against what the org has left today, that it uses no
 * Bulk API batch, the disk its backups take on this machine, and how long
 * it takes. A verdict past what is left is no refusal: the run goes as far
 * as the day allows, and a resume carries on.
 */
export const SlicePlan: React.FC<{
  plan: SlicePlanCost;
  objects: readonly SlicedObject[];
  testId: string;
}> = ({ plan, objects, testId }) => {
  const { t } = useTranslation();
  const parts = {
    requests: formatNumber(plan.requests),
    snapshots: formatNumber(plan.parts.snapshots),
    updates: formatNumber(plan.parts.updates),
    reads: formatNumber(plan.parts.reads),
  };
  const budget = plan.apiBudget;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-text-primary" data-testid={testId}>
      {objects.map((o) => (
        <li key={o.objectApiName} data-testid={`${testId}-${o.objectApiName}`}>
          {t('dataops.slices.plan.object', {
            object: o.objectApiName,
            count: o.slicePlan.slices,
            formatted: formatNumber(o.slicePlan.slices),
            size: formatNumber(o.slicePlan.size),
          })}
          {o.slicePlan.approximate && ` ${t('dataops.slices.plan.approximate')}`}
        </li>
      ))}
      <li data-testid={`${testId}-requests`}>
        {budget.verdict !== 'unread' && budget.remaining !== undefined
          ? t('dataops.slices.plan.requests', {
              ...parts,
              remaining: formatNumber(budget.remaining),
              verdict: t(VERDICT_KEYS[budget.verdict]),
            })
          : t('dataops.slices.plan.requestsUnread', parts)}
      </li>
      <li data-testid={`${testId}-bulk`}>{t('dataops.slices.plan.bulk')}</li>
      <li data-testid={`${testId}-disk`}>
        {plan.diskFree !== undefined
          ? t('dataops.slices.plan.disk', {
              size: formatFileSize(plan.diskBytes),
              free: formatFileSize(plan.diskFree),
            })
          : t('dataops.slices.plan.diskUnknown', { size: formatFileSize(plan.diskBytes) })}
      </li>
      <li data-testid={`${testId}-time`}>
        {t('dataops.slices.plan.time', { time: formatEstimateSec(plan.seconds) })}
      </li>
    </ul>
  );
};
