import { listWords } from './listWords';

/** What a masking run could not cover, as the host names it. */
export interface MaskingGaps {
  /** The fields its template names that their object's describe does not list. */
  fieldsNotFound: ReadonlyArray<{ objectApiName: string; fieldApiName: string }>;
  /** The objects with rows of which it could mask no field at all. */
  objectsNotCovered: readonly string[];
}

/** Translates a key in the interface language. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Why a masking run cannot cover what its template names, and what to do, in
 * the interface language: the fields the org does not show the user and what
 * hides them, with the objects of which no field is left; or, with no field to
 * name, the objects its rules mask nothing of. A refused run and the preview
 * before it say it in these words, so the two cannot come to differ.
 */
export function maskingGapWords(gaps: MaskingGaps, t: Translate): string {
  const objects = listWords(gaps.objectsNotCovered, t);
  if (gaps.fieldsNotFound.length === 0) return t('common.refusal.maskingMasksNothing', { objects });
  const fields = listWords(
    gaps.fieldsNotFound.map((f) => `${f.objectApiName}.${f.fieldApiName}`),
    t,
  );
  const said = t('common.refusal.maskingFieldsUnseen', { fields });
  return gaps.objectsNotCovered.length > 0
    ? `${said} ${t('common.refusal.maskingObjectNotCovered', { objects })}`
    : said;
}

/** What the host sent as what a run could not cover, or `undefined` when it is not that. */
function gapsOf(payload: Record<string, unknown>): MaskingGaps | undefined {
  const { fieldsNotFound, objectsNotCovered } = payload;
  if (!Array.isArray(fieldsNotFound) || !Array.isArray(objectsNotCovered)) return undefined;
  const fields = fieldsNotFound as unknown[];
  const objects = objectsNotCovered as unknown[];
  const named = fields.every(
    (f) =>
      typeof (f as { objectApiName?: unknown } | null)?.objectApiName === 'string' &&
      typeof (f as { fieldApiName?: unknown } | null)?.fieldApiName === 'string',
  );
  if (!named || !objects.every((o) => typeof o === 'string')) return undefined;
  if (fields.length === 0 && objects.length === 0) return undefined;
  return {
    fieldsNotFound: fields as MaskingGaps['fieldsNotFound'],
    objectsNotCovered: objects as string[],
  };
}

/**
 * A masking run refused because it would leave values it was asked to mask,
 * in the interface language, or `undefined` for any other refusal, or for one
 * that names nothing: the host's own words are then kept.
 *
 * In `common.refusal`, beside the guard's: every page waits on a request that
 * may answer one.
 */
export function maskingRefusalWords(
  code: string | null | undefined,
  payload: Record<string, unknown>,
  t: Translate,
): string | undefined {
  if (code !== 'MASKING_FIELDS_UNSEEN' && code !== 'MASKING_MASKS_NOTHING') return undefined;
  const gaps = gapsOf(payload);
  if (gaps === undefined) return undefined;
  return [maskingGapWords(gaps, t), t('common.refusal.maskingNothingMasked')].join(' ');
}
