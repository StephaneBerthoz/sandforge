import type { AnonymizationMethod } from '../types/common.types.js';

/**
 * The methods a masking template the user saves may give a rule: those a
 * DataOps run applies with no setting of its own.
 *
 * A saved rule carries no setting: nothing on the page sets one. The run gives
 * `hash` its salt — the key the window draws when it starts — so hash needs
 * none from the template. `constant` and `truncate` do: without a value a
 * constant writes an empty one, and without a length a truncation keeps
 * nothing, which is not what either name says. Only the templates that ship
 * carry those, so a saved template offers the six that need nothing.
 */
export const SAVED_TEMPLATE_METHODS = [
  'fake',
  'mask',
  'hash',
  'nullify',
  'shuffle',
  'preserve_format',
] as const satisfies readonly AnonymizationMethod[];

/** A method a saved template's rule may use. */
export type SavedTemplateMethod = (typeof SAVED_TEMPLATE_METHODS)[number];

/** Whether a rule's method is one a saved template may use. */
export function isSavedTemplateMethod(method: string): method is SavedTemplateMethod {
  return (SAVED_TEMPLATE_METHODS as readonly string[]).includes(method);
}

/**
 * The field a rule masks, written `Object.Field` as the templates that ship
 * write it: the object before the dot, the field after, API names both.
 */
export const TEMPLATE_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;

/** The longest template name the host keeps. */
export const TEMPLATE_NAME_MAX_LENGTH = 80;

/** The most rules one saved template holds. */
export const TEMPLATE_MAX_RULES = 200;
