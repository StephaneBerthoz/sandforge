import type { AnonymizationMethod } from '../types/common.types.js';

/**
 * The methods a masking template the user saves may give a rule: those a
 * DataOps run applies with no setting of its own.
 *
 * A DataOps run hands every rule an empty configuration. `hash` then throws,
 * since an unkeyed digest of an email or a phone number is reversed by
 * enumeration; `constant` writes an empty value and `truncate` keeps nothing,
 * which is not what either name says. Nothing on the page sets a salt, a value
 * or a length, so a saved template offers the five that need none.
 */
export const SAVED_TEMPLATE_METHODS = [
  'fake',
  'mask',
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
