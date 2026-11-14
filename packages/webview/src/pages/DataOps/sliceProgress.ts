/**
 * Where a masking run in slices is, read from the step its progress names:
 * the extension says it in English, `Backing up Contact slice 2 of about 4`
 * before a slice is masked, then `Anonymized Contact slice 2 of about 4
 * (412/1000)` as its rows are; a resumed slice may name no `of about`. The
 * page says it in the interface language, and a step of no slice as the
 * extension wrote it.
 */
export type SliceProgress =
  | { phase: 'backingUp'; object: string; index: number; about?: number }
  | {
      phase: 'masking';
      object: string;
      index: number;
      about?: number;
      done: number;
      total: number;
    };

const BACKING_UP = /^Backing up (\S+) slice (\d+)(?: of about (\d+))?$/;
const MASKING = /^Anonymized (\S+) slice (\d+)(?: of about (\d+))? \((\d+)\/(\d+)\)$/;

/** The slice and its phase a progress step names, or undefined for a step of no slice. */
export function sliceProgressOf(step: string | undefined): SliceProgress | undefined {
  if (step === undefined) return undefined;
  const backingUp = BACKING_UP.exec(step);
  if (backingUp) {
    return {
      phase: 'backingUp',
      object: backingUp[1],
      index: Number(backingUp[2]),
      ...(backingUp[3] !== undefined ? { about: Number(backingUp[3]) } : {}),
    };
  }
  const masking = MASKING.exec(step);
  if (masking) {
    return {
      phase: 'masking',
      object: masking[1],
      index: Number(masking[2]),
      ...(masking[3] !== undefined ? { about: Number(masking[3]) } : {}),
      done: Number(masking[4]),
      total: Number(masking[5]),
    };
  }
  return undefined;
}
