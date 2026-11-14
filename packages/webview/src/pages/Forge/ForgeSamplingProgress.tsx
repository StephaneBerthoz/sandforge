import React from 'react';
import { useTranslation } from 'react-i18next';
import { Dices } from 'lucide-react';
import { orgDisplayName } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { sampleNumber as n } from './sampleWords';

/**
 * Where the drawing of a sample of the whole org stands, on the execution
 * screen, before the run's gate: the plan reads the source for minutes and
 * writes no object meanwhile, so the bar of the objects stands at nothing.
 * The step — counting each object's roots, reading the ids drawn, reading
 * the records they reach and name, cutting the sample to the target's room,
 * keeping the plan —, the object it is on, the records read and the requests
 * sent the source, against what they were priced at. Gone once the run
 * reports on its first object or answers.
 */
export const ForgeSamplingProgress: React.FC = () => {
  const { t } = useTranslation();
  const sampling = useForgeStore((s) => s.sampling);
  const sourceOrgId = useForgeStore((s) => s.config?.sourceOrgId);
  const source = useOrgStore((s) =>
    orgDisplayName(
      s.orgs.find((o) => o.id === sourceOrgId),
      sourceOrgId,
    ),
  );
  if (!sampling) return null;
  const where =
    sampling.objectApiName !== undefined &&
    sampling.done !== undefined &&
    sampling.total !== undefined
      ? t('forgeRun.sampling.object', {
          object: sampling.objectApiName,
          done: n(sampling.done),
          total: n(sampling.total),
        })
      : undefined;
  const step = t(`forgeRun.sampling.step.${sampling.step}`);
  return (
    <div
      role="status"
      data-testid="forge-sampling"
      className="flex items-start gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary"
    >
      <Dices size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-hue-forge" />
      <div className="flex flex-col gap-0.5">
        <p data-testid="forge-sampling-step">
          {t(where ? 'forgeRun.sampling.atObject' : 'forgeRun.sampling.at', { step, where })}
        </p>
        <p data-testid="forge-sampling-counts" className="text-text-secondary">
          {t(
            sampling.pricedAt !== undefined
              ? 'forgeRun.sampling.countsPriced'
              : 'forgeRun.sampling.counts',
            {
              rows: n(sampling.rows),
              requests: n(sampling.requests),
              source,
              ...(sampling.pricedAt !== undefined ? { pricedAt: n(sampling.pricedAt) } : {}),
            },
          )}
        </p>
      </div>
    </div>
  );
};
