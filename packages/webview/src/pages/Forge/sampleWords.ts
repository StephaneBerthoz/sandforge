import type { TFunction } from 'i18next';
import { BYTES_PER_MB } from '@sandforge/shared';
import type { ForgeSampleDraw, WholeOrgSampleWholeReason } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';

/** A number in the interface language. */
export function sampleNumber(value: number): string {
  return value.toLocaleString(uiLocale());
}

/** Bytes as the MB the page says a sample's in, to a tenth. */
export function mbOf(bytes: number): string {
  return sampleNumber(Math.round((bytes / BYTES_PER_MB) * 10) / 10);
}

/**
 * A share of each object's roots, as a percentage the eye reads: two
 * significant digits under one per cent, one decimal under ten, whole above.
 * A sample of a large org keeps a fraction of a per cent of its roots, which
 * a rounded figure would say as none.
 */
export function percentOf(share: number): string {
  const percent = share * 100;
  const locale = uiLocale();
  if (percent <= 0) return (0).toLocaleString(locale);
  if (percent < 1) return percent.toLocaleString(locale, { maximumSignificantDigits: 2 });
  if (percent < 10) return percent.toLocaleString(locale, { maximumFractionDigits: 1 });
  return Math.round(percent).toLocaleString(locale);
}

/** Why a sample copies an object whole, in the interface language. */
export function wholeReasonWords(t: TFunction, why: WholeOrgSampleWholeReason): string {
  return t(`forgeRun.review.sample.why.${why}`);
}

/** How the roots of a sample were drawn, as a sentence says it within. */
export function drawWords(t: TFunction, draw: ForgeSampleDraw): string {
  return t(`forgeRun.wholeOrgDryRun.sample.draw.${draw}`);
}
