import { z } from 'zod';

import type { AnonymizationMethod } from '../types/common.types.js';

/**
 * The methods a masking template the user saves may give a rule: every method
 * a DataOps run applies.
 *
 * Constant and Truncate were left out while a saved rule carried no setting:
 * without a value a constant writes an empty one, and without a length a
 * truncation keeps nothing, which is not what either name says. A saved rule
 * now carries those two settings ({@link SavedTemplateRuleConfig}), and a rule
 * of either method is refused without its own. The run gives `hash` its salt —
 * the key the window draws when it starts — so no template carries one.
 */
export const SAVED_TEMPLATE_METHODS = [
  'fake',
  'mask',
  'hash',
  'nullify',
  'shuffle',
  'preserve_format',
  'constant',
  'truncate',
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

/**
 * The longest value a saved Constant rule writes, and the most characters a
 * saved Truncate rule keeps: a Salesforce text field holds 255.
 */
export const TEMPLATE_SETTING_MAX = 255;

/**
 * What a saved rule's method needs that the template decides: the value a
 * Constant writes; how many characters a Truncate keeps, and from which end —
 * the last ones unless it says `first`, as the engine reads it.
 */
export interface SavedTemplateRuleConfig {
  constantValue?: string;
  truncateLength?: number;
  truncateKeep?: 'first' | 'last';
}

/** The settings each method takes: a setting of another method's is refused. */
const SETTINGS_TAKEN: Readonly<
  Record<SavedTemplateMethod, ReadonlyArray<keyof SavedTemplateRuleConfig>>
> = {
  fake: [],
  mask: [],
  hash: [],
  nullify: [],
  shuffle: [],
  preserve_format: [],
  constant: ['constantValue'],
  truncate: ['truncateLength', 'truncateKeep'],
};

/**
 * Why a saved rule would not do what its method says:
 * - `constantValueMissing`: a Constant with no value, or only spaces;
 * - `truncateLengthMissing`: a Truncate with no whole length from 1 to
 *   {@link TEMPLATE_SETTING_MAX};
 * - `settingNotTaken`: a setting the method does not read, left from another one.
 */
export type SavedRuleSettingProblem =
  'constantValueMissing' | 'truncateLengthMissing' | 'settingNotTaken';

/**
 * Why a saved rule's settings would not do what its method says, or
 * `undefined` when they do. The editor blocks Save on it, and the host refuses
 * a rule it names — both with this one reading.
 */
export function savedRuleSettingProblem(
  ruleType: SavedTemplateMethod,
  config: SavedTemplateRuleConfig | undefined,
): SavedRuleSettingProblem | undefined {
  const given = Object.entries(config ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (given.some((key) => !(SETTINGS_TAKEN[ruleType] as readonly string[]).includes(key))) {
    return 'settingNotTaken';
  }
  if (ruleType === 'constant') {
    const value = config?.constantValue;
    if (value === undefined || value.trim() === '' || value.length > TEMPLATE_SETTING_MAX) {
      return 'constantValueMissing';
    }
  }
  if (ruleType === 'truncate') {
    const length = config?.truncateLength;
    if (
      length === undefined ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > TEMPLATE_SETTING_MAX
    ) {
      return 'truncateLengthMissing';
    }
  }
  return undefined;
}

/** What the host says of a rule {@link savedRuleSettingProblem} names. */
const SETTING_PROBLEM_MESSAGES: Readonly<Record<SavedRuleSettingProblem, string>> = {
  constantValueMissing: `A Constant rule needs the value it writes, 1 to ${TEMPLATE_SETTING_MAX} characters`,
  truncateLengthMissing: `A Truncate rule needs how many characters it keeps, 1 to ${TEMPLATE_SETTING_MAX}`,
  settingNotTaken: 'The rule carries a setting its method does not take',
};

/**
 * One rule of a template the user saves: its `Object.Field`, its method, and
 * the settings that method needs. Shared by the save request the host
 * validates and the store it reads saved templates back through, so the two
 * cannot accept different rules.
 */
export const savedTemplateRuleSchema = z
  .object({
    fieldPattern: z.string().max(170).regex(TEMPLATE_FIELD_PATTERN, 'Expected Object.Field'),
    ruleType: z.enum(SAVED_TEMPLATE_METHODS),
    config: z
      .strictObject({
        constantValue: z.string().max(TEMPLATE_SETTING_MAX).optional(),
        truncateLength: z.number().int().min(1).max(TEMPLATE_SETTING_MAX).optional(),
        truncateKeep: z.enum(['first', 'last']).optional(),
      })
      .optional(),
  })
  .superRefine((rule, ctx) => {
    const problem = savedRuleSettingProblem(rule.ruleType, rule.config);
    if (problem !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: SETTING_PROBLEM_MESSAGES[problem],
      });
    }
  });
