import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedObjectResult } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';

/**
 * How many of the object's records the run linked to one the platform wrote
 * itself, when it sent none and the org refused none: the contact roles of a
 * seed whose every role went to the one the platform wrote with its
 * opportunity. 0 for any other object.
 */
function linkedOnly(result: SeedObjectResult): number {
  if (result.recordsCreated > 0 || result.recordsFailed > 0) return 0;
  return result.writtenByThePlatform?.records ?? 0;
}

/**
 * Whether the run skipped the object before anything was sent for it: it
 * wrote and failed nothing, and its errors say why. The orchestrator reads a
 * skip the same way. An object whose records were all linked to the platform's
 * was not skipped, whatever note comes with them.
 */
export function wasSkipped(result: SeedObjectResult): boolean {
  return (
    result.recordsCreated === 0 &&
    result.recordsFailed === 0 &&
    result.errors.length > 0 &&
    linkedOnly(result) === 0
  );
}

/**
 * The contact roles of an object the run linked to the one the platform wrote
 * with their opportunity, which its counts leave out, with what the target
 * refused of the fields generated for them: the line of its card. Quick Seed's
 * and a scenario's cards said it in their badge alone. Nothing for an object
 * whose records the platform wrote none of.
 */
export const SeedWrittenByThePlatformLine: React.FC<{
  result: SeedObjectResult;
  testId: string;
}> = ({ result, testId }) => {
  const { t } = useTranslation();
  const written = result.writtenByThePlatform;
  if (!written) return null;
  return (
    <p className="text-[10px] text-(--sf-text-secondary)" data-testid={testId}>
      {t('seed.results.writtenByThePlatform', { count: written.records, given: written.given })}
      {written.refusal !== undefined && (
        <>
          {` ${t('seed.results.writtenByThePlatformRefused')} `}
          <span className="font-mono wrap-break-word">{written.refusal}</span>
        </>
      )}
    </p>
  );
};

/**
 * An object's count in a seed's results: created of sent, "Skipped" for an
 * object the run wrote nothing of, whose card says why, or how many it linked
 * to the records the platform wrote.
 *
 * A skipped object read "0/0" on a green badge, under a run called partial
 * for it: Knowledge articles on a new Developer Edition, which has no
 * Knowledge. An optional one is skipped in a neutral badge, the run not being
 * the worse for it. A role object whose every role was linked to the one the
 * platform wrote with its opportunity read the same green "0/0": it says
 * linked, as its card does, and warns as a refusal does when the target
 * refused some linked role the fields generated for it.
 */
export const SeedObjectBadge: React.FC<{ result: SeedObjectResult }> = ({ result }) => {
  const { t } = useTranslation();
  const linked = linkedOnly(result);
  if (linked > 0) {
    return (
      <Badge variant={result.writtenByThePlatform?.refusal !== undefined ? 'warning' : 'success'}>
        {t('seed.objectStatus.linked', { count: linked })}
      </Badge>
    );
  }
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
