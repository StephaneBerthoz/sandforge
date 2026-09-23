import type { ConditionOperator, PipelineCondition } from '../types/automation.types.js';

/**
 * How a pipeline condition is read: what keeps one from being evaluated, and
 * its answer against a run's values.
 *
 * Shared by the extension, which evaluates conditions as a run goes, and the
 * Automation page, which says before Run is pressed whether a Condition step
 * can run. The page used to keep a list of its own, stricter than this one;
 * a list looser than this one would send pipelines only to have them refused.
 */

/** Every operator a condition can name; any other one has no answer to give. */
const OPERATORS: ReadonlySet<string> = new Set<ConditionOperator>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'matches',
  'is_empty',
  'is_not_empty',
]);

/** The operators that order two numbers. */
const ORDERING: ReadonlySet<string> = new Set<ConditionOperator>(['gt', 'gte', 'lt', 'lte']);

/** The operators that read no value: they only ask whether the field holds one. */
const PRESENCE: ReadonlySet<string> = new Set<ConditionOperator>(['is_empty', 'is_not_empty']);

/** Whether `value` is unset: absent, null, or empty text. */
function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * `value` as a number: a finite number, or text that spells one. Blank text is
 * not a number here, although `Number('')` is 0: read that way, a variable
 * nobody set was "less than 5".
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `value` as a boolean: true or false, or text that says one of them. */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

/** `value` as text; an unset value reads as empty text. */
function asText(value: unknown): string {
  return isUnset(value) ? '' : String(value);
}

/** Whether `pattern` compiles to a regular expression. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `actual` equals `expected`, compared the way `expected` is written: a
 * number as a number, true or false as a boolean, anything else as text. A
 * run's variables are all text, so the strict `===` this replaces never found
 * `'5'` equal to 5.
 */
function equals(actual: unknown, expected: PipelineCondition['value']): boolean {
  if (typeof expected === 'number') return asNumber(actual) === expected;
  if (typeof expected === 'boolean') return asBoolean(actual) === expected;
  return asText(actual) === String(expected);
}

/**
 * Order the field's value against the condition's, for one of the ordering
 * operators. A field that holds no number has no place in an order: saying it
 * is not greater than 80 would read as a real answer, so the condition is not
 * answered at all.
 */
function order(condition: PipelineCondition, actual: unknown): boolean {
  // conditionDefect has checked that the condition's value spells a number.
  const bound = Number(condition.value);
  const value = asNumber(actual);
  if (value === undefined) {
    throw new Error(
      isUnset(actual)
        ? `"${condition.field}" has no value to compare with ${bound}`
        : `"${condition.field}" is ${JSON.stringify(actual)}, not a number to compare with ${bound}`,
    );
  }
  if (condition.operator === 'gt') return value > bound;
  if (condition.operator === 'gte') return value >= bound;
  if (condition.operator === 'lt') return value < bound;
  return value <= bound;
}

/**
 * What keeps `condition` from being evaluated against any context, or
 * undefined when nothing does: no field to test, an operator no condition
 * knows, no value to compare with, a number comparison with a value that is
 * not a number, a pattern that does not compile. Each of those used to
 * evaluate to false, which reads as a real answer.
 *
 * The reason is written to follow the words "the condition".
 * @param condition - The condition to check
 */
export function conditionDefect(condition: PipelineCondition | undefined): string | undefined {
  if (!condition || typeof condition.field !== 'string' || condition.field.trim() === '') {
    return 'names no field to test';
  }
  const { field, operator, value } = condition;
  if (!OPERATORS.has(operator)) {
    return `uses an unknown operator: ${String(operator)}`;
  }
  if (PRESENCE.has(operator)) {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return `compares "${field}" with no value`;
  }
  if (ORDERING.has(operator) && asNumber(value) === undefined) {
    return `compares "${field}" with ${JSON.stringify(value)}, which is not a number`;
  }
  if (operator === 'matches' && !compiles(String(value))) {
    return `matches "${field}" against ${JSON.stringify(value)}, which is not a valid pattern`;
  }
  return undefined;
}

/**
 * Evaluate `condition` against `context`, a run's variables.
 *
 * Throws when the condition has no answer: it cannot be evaluated at all (see
 * {@link conditionDefect}), or an ordering operator meets a field that holds no
 * number. The error says why, for the step that asked.
 * @param condition - The condition to evaluate
 * @param context - Values by name; only the context's own keys are read
 * @returns true if the condition holds
 */
export function evaluateCondition(
  condition: PipelineCondition,
  context: Readonly<Record<string, unknown>>,
): boolean {
  const defect = conditionDefect(condition);
  if (defect !== undefined) {
    throw new Error(`the condition ${defect}`);
  }
  const actual = Object.hasOwn(context, condition.field) ? context[condition.field] : undefined;
  const expected = condition.value;

  switch (condition.operator) {
    case 'eq':
      return equals(actual, expected);
    case 'neq':
      return !equals(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return order(condition, actual);
    case 'contains':
      return asText(actual).includes(String(expected));
    case 'not_contains':
      return !asText(actual).includes(String(expected));
    case 'matches':
      return new RegExp(String(expected)).test(asText(actual));
    case 'is_empty':
      return isUnset(actual);
    case 'is_not_empty':
      return !isUnset(actual);
  }
}
