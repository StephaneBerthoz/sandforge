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
   * Apply all transform rules defined on a SyncObjectConfig to every field of a record.
   * Object-level transform rules are applied to all fields. Per-field transform rules
   * defined in fieldMappings are applied to their respective fields only.
   */
  transformRecord(
    record: Record<string, unknown>,
    objectConfig: SyncObjectConfig,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...record };

    for (const rule of objectConfig.transformRules) {
      for (const key of Object.keys(result)) {
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

type RuleHandler = (value: unknown, config: TransformRuleConfig) => unknown;

const RULE_HANDLERS: Record<TransformRuleType, RuleHandler> = {
  uppercase: (value) => String(value ?? '').toUpperCase(),

  lowercase: (value) => String(value ?? '').toLowerCase(),

  trim: (value) => String(value ?? '').trim(),

  truncate: (value, config) => {
    const str = String(value ?? '');
    const length = config.length ?? str.length;
    return str.slice(0, length);
  },

  prefix: (value, config) => `${config.prefix ?? ''}${String(value ?? '')}`,

  suffix: (value, config) => `${String(value ?? '')}${config.suffix ?? ''}`,

  replace: (value, config) => {
    const str = String(value ?? '');
    const search = config.search ?? '';
    const replacement = config.replace ?? '';
    return str.split(search).join(replacement);
  },

  regex_replace: (value, config) => {
    const str = String(value ?? '');
    const pattern = config.regex ?? '';
    const replacement = config.replace ?? '';
    const regex = new RegExp(pattern, 'g');
    return str.replace(regex, replacement);
  },

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

  format_date: (value, config) => {
    const dateStr = String(value ?? '');
    const format = config.dateFormat ?? 'YYYY-MM-DD';
    return formatDate(dateStr, format);
  },

  format_number: (value, config) => {
    const num = Number(value);
    if (isNaN(num)) {
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
 * Supports YYYY, MM, DD tokens.
 */
function formatDate(dateStr: string, format: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return dateStr;
  }

  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

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
 */
function evaluateSimpleFormula(value: unknown, formula: string): unknown {
  if (formula.includes('VALUE')) {
    const numValue = Number(value);
    if (!isNaN(numValue)) {
      const expression = formula.replace(/VALUE/g, numValue.toString());
      return safeEvaluateArithmetic(expression);
    }
  }
  return value;
}

/**
 * Safely evaluate a basic arithmetic expression (addition, subtraction, multiplication, division).
 * Returns the original string if the expression cannot be evaluated.
 */
function safeEvaluateArithmetic(expression: string): unknown {
  const cleaned = expression.replace(/\s/g, '');
  const match = /^(-?\d+(?:\.\d+)?)([-+*/])(-?\d+(?:\.\d+)?)$/.exec(cleaned);
  if (!match) {
    return expression;
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
      return right === 0 ? 0 : left / right;
    default:
      return expression;
  }
}
