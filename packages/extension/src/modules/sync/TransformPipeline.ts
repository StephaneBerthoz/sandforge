import type {
  TransformRule,
  TransformRuleType,
  TransformRuleConfig,
  SyncObjectConfig,
} from '@sandforge/shared';

/**
 * Applies transform rules in sequence to field values.
 * Supports all TransformRuleTypes: uppercase, lowercase, trim, truncate,
 * prefix, suffix, replace, regex_replace, map_value, default_value,
 * format_date, format_number, and custom_formula.
 */
export class TransformPipeline {
  /**
   * Apply a sequence of transform rules to a single value.
   * Rules are applied in order; the output of one rule becomes the input of the next.
   */
  transform(value: unknown, rules: TransformRule[]): unknown {
    let current = value;
    for (const rule of rules) {
      current = applyRule(current, rule.type, rule.config);
    }
    return current;
  }

  /**
   * Apply the transform rules of a SyncObjectConfig to a record. A rule that
   * names a field changes that field alone; one that names none — as a
   * configuration saved before rules named a field holds it — runs on every
   * field. Per-field transform rules defined in fieldMappings are applied to
   * their respective fields only.
   */
  transformRecord(
    record: Record<string, unknown>,
    objectConfig: SyncObjectConfig,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...record };

    // The field a write matches on is never changed, even by a rule that
    // names it: a prefix or a truncate on it would upsert new records under a
    // key the target has never seen, and the run would report every one of
    // them as written.
    const matchField = (objectConfig.externalIdField ?? 'Id').toLowerCase();
    const changeable = (key: string): boolean => {
      const name = key.toLowerCase();
      return name !== matchField && name !== 'id';
    };

    for (const rule of objectConfig.transformRules) {
      for (const key of keysOf(result, rule)) {
        if (!changeable(key)) continue;
        result[key] = applyRule(result[key], rule.type, rule.config);
      }
    }

    for (const mapping of objectConfig.fieldMappings) {
      if (mapping.transformRules && mapping.transformRules.length > 0) {
        const fieldKey = mapping.targetField;
        if (fieldKey in result) {
          let value = result[fieldKey];
          for (const rule of mapping.transformRules) {
            value = applyRule(value, rule.type, rule.config);
          }
          result[fieldKey] = value;
        }
      }
    }

    return result;
  }
}

/**
 * The keys of `record` a rule changes: the one its field names, matched as
 * Salesforce matches an API name, whatever its case, or every key when it
 * names none. A field the record does not carry is not added: an update would
 * write the rule's value over what the target holds there, and a real-time
 * change carries only the fields that changed.
 */
function keysOf(record: Record<string, unknown>, rule: TransformRule): string[] {
  if (rule.field === undefined) return Object.keys(record);
  const wanted = rule.field.toLowerCase();
  return Object.keys(record).filter((key) => key.toLowerCase() === wanted);
}

type RuleHandler = (value: unknown, config: TransformRuleConfig) => unknown;

/**
 * A rule that rewrites text. Any other value — an empty field (null), a
 * number, a checkbox — is left as it is: `String(value ?? '')` turned every
 * null into "", so an Uppercase or a Trim wrote an empty text into every field
 * the source had left empty, numbers, dates and lookups among them.
 */
function onText(rewrite: (text: string, config: TransformRuleConfig) => unknown): RuleHandler {
  return (value, config) => (typeof value === 'string' ? rewrite(value, config) : value);
}

/** A number, or a text that reads as one. An empty field is no number: it is not 0. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const num = Number(value);
  return Number.isNaN(num) ? undefined : num;
}

const RULE_HANDLERS: Record<TransformRuleType, RuleHandler> = {
  uppercase: onText((text) => text.toUpperCase()),

  lowercase: onText((text) => text.toLowerCase()),

  trim: onText((text) => text.trim()),

  truncate: onText((text, config) => text.slice(0, config.length ?? text.length)),

  prefix: onText((text, config) => `${config.prefix ?? ''}${text}`),

  suffix: onText((text, config) => `${text}${config.suffix ?? ''}`),

  // An empty search matches between every two characters: "Acme" with "-"
  // for nothing became "A-c-m-e". A rule with nothing to find changes nothing.
  replace: onText((text, config) =>
    config.search ? text.split(config.search).join(config.replace ?? '') : text,
  ),

  regex_replace: onText((text, config) =>
    config.regex ? text.replace(new RegExp(config.regex, 'g'), config.replace ?? '') : text,
  ),

  map_value: (value, config) => {
    const str = String(value ?? '');
    const map = config.valueMap ?? {};
    return str in map ? map[str] : value;
  },

  default_value: (value, config) => {
    if (value === null || value === undefined || value === '') {
      return config.defaultValue ?? '';
    }
    return value;
  },

  format_date: onText((text, config) => formatDate(text, config.dateFormat ?? 'YYYY-MM-DD')),

  format_number: (value, config) => {
    const num = numberOf(value);
    if (num === undefined) {
      return value;
    }
    const format = config.numberFormat ?? '0';
    return formatNumber(num, format);
  },

  custom_formula: (value, config) => {
    const formula = config.formula ?? '';
    return evaluateSimpleFormula(value, formula);
  },
};

/**
 * Apply a single transform rule to a value.
 */
function applyRule(value: unknown, type: TransformRuleType, config: TransformRuleConfig): unknown {
  const handler = RULE_HANDLERS[type];
  return handler(value, config);
}

/**
 * Format a date string according to a simple format pattern.
 * Supports YYYY, MM, DD tokens. The day is read in UTC, as Salesforce gives
 * a date (midnight UTC once parsed) and a date-time: read in the machine's
 * time zone, every date of a run started west of Greenwich was written the
 * day before.
 */
function formatDate(dateStr: string, format: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return dateStr;
  }

  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');

  return format.replace('YYYY', year).replace('MM', month).replace('DD', day);
}

/**
 * Format a number according to a simple format string.
 * The number of decimal places is determined by digits after the decimal in the format.
 */
function formatNumber(num: number, format: string): string {
  const decimalIndex = format.indexOf('.');
  if (decimalIndex === -1) {
    return Math.round(num).toString();
  }
  const decimals = format.length - decimalIndex - 1;
  return num.toFixed(decimals);
}

/**
 * Evaluate a simple formula expression.
 * Supports basic VALUE reference that refers to the current field value.
 * A formula it cannot evaluate leaves the value as read: it returned the
 * expression's text ("250*1.1+2"), which a number field refuses.
 */
function evaluateSimpleFormula(value: unknown, formula: string): unknown {
  if (formula.includes('VALUE')) {
    const numValue = numberOf(value);
    if (numValue !== undefined) {
      const expression = formula.replace(/VALUE/g, numValue.toString());
      return safeEvaluateArithmetic(expression) ?? value;
    }
  }
  return value;
}

/**
 * Safely evaluate a basic arithmetic expression (addition, subtraction, multiplication, division).
 * Returns undefined if the expression cannot be evaluated, a division by zero among them.
 */
function safeEvaluateArithmetic(expression: string): number | undefined {
  const cleaned = expression.replace(/\s/g, '');
  const match = /^(-?\d+(?:\.\d+)?)([-+*/])(-?\d+(?:\.\d+)?)$/.exec(cleaned);
  if (!match) {
    return undefined;
  }

  const left = Number(match[1]);
  const operator = match[2];
  const right = Number(match[3]);

  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? undefined : left / right;
    default:
      return undefined;
  }
}
