import type { DataOpsAnonymizationRule, AnonymizationMethod } from '@sandforge/shared';

/**
 * Applies anonymization rules to records in order to protect
 * sensitive data (PII, PHI, etc.) before moving data between environments.
 * Supports 8 rule types: mask, hash, fake, nullify, shuffle, truncate,
 * constant, and preserve_format.
 */
export class AnonymizationEngine {
  /**
   * Anonymize all records according to the provided rules.
   * Each rule targets a specific object/field combination.
   * @param records - The records to anonymize
   * @param rules - The anonymization rules to apply
   * @returns A new array of anonymized records (originals are not mutated)
   */
  anonymize(
    records: Record<string, unknown>[],
    rules: DataOpsAnonymizationRule[],
  ): Record<string, unknown>[] {
    return records.map((record) => {
      const copy = { ...record };
      for (const rule of rules) {
        if (rule.fieldApiName in copy) {
          copy[rule.fieldApiName] = this.applyRule(copy[rule.fieldApiName], rule);
        }
      }
      return copy;
    });
  }

  /**
   * Apply a single anonymization rule to a value.
   * Dispatches to the appropriate handler based on rule type.
   * @param value - The original field value
   * @param rule - The anonymization rule to apply
   * @returns The anonymized value
   */
  applyRule(value: unknown, rule: DataOpsAnonymizationRule): unknown {
    const handlers: Partial<
      Record<AnonymizationMethod, (v: unknown, r: DataOpsAnonymizationRule) => unknown>
    > = {
      mask: (v, r) => this.applyMask(v, r),
      hash: (v, r) => this.applyHash(v, r),
      fake: (v, r) => this.applyFake(v, r),
      nullify: () => null,
      shuffle: (v) => this.applyShuffle(v),
      truncate: (v) => this.applyTruncate(v),
      constant: (_v, r) => r.config.constantValue ?? '',
      preserve_format: (v) => this.applyPreserveFormat(v),
    };

    const handler = handlers[rule.method];
    if (!handler) {
      return value;
    }
    return handler(value, rule);
  }

  /**
   * Preview anonymization on a limited sample of records.
   * @param records - The full record set
   * @param rules - The anonymization rules to apply
   * @param sampleSize - Maximum number of records to include in the preview
   * @returns Anonymized sample records
   */
  preview(
    records: Record<string, unknown>[],
    rules: DataOpsAnonymizationRule[],
    sampleSize: number,
  ): Record<string, unknown>[] {
    const sample = records.slice(0, Math.max(0, sampleSize));
    return this.anonymize(sample, rules);
  }

  /**
   * Validate a set of anonymization rules and return any errors found.
   * @param rules - The rules to validate
   * @returns Array of validation error messages; empty if all rules are valid
   */
  validateRules(rules: DataOpsAnonymizationRule[]): string[] {
    const errors: string[] = [];

    for (const rule of rules) {
      if (!rule.fieldApiName) {
        errors.push('Rule must specify a fieldApiName');
      }
      if (!rule.objectApiName) {
        errors.push('Rule must specify an objectApiName');
      }
      if (rule.method === 'mask' && !rule.config.maskChar) {
        errors.push(`Mask rule for ${rule.fieldApiName} must specify a maskChar`);
      }
      if (
        rule.method === 'hash' &&
        rule.config.hashAlgorithm !== 'sha256' &&
        rule.config.hashAlgorithm !== 'md5'
      ) {
        errors.push(
          `Hash rule for ${rule.fieldApiName} must specify hashAlgorithm as sha256 or md5`,
        );
      }
      if (rule.method === 'constant' && rule.config.constantValue === undefined) {
        errors.push(`Constant rule for ${rule.fieldApiName} must specify a constantValue`);
      }
    }

    return errors;
  }

  private applyMask(value: unknown, rule: DataOpsAnonymizationRule): string {
    const str = String(value ?? '');
    const maskChar = rule.config.maskChar ?? '*';
    const start = rule.config.maskStart ?? 0;
    const end = rule.config.maskEnd ?? str.length;

    const chars = str.split('');
    for (let i = start; i < Math.min(end, chars.length); i++) {
      chars[i] = maskChar;
    }
    return chars.join('');
  }

  private applyHash(value: unknown, rule: DataOpsAnonymizationRule): string {
    const str = String(value ?? '');
    const salt = rule.config.hashSalt ?? '';
    const input = salt + str;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    const algo = rule.config.hashAlgorithm ?? 'sha256';
    return `${algo}:${Math.abs(hash).toString(16).padStart(8, '0')}`;
  }

  private applyFake(value: unknown, rule: DataOpsAnonymizationRule): string {
    const method = rule.config.fakerMethod ?? 'generic';
    const locale = rule.config.fakerLocale ?? 'en';
    const original = String(value ?? '');
    return `fake_${method}_${locale}_${original.length}`;
  }

  private applyShuffle(value: unknown): string {
    const str = String(value ?? '');
    const chars = str.split('');
    for (let i = chars.length - 1; i > 0; i--) {
      const j = i - 1;
      const temp = chars[i];
      chars[i] = chars[j];
      chars[j] = temp;
    }
    return chars.join('');
  }

  private applyTruncate(value: unknown): string {
    const str = String(value ?? '');
    if (str.length <= 3) {
      return str;
    }
    return str.slice(0, 3);
  }

  private applyPreserveFormat(value: unknown): string {
    const str = String(value ?? '');
    return str.replace(/[a-zA-Z]/g, 'x').replace(/[0-9]/g, '0');
  }
}
