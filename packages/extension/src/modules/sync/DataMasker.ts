/** Rule defining how a field should be masked */
export interface MaskRule {
  fieldName: string;
  strategy: 'hash' | 'fake' | 'nullify' | 'mask_partial' | 'constant';
  config?: {
    replacement?: string;
    visibleChars?: number;
  };
}

/**
 * Masks sensitive data during sync operations.
 * Supports multiple masking strategies: hash, fake, nullify, mask_partial, and constant.
 * Applies masking rules per-field to protect sensitive information in sandbox environments.
 */
export class DataMasker {
  /**
   * Apply masking rules to a set of records.
   * Each rule targets a specific field and applies the specified masking strategy.
   * Returns new records with masked values; original records are not modified.
   */
  mask(records: Record<string, unknown>[], rules: MaskRule[]): Record<string, unknown>[] {
    if (rules.length === 0) {
      return records.map((r) => ({ ...r }));
    }

    const ruleMap = new Map<string, MaskRule>();
    for (const rule of rules) {
      ruleMap.set(rule.fieldName, rule);
    }

    return records.map((record) => {
      const masked = { ...record };

      for (const [fieldName, rule] of ruleMap) {
        if (fieldName in masked) {
          masked[fieldName] = applyMask(masked[fieldName], rule);
        }
      }

      return masked;
    });
  }
}

/**
 * Apply a masking strategy to a single field value.
 */
function applyMask(value: unknown, rule: MaskRule): unknown {
  switch (rule.strategy) {
    case 'nullify':
      return null;

    case 'constant':
      return rule.config?.replacement ?? '***';

    case 'hash':
      return hashValue(value);

    case 'fake':
      return generateFakeValue(value);

    case 'mask_partial':
      return maskPartial(value, rule.config?.visibleChars ?? 0);
  }
}

/**
 * Create a deterministic hash-like string from a value.
 * Uses a simple FNV-1a-inspired hash for reproducibility without crypto deps.
 */
function hashValue(value: unknown): string {
  const str = String(value ?? '');
  let hash = 2166136261;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const unsigned = hash >>> 0;
  return unsigned.toString(16).padStart(8, '0');
}

/**
 * Generate a fake replacement value based on the original value's type and length.
 */
function generateFakeValue(value: unknown): unknown {
  if (typeof value === 'number') {
    return 0;
  }
  if (typeof value === 'boolean') {
    return false;
  }
  if (typeof value !== 'string') {
    return 'MASKED';
  }

  if (value.includes('@')) {
    return 'masked@example.com';
  }

  return 'X'.repeat(Math.min(value.length, 50));
}

/**
 * Mask a string value, leaving only the last N characters visible.
 */
function maskPartial(value: unknown, visibleChars: number): string {
  const str = String(value ?? '');
  if (str.length <= visibleChars) {
    return str;
  }

  const maskedLength = str.length - visibleChars;
  const masked = '*'.repeat(maskedLength);
  const visible = str.slice(maskedLength);
  return masked + visible;
}
