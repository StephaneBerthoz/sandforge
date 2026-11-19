/**
 * What a storage gate counted off what the target says it has left, in the
 * interface language, as a refusal's figures carry it: what runs from this
 * machine wrote to it that Salesforce has not counted yet, and the half MB of
 * the rounding of `/limits` when that alone refused the records.
 *
 * A gate that read 5 MB left minutes after a run took 2 of them refused 3 MB
 * of records, and a refusal that said "3 MB, 5 MB left" read as a mistake:
 * the sentence says what was taken off. Nothing when the gate took nothing
 * off, or the payload is not the host's.
 */

import type { UncountedWrites } from '@sandforge/shared';

/** The minutes a run's writes are taken off what `/limits` says, at most, as the host keeps them. */
const UNCOUNTED_WINDOW_MINUTES = 10;

/** Whether a value is what the host sends of the writes it took off. */
function isUncounted(value: unknown): value is UncountedWrites {
  if (typeof value !== 'object' || value === null) return false;
  const { mb, runs, minutes } = value as Record<string, unknown>;
  return (
    typeof mb === 'number' &&
    mb > 0 &&
    typeof runs === 'number' &&
    runs >= 0 &&
    typeof minutes === 'number' &&
    minutes > 0
  );
}

/**
 * The sentences, each closed, to set after a refusal's own: none, one or
 * both.
 *
 * @param figures - The refusal's figures, as the page received them.
 * @param t - Translates a key in the interface language.
 * @param megabytes - Writes MB as the refusal writes them.
 */
export function storageCountedWords(
  figures: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
  megabytes: (mb: number) => string,
): string {
  if (typeof figures !== 'object' || figures === null) return '';
  const { uncountedWrites, uncountedMB, roundingMB } = figures as Record<string, unknown>;
  // A refusal carries the writes; a fit's budget, the MB it kept for them.
  const uncounted = isUncounted(uncountedWrites)
    ? uncountedWrites.mb
    : typeof uncountedMB === 'number' && uncountedMB > 0
      ? uncountedMB
      : undefined;
  const said = [
    ...(uncounted !== undefined
      ? [
          t('common.refusal.storageUncounted', {
            mb: megabytes(uncounted),
            window: UNCOUNTED_WINDOW_MINUTES,
          }),
        ]
      : []),
    ...(typeof roundingMB === 'number' && roundingMB > 0
      ? [t('common.refusal.storageRounding', { mb: megabytes(roundingMB) })]
      : []),
  ];
  return said.length > 0 ? ` ${said.join(' ')}` : '';
}
