/**
 * The Production Guard a command line hands the handlers it drives.
 *
 * Built with nobody to ask, the guard lets a run through that it would have
 * asked about: the backup and Frozen command lines did that, and a restore or
 * a load into a production org went ahead as if someone had said yes. Here the
 * guard's question gets an answer: no for a production org — said on the
 * command's output — and yes for any other, whose own question each command
 * already asks (`--yes`).
 */

import { ProductionGuard, type SafetyTier } from '../src/core/precheck/ProductionGuard.js';

/**
 * @param log - Where the command prints a line.
 * @param orgLabel - The alias the command writes to, as its user typed it.
 */
export function commandLineGuard(log: (line: string) => void, orgLabel: string): ProductionGuard {
  // Said by the answer, and by a preview that asks nothing of what it would be.
  const declines = (tier: SafetyTier): string | undefined =>
    tier === 'production'
      ? `${orgLabel} is taken for a production org, and this command writes to none`
      : undefined;
  return new ProductionGuard({
    requestConfirmation: (impactSummary: string, tier: SafetyTier): Promise<boolean> => {
      const why = declines(tier);
      if (why === undefined) return Promise.resolve(true);
      log(`refused: ${why} (${impactSummary})`);
      return Promise.resolve(false);
    },
    declinesWithoutAsking: declines,
  });
}
