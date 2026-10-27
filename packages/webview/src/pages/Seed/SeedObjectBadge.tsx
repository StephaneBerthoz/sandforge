import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedObjectResult } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';

/**
 * Whether the run skipped the object before anything was sent for it: it
 * wrote and failed nothing, and its errors say why. The orchestrator reads a
 * skip the same way.
 */
export function wasSkipped(result: SeedObjectResult): boolean {
  return result.recordsCreated === 0 && result.recordsFailed === 0 && result.errors.length > 0;
}

/**
 * An object's count in a seed's results: created of sent, or "Skipped" for an
 * object the run wrote nothing of, whose card says why.
 *
 * A skipped object read "0/0" on a green badge, under a run called partial
 * for it: Knowledge articles on a new Developer Edition, which has no
 * Knowledge. An optional one is skipped in a neutral badge, the run not being
 * the worse for it.
 */
export const SeedObjectBadge: React.FC<{ result: SeedObjectResult }> = ({ result }) => {
  const { t } = useTranslation();
  if (wasSkipped(result)) {
    return (
      <Badge variant={result.optional ? 'default' : 'warning'}>
        {t('seed.objectStatus.skipped')}
      </Badge>
    );
  }
  return (
    <Badge variant={result.recordsFailed > 0 ? 'warning' : 'success'}>
      {result.recordsCreated}/{result.recordsCreated + result.recordsFailed}
    </Badge>
  );
};
