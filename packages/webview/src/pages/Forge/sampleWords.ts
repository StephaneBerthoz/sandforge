import type { TFunction } from 'i18next';
import type { ForgeSampleDraw, WholeOrgSampleWholeReason } from '@sandforge/shared';

// The figures, from a module with no word of a page: the history says them too.
export { mbOf, percentOf, sampleNumber } from './sampleFigures';

/** Why a sample copies an object whole, in the interface language. */
export function wholeReasonWords(t: TFunction, why: WholeOrgSampleWholeReason): string {
  return t(`forgeRun.review.sample.why.${why}`);
}

/** How the roots of a sample were drawn, as a sentence says it within. */
export function drawWords(t: TFunction, draw: ForgeSampleDraw): string {
  return t(`forgeRun.wholeOrgDryRun.sample.draw.${draw}`);
}
