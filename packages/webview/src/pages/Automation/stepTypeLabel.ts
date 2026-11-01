import type { TFunction } from 'i18next';

/**
 * The name of a step type in the reader's language, as the list under Steps
 * writes it. A type this page does not know — a pipeline saved by a later
 * release, or written by hand — stays as it was written.
 *
 * The canvas and the Step Configuration header printed the raw type id, so a
 * new Approval step read "approval approval" in every language while the list
 * beside it said "Approbation" or "Genehmigung".
 */
export function stepTypeLabel(type: string, t: TFunction): string {
  return t(`automation.stepTypes.${type}`, { defaultValue: type });
}

/**
 * The name a new step of `type` takes: its type in the reader's language, and
 * a number after it when a step of the pipeline already has that name —
 * "Delay", then "Delay 2", "Delay 3". A step was named after its raw type id,
 * and two steps of a type shared one name on the canvas and in History.
 */
export function newStepName(type: string, taken: readonly string[], t: TFunction): string {
  const label = stepTypeLabel(type, t);
  if (!taken.includes(label)) return label;
  let n = 2;
  while (taken.includes(`${label} ${n}`)) n += 1;
  return `${label} ${n}`;
}

/**
 * Whether `name` is the one a new step of that type was given, numbered or
 * not: the type's badge beside it would only say it again.
 */
export function isNewStepName(name: string, type: string, t: TFunction): boolean {
  const label = stepTypeLabel(type, t);
  return name === label || new RegExp(`^${escapeRegExp(label)} [1-9]\\d*$`).test(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
