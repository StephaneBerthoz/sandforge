import type { TransformRuleType } from '../types/sync.types.js';

/**
 * A Sync transform rule names the field it changes, and a rule that names
 * none is refused before a run reads or writes anything.
 *
 * Such a rule was kept running on every field of every record, as rules ran
 * before they named a field. A real run showed what that does: an Uppercase
 * with no field upper-cased the records' RecordTypeId with their names, and
 * the run held both accounts back as of a record type the target has not. It
 * rewrites ids, lookups, picklists and every text field alike, and no one
 * ever chose it: the page offered no field to pick until rules named one.
 */

/** The code a run is refused with when a rule of its configuration names no field. */
export const TRANSFORM_RULE_NO_FIELD = 'TRANSFORM_RULE_NO_FIELD';

/** A transform rule that names no field: the object it is on, and the rule. */
export interface FieldlessTransformRule {
  objectApiName: string;
  type: TransformRuleType;
}

/** What is read of an object of a configuration: its name and its object-level rules. */
interface ObjectWithRules {
  objectApiName: string;
  transformRules?: ReadonlyArray<{ type: TransformRuleType; field?: string }>;
}

/** The rules as the page names them in English, for the host's own words. */
const RULE_NAMES: Record<TransformRuleType, string> = {
  uppercase: 'Uppercase',
  lowercase: 'Lowercase',
  trim: 'Trim',
  truncate: 'Truncate',
  prefix: 'Prefix',
  suffix: 'Suffix',
  replace: 'Replace',
  regex_replace: 'Regex replace',
  map_value: 'Map value',
  default_value: 'Default value',
  format_date: 'Format date',
  format_number: 'Format number',
  custom_formula: 'Custom formula',
};

/** Whether a rule names the field it changes: a name, not an empty one. */
export function transformRuleNamesField(rule: { field?: string }): boolean {
  return typeof rule.field === 'string' && rule.field.trim() !== '';
}

/**
 * The object-level transform rules of `objects` that name no field, once per
 * object and rule: two Trims of Account without a field are one thing to fix.
 * The rules of a field mapping change that mapping's field, and are not read.
 */
export function fieldlessTransformRules(
  objects: readonly ObjectWithRules[],
): FieldlessTransformRule[] {
  const found: FieldlessTransformRule[] = [];
  for (const object of objects) {
    for (const rule of object.transformRules ?? []) {
      if (transformRuleNamesField(rule)) continue;
      const seen = found.some(
        (f) => f.objectApiName === object.objectApiName && f.type === rule.type,
      );
      if (!seen) found.push({ objectApiName: object.objectApiName, type: rule.type });
    }
  }
  return found;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Why a configuration with rules that name no field is refused, in English,
 * naming each rule and its object: "The rule Uppercase on Account names no
 * field: open the configuration and pick its field." The caller says what
 * was left undone, which only it knows.
 */
export function fieldlessTransformRefusal(rules: readonly FieldlessTransformRule[]): string {
  const named = listed(rules.map((r) => `${RULE_NAMES[r.type]} on ${r.objectApiName}`));
  return rules.length === 1
    ? `The rule ${named} names no field: open the configuration and pick its field. ` +
        'Without one it would change every field of every record, record types and ' +
        'lookups among them.'
    : `The rules ${named} name no field: open the configuration and pick their fields. ` +
        'Without one each would change every field of every record, record types and ' +
        'lookups among them.';
}

/**
 * The code a run is refused with when a Regex replace rule of its
 * configuration has a pattern that is no regular expression.
 */
export const TRANSFORM_RULE_BAD_PATTERN = 'TRANSFORM_RULE_BAD_PATTERN';

/** A Regex replace rule whose pattern is no regular expression: where it is, the pattern, and why. */
export interface UnreadablePatternRule {
  objectApiName: string;
  /** The field the rule changes: its own, or its field mapping's target. Absent when it names none. */
  field?: string;
  pattern: string;
  /** What JavaScript says of the pattern, without the pattern it repeats. */
  reason: string;
}

/** A rule as far as its pattern is read. */
interface RuleWithPattern {
  type: TransformRuleType;
  field?: string;
  config?: { regex?: string };
}

/** What is read of an object of a configuration: its name, its rules and its mappings' rules. */
interface ObjectWithPatterns {
  objectApiName: string;
  transformRules?: readonly RuleWithPattern[];
  fieldMappings?: ReadonlyArray<{
    targetField: string;
    transformRules?: readonly RuleWithPattern[];
  }>;
}

/**
 * Why `pattern` is no regular expression, or undefined when it is one, as a
 * Regex replace rule compiles it (every match replaced, `g`).
 */
function patternProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'g');
    return undefined;
  } catch (err: unknown) {
    const said = err instanceof Error ? err.message : String(err);
    // "Invalid regular expression: /[a-/g: Unterminated character class"
    return said.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '');
  }
}

/**
 * The Regex replace rules of `objects` whose pattern is no regular
 * expression, the object-level rules and those of its field mappings alike.
 * Run, such a rule threw JavaScript's own `SyntaxError` at the first record
 * that reached it, which stopped the run at that object with nothing of it
 * written and words naming neither the rule nor the object. A rule with no
 * pattern changes nothing, and is not one.
 */
export function unreadablePatternRules(
  objects: readonly ObjectWithPatterns[],
): UnreadablePatternRule[] {
  const found: UnreadablePatternRule[] = [];
  const check = (objectApiName: string, rule: RuleWithPattern, field: string | undefined): void => {
    const pattern = rule.config?.regex;
    if (rule.type !== 'regex_replace' || !pattern) return;
    const reason = patternProblem(pattern);
    if (reason === undefined) return;
    found.push({ objectApiName, ...(field ? { field } : {}), pattern, reason });
  };
  for (const object of objects) {
    for (const rule of object.transformRules ?? []) {
      check(object.objectApiName, rule, rule.field?.trim());
    }
    for (const mapping of object.fieldMappings ?? []) {
      for (const rule of mapping.transformRules ?? []) {
        check(object.objectApiName, rule, mapping.targetField);
      }
    }
  }
  return found;
}

/**
 * Why a configuration with such rules is refused, in English, naming each
 * rule, its object and field, and its pattern: `The rule Regex replace on
 * Account.Name, "[a-" (Unterminated character class) has a pattern that is no
 * regular expression`. The caller says what was left undone.
 */
export function unreadablePatternRefusal(rules: readonly UnreadablePatternRule[]): string {
  const named = listed(
    rules.map(
      (r) =>
        `${RULE_NAMES.regex_replace} on ${r.objectApiName}${r.field ? `.${r.field}` : ''}, ` +
        `"${r.pattern}" (${r.reason})`,
    ),
  );
  return rules.length === 1
    ? `The rule ${named} has a pattern that is no regular expression: open the ` +
        'configuration and correct it, or remove the rule. Run, it would stop the run at ' +
        'that object before any of its records is written.'
    : `The rules ${named} have patterns that are no regular expressions: open the ` +
        'configuration and correct them, or remove the rules. Run, each would stop the run ' +
        'at its object before any of its records is written.';
}
